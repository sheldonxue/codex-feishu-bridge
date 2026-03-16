import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";

import {
  createBridgeEvent,
  createBridgeTask,
  type ApprovalState,
  type BridgeEvent,
  type BridgeTask,
  type ConversationMessage,
  type FeishuThreadBinding,
  type ImageAsset,
  type MessageAuthor,
  type QueuedApproval,
  type TaskDiffEntry,
  type TaskStatus,
} from "@codex-feishu-bridge/protocol";
import {
  ensureDir,
  readJsonFile,
  resolveWorkspacePath,
  type BridgeConfig,
  type Logger,
  writeJsonFile,
} from "@codex-feishu-bridge/shared";

import type {
  CodexAccountSnapshot,
  CodexApprovalDecision,
  CodexInputItem,
  CodexRateLimitSnapshot,
  CodexRuntime,
  CodexRuntimeNotification,
  CodexThreadDescriptor,
  CodexThreadItem,
  CodexTurnDescriptor,
} from "../runtime";

const SYSTEM_TASK_ID = "system";

interface PersistedState {
  seq: number;
  tasks: BridgeTask[];
}

export interface BridgeServiceSnapshot {
  seq: number;
  tasks: BridgeTask[];
  account: CodexAccountSnapshot | null;
  rateLimits: CodexRateLimitSnapshot | null;
}

export interface CreateTaskRequest {
  title: string;
  workspaceRoot?: string;
  prompt?: string;
  imageAssetIds?: string[];
}

export interface TaskMessageRequest {
  content: string;
  imageAssetIds?: string[];
}

export interface UploadImageRequest {
  fileName: string;
  mimeType: string;
  contentBase64: string;
}

export interface UploadImageResult {
  asset: ImageAsset;
  task: BridgeTask;
}

export interface BridgeServiceEvent {
  event: BridgeEvent;
  snapshot: BridgeServiceSnapshot;
}

function cloneTask(task: BridgeTask): BridgeTask {
  return structuredClone(task);
}

function cloneSnapshot(snapshot: BridgeServiceSnapshot): BridgeServiceSnapshot {
  return structuredClone(snapshot);
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function mapRuntimeStatus(status: unknown): TaskStatus {
  const value =
    typeof status === "string"
      ? status
      : status && typeof status === "object" && "type" in status
        ? String((status as { type?: string }).type ?? "idle")
        : "idle";

  switch (value) {
    case "queued":
      return "queued";
    case "running":
    case "inProgress":
      return "running";
    case "awaitingApproval":
    case "awaiting-approval":
      return "awaiting-approval";
    case "blocked":
      return "blocked";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "idle";
  }
}

function mapTurnStatus(status: CodexTurnDescriptor["status"]): TaskStatus {
  switch (status) {
    case "inProgress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "idle";
  }
}

function approvalStateFromDecision(decision: CodexApprovalDecision): ApprovalState {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return "accepted";
    case "decline":
      return "declined";
    case "cancel":
      return "cancelled";
    default:
      return "pending";
  }
}

function conversationContentFromInput(input: CodexInputItem[]): { content: string; imageAssetPaths: string[] } {
  const text = input
    .filter((item): item is Extract<CodexInputItem, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  const imageAssetPaths = input
    .filter((item): item is Extract<CodexInputItem, { type: "localImage" }> => item.type === "localImage")
    .map((item) => item.path);

  if (text) {
    return { content: text, imageAssetPaths };
  }

  return {
    content:
      imageAssetPaths.length === 1
        ? "[local image]"
        : imageAssetPaths.length > 1
          ? `[${imageAssetPaths.length} local images]`
          : "",
    imageAssetPaths,
  };
}

export class BridgeService {
  private readonly emitter = new EventEmitter();
  private readonly tasks = new Map<string, BridgeTask>();
  private readonly stateFile: string;
  private seq = 0;
  private account: CodexAccountSnapshot | null = null;
  private rateLimits: CodexRateLimitSnapshot | null = null;
  private unsubscribeRuntime: (() => void) | null = null;

  constructor(
    private readonly options: {
      config: BridgeConfig;
      logger: Logger;
      runtime: CodexRuntime;
    },
  ) {
    this.stateFile = path.join(options.config.stateDir, "tasks.json");
  }

  async initialize(): Promise<void> {
    const persisted = await readJsonFile<PersistedState>(this.stateFile, {
      seq: 0,
      tasks: [],
    });

    this.seq = persisted.seq;
    for (const task of persisted.tasks) {
      this.tasks.set(task.taskId, task);
    }

    this.unsubscribeRuntime = this.options.runtime.onNotification((notification) => {
      void this.handleRuntimeNotification(notification);
    });

    await this.refreshAccountState();
    this.emitEvent(SYSTEM_TASK_ID, "daemon.ready", {
      tasks: this.listTasks(),
    });
  }

  async dispose(): Promise<void> {
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
  }

  subscribe(listener: (payload: BridgeServiceEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  getSnapshot(): BridgeServiceSnapshot {
    return {
      seq: this.seq,
      tasks: this.listTasks(),
      account: this.account ? structuredClone(this.account) : null,
      rateLimits: this.rateLimits ? structuredClone(this.rateLimits) : null,
    };
  }

  listTasks(): BridgeTask[] {
    return [...this.tasks.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneTask);
  }

  getTask(taskId: string): BridgeTask | null {
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : null;
  }

  async createTask(request: CreateTaskRequest): Promise<BridgeTask> {
    const workspaceRoot = resolveWorkspacePath(
      this.options.config.workspaceRoot,
      request.workspaceRoot ?? this.options.config.workspaceRoot,
    );
    const descriptor = await this.options.runtime.startThread({
      cwd: workspaceRoot,
      title: request.title,
    });

    let task = this.upsertTaskFromDescriptor(descriptor, "bridge-managed");
    task.title = request.title || task.title;
    task.workspaceRoot = workspaceRoot;
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "task.created", { task: cloneTask(task) });

    if (request.prompt?.trim() || request.imageAssetIds?.length) {
      task = await this.sendMessage(task.taskId, {
        content: request.prompt ?? "",
        imageAssetIds: request.imageAssetIds,
      });
    }

    return task;
  }

  async resumeTask(taskId: string): Promise<BridgeTask> {
    const descriptor = await this.options.runtime.resumeThread(taskId);
    const task = this.upsertTaskFromDescriptor(descriptor, this.tasks.get(taskId)?.mode ?? "manual-import");
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "task.resumed", { task: cloneTask(task) });
    return cloneTask(task);
  }

  async importThreads(threadId?: string): Promise<BridgeTask[]> {
    const descriptors = threadId
      ? [await this.options.runtime.resumeThread(threadId)]
      : await this.options.runtime.listThreads();

    const imported: BridgeTask[] = [];
    for (const descriptor of descriptors) {
      const task = this.upsertTaskFromDescriptor(descriptor, this.tasks.get(descriptor.id)?.mode ?? "manual-import");
      this.touchTask(task);
      imported.push(cloneTask(task));
      this.emitEvent(task.taskId, "task.updated", {
        task: cloneTask(task),
        imported: true,
      });
    }

    await this.persistState();
    return imported;
  }

  async sendMessage(taskId: string, request: TaskMessageRequest): Promise<BridgeTask> {
    const task = this.requireTask(taskId);
    const input = this.buildInputItems(task, request);

    if (task.activeTurnId && task.status === "running") {
      await this.options.runtime.steerTurn({
        threadId: task.threadId,
        turnId: task.activeTurnId,
        input,
      });
      this.emitEvent(task.taskId, "task.steered", {
        taskId: task.taskId,
        turnId: task.activeTurnId,
      });
    } else {
      const turn = await this.options.runtime.startTurn({
        threadId: task.threadId,
        input,
      });
      task.activeTurnId = task.activeTurnId ?? turn.id;
      if (task.status === "idle" || task.status === "queued" || task.status === "completed") {
        task.status = "running";
      }
      this.touchTask(task);
      await this.persistState();
      this.emitEvent(task.taskId, "task.message.sent", {
        taskId: task.taskId,
        turnId: turn.id,
      });
    }

    return cloneTask(task);
  }

  async interruptTask(taskId: string): Promise<BridgeTask> {
    const task = this.requireTask(taskId);
    await this.options.runtime.interruptTurn({
      threadId: task.threadId,
      turnId: task.activeTurnId,
    });

    task.status = "interrupted";
    task.activeTurnId = undefined;
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "task.interrupted", { task: cloneTask(task) });
    return cloneTask(task);
  }

  async uploadTaskImage(taskId: string, request: UploadImageRequest): Promise<UploadImageResult> {
    const task = this.requireTask(taskId);
    const assetId = `asset_${randomUUID()}`;
    const taskUploadDir = path.join(this.options.config.uploadsDir, taskId);
    const fileName = `${assetId}-${sanitizeFileName(request.fileName)}`;
    const targetFile = path.join(taskUploadDir, fileName);

    await ensureDir(taskUploadDir);
    await writeFile(targetFile, Buffer.from(request.contentBase64, "base64"));

    const asset: ImageAsset = {
      assetId,
      localPath: targetFile,
      mimeType: request.mimeType,
      createdAt: new Date().toISOString(),
    };

    task.imageAssets = [...task.imageAssets, asset];
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "task.image.added", {
      taskId: task.taskId,
      asset,
    });

    return {
      asset,
      task: cloneTask(task),
    };
  }

  async bindFeishuThread(taskId: string, binding: FeishuThreadBinding): Promise<BridgeTask> {
    const task = this.requireTask(taskId);
    task.feishuBinding = binding;
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "feishu.thread.bound", {
      taskId,
      binding,
    });
    return cloneTask(task);
  }

  async resolveApproval(taskId: string, requestId: string, decision: CodexApprovalDecision): Promise<BridgeTask> {
    const task = this.requireTask(taskId);
    const approval = task.pendingApprovals.find((entry) => entry.requestId === requestId);
    if (!approval) {
      throw new Error(`Unknown approval request: ${requestId}`);
    }

    approval.state = approvalStateFromDecision(decision);
    approval.resolvedAt = new Date().toISOString();
    task.status = approval.state === "accepted" ? "running" : "blocked";
    this.touchTask(task);
    await this.persistState();
    await this.options.runtime.respondToRequest(requestId, decision);

    this.emitEvent(task.taskId, "approval.resolved", {
      taskId: task.taskId,
      approval: structuredClone(approval),
    });

    return cloneTask(task);
  }

  private buildInputItems(task: BridgeTask, request: TaskMessageRequest): CodexInputItem[] {
    const items: CodexInputItem[] = [];
    if (request.content.trim()) {
      items.push({
        type: "text",
        text: request.content.trim(),
      });
    }

    for (const assetId of request.imageAssetIds ?? []) {
      const asset = task.imageAssets.find((entry) => entry.assetId === assetId);
      if (!asset) {
        throw new Error(`Unknown image asset: ${assetId}`);
      }

      items.push({
        type: "localImage",
        path: asset.localPath,
      });
    }

    if (items.length === 0) {
      throw new Error("Message request must include text or image assets.");
    }

    return items;
  }

  private async handleRuntimeNotification(notification: CodexRuntimeNotification): Promise<void> {
    switch (notification.method) {
      case "auth.login.started":
        this.emitEvent(SYSTEM_TASK_ID, "auth.login.started", notification.params ?? {});
        return;
      case "account/login/completed":
        await this.refreshAccountState();
        this.emitEvent(SYSTEM_TASK_ID, "auth.login.completed", notification.params ?? {});
        return;
      case "account/updated":
        await this.refreshAccountState();
        this.emitEvent(SYSTEM_TASK_ID, "auth.account.updated", notification.params ?? {});
        return;
      case "thread/started": {
        const descriptor = (notification.params as { thread?: CodexThreadDescriptor }).thread;
        if (!descriptor) {
          return;
        }
        const task = this.upsertTaskFromDescriptor(descriptor, this.tasks.get(descriptor.id)?.mode ?? "manual-import");
        this.touchTask(task);
        await this.persistState();
        this.emitEvent(task.taskId, "task.updated", { task: cloneTask(task) });
        return;
      }
      case "thread/status/changed": {
        const params = notification.params as { threadId?: string; status?: unknown };
        if (!params.threadId) {
          return;
        }
        const task = this.tasks.get(params.threadId);
        if (!task) {
          return;
        }
        task.status = mapRuntimeStatus(params.status);
        this.touchTask(task);
        await this.persistState();
        this.emitEvent(task.taskId, "task.updated", {
          task: cloneTask(task),
          runtimeStatus: params.status ?? null,
        });
        return;
      }
      case "turn/started": {
        const turn = (notification.params as { turn?: CodexTurnDescriptor }).turn;
        if (!turn) {
          return;
        }
        const task = this.tasks.get(turn.threadId);
        if (!task) {
          return;
        }
        task.activeTurnId = turn.id;
        task.status = "running";
        this.touchTask(task);
        await this.persistState();
        this.emitEvent(task.taskId, "task.updated", {
          task: cloneTask(task),
          turn,
        });
        return;
      }
      case "turn/completed": {
        const turn = (notification.params as { turn?: CodexTurnDescriptor }).turn;
        if (!turn) {
          return;
        }
        const task = this.tasks.get(turn.threadId);
        if (!task) {
          return;
        }
        task.activeTurnId = undefined;
        task.status = mapTurnStatus(turn.status);
        if (turn.error?.message) {
          task.latestSummary = turn.error.message;
        }
        this.touchTask(task);
        await this.persistState();
        this.emitEvent(task.taskId, task.status === "failed" ? "task.failed" : "task.updated", {
          task: cloneTask(task),
          turn,
        });
        return;
      }
      case "turn/diff/updated": {
        const params = notification.params as { threadId?: string; turnId?: string; diff?: string };
        if (!params.threadId || !params.diff) {
          return;
        }
        const task = this.tasks.get(params.threadId);
        if (!task) {
          return;
        }
        task.diffs = [
          {
            path: "__aggregated_diff__",
            summary: params.turnId ? `Aggregated diff for ${params.turnId}` : "Aggregated diff",
            patch: params.diff,
          },
        ];
        this.touchTask(task);
        await this.persistState();
        this.emitEvent(task.taskId, "task.diff.updated", {
          taskId: task.taskId,
          diffs: structuredClone(task.diffs),
        });
        return;
      }
      case "item/completed":
      case "item/started": {
        const params = notification.params as {
          threadId?: string;
          turnId?: string;
          item?: CodexThreadItem;
        };
        if (!params.threadId || !params.item) {
          return;
        }
        const task = this.tasks.get(params.threadId);
        if (!task) {
          return;
        }
        this.applyItemToTask(task, params.item);
        this.touchTask(task);
        await this.persistState();
        this.emitEvent(task.taskId, "task.updated", {
          task: cloneTask(task),
          item: params.item,
        });
        return;
      }
      case "item/fileChange/requestApproval":
      case "item/commandExecution/requestApproval": {
        const params = notification.params as {
          requestId?: string | number;
          itemId?: string;
          threadId?: string;
          turnId?: string;
          reason?: string;
        };
        if (!params.threadId || params.requestId === undefined) {
          return;
        }
        const task = this.tasks.get(params.threadId);
        if (!task) {
          return;
        }

        const kind = notification.method.includes("fileChange") ? "file-change" : "command";
        const existing = task.pendingApprovals.find((entry) => entry.requestId === String(params.requestId));
        const approval: QueuedApproval =
          existing ??
          {
            requestId: String(params.requestId),
            taskId: task.taskId,
            turnId: params.turnId,
            kind,
            reason: params.reason ?? "Approval required",
            state: "pending",
            requestedAt: new Date().toISOString(),
          };

        if (!existing) {
          task.pendingApprovals = [...task.pendingApprovals, approval];
        }
        task.status = "awaiting-approval";
        this.touchTask(task);
        await this.persistState();
        this.emitEvent(task.taskId, "approval.requested", {
          taskId: task.taskId,
          approval: structuredClone(approval),
        });
        return;
      }
      case "serverRequest/resolved": {
        const params = notification.params as { threadId?: string; requestId?: string | number };
        if (!params.threadId || params.requestId === undefined) {
          return;
        }
        const task = this.tasks.get(params.threadId);
        if (!task) {
          return;
        }
        const approval = task.pendingApprovals.find((entry) => entry.requestId === String(params.requestId));
        if (approval && approval.state === "pending") {
          approval.state = "cancelled";
          approval.resolvedAt = new Date().toISOString();
        }
        this.touchTask(task);
        await this.persistState();
        this.emitEvent(task.taskId, "approval.resolved", {
          taskId: task.taskId,
          requestId: String(params.requestId),
        });
        return;
      }
      default:
        return;
    }
  }

  private applyItemToTask(task: BridgeTask, item: CodexThreadItem): void {
    switch (item.type) {
      case "userMessage": {
        const inputContent = "content" in item ? item.content : [];
        const { content, imageAssetPaths } = conversationContentFromInput(inputContent);
        this.upsertConversation(task, {
          messageId: item.id,
          author: "user",
          content,
          createdAt: new Date().toISOString(),
          imageAssetIds: task.imageAssets
            .filter((asset) => imageAssetPaths.includes(asset.localPath))
            .map((asset) => asset.assetId),
        });
        break;
      }
      case "agentMessage": {
        const text = "text" in item ? item.text : "";
        this.upsertConversation(task, {
          messageId: item.id,
          author: "agent",
          content: text,
          createdAt: new Date().toISOString(),
        });
        task.latestSummary = text || task.latestSummary;
        break;
      }
      case "fileChange": {
        const changes = "changes" in item ? item.changes : [];
        task.diffs = changes.map<TaskDiffEntry>((change: { path: string; kind: string; diff?: string }) => ({
          path: change.path,
          summary: change.kind,
          patch: change.diff,
        }));
        break;
      }
      case "enteredReviewMode":
        task.latestSummary = ("review" in item ? item.review?.summary : undefined) ?? "Review mode started.";
        break;
      case "exitedReviewMode":
        task.latestSummary = ("review" in item ? item.review?.summary : undefined) ?? "Review mode completed.";
        break;
      default:
        break;
    }
  }

  private upsertConversation(task: BridgeTask, message: ConversationMessage): void {
    const existingIndex = task.conversation.findIndex((entry) => entry.messageId === message.messageId);
    if (existingIndex >= 0) {
      task.conversation[existingIndex] = message;
      return;
    }

    task.conversation = [...task.conversation, message];
  }

  private upsertTaskFromDescriptor(descriptor: CodexThreadDescriptor, mode: BridgeTask["mode"]): BridgeTask {
    const existing = this.tasks.get(descriptor.id);
    if (existing) {
      existing.mode = mode;
      existing.title = descriptor.name ?? existing.title;
      existing.workspaceRoot = descriptor.cwd ?? existing.workspaceRoot;
      existing.status = mapRuntimeStatus(descriptor.status);
      this.touchTask(existing, descriptor.updatedAt);
      return existing;
    }

    const task = createBridgeTask({
      threadId: descriptor.id,
      title: descriptor.name ?? "Untitled task",
      workspaceRoot: descriptor.cwd ?? this.options.config.workspaceRoot,
      mode,
      createdAt: descriptor.updatedAt ?? new Date().toISOString(),
    });
    task.status = mapRuntimeStatus(descriptor.status);
    this.tasks.set(task.taskId, task);
    return task;
  }

  private async refreshAccountState(): Promise<void> {
    try {
      this.account = await this.options.runtime.readAccount(false);
      this.rateLimits = await this.options.runtime.readRateLimits();
    } catch (error) {
      this.options.logger.warn("failed to refresh account state", error);
    }
  }

  private requireTask(taskId: string): BridgeTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    return task;
  }

  private touchTask(task: BridgeTask, timestamp = new Date().toISOString()): void {
    task.updatedAt = timestamp;
  }

  private async persistState(): Promise<void> {
    await writeJsonFile(this.stateFile, {
      seq: this.seq,
      tasks: [...this.tasks.values()],
    } satisfies PersistedState);
  }

  private emitEvent(taskId: string, kind: BridgeEvent["kind"], payload: unknown): void {
    this.seq += 1;
    const event = createBridgeEvent(this.seq, taskId, kind, payload);
    void this.persistState();
    this.emitter.emit("event", {
      event,
      snapshot: cloneSnapshot(this.getSnapshot()),
    } satisfies BridgeServiceEvent);
  }
}
