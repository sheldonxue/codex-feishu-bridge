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
  type MessageSurface,
  type QueuedApproval,
  type TaskExecutionProfile,
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
  CodexModelDescriptor,
  CodexRateLimitSnapshot,
  CodexRuntime,
  CodexRuntimeNotification,
  CodexThreadDescriptor,
  CodexThreadItem,
  CodexTurnDescriptor,
} from "../runtime";

const SYSTEM_TASK_ID = "system";
const ACTIVE_TURN_START_TIMEOUT_MS = 8_000;
const ACTIVE_TURN_RETRY_INTERVAL_MS = 250;
const AGGREGATED_DIFF_PATH = "__aggregated_diff__";
const AGENT_DIFF_SUMMARY = "Extracted from agent diff block";

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
  executionProfile?: TaskExecutionProfile;
  source?: MessageSurface;
  replyToFeishu?: boolean;
}

export interface TaskMessageRequest {
  content: string;
  imageAssetIds?: string[];
  source?: MessageSurface;
  replyToFeishu?: boolean;
}

export interface TaskSettingsRequest {
  desktopReplySyncToFeishu?: boolean;
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

interface PendingTurnStart {
  promise: Promise<void>;
  resolve: () => void;
}

interface PendingConversationSource {
  surface: MessageSurface;
  replyToFeishu: boolean;
}

function normalizeExecutionProfile(profile: TaskExecutionProfile | undefined): TaskExecutionProfile {
  return {
    ...(profile?.model ? { model: profile.model } : {}),
    ...(profile?.effort ? { effort: profile.effort } : {}),
    ...(profile?.sandbox ? { sandbox: profile.sandbox } : {}),
    ...(profile?.approvalPolicy ? { approvalPolicy: profile.approvalPolicy } : {}),
  };
}

function hydratePersistedTask(task: BridgeTask): BridgeTask {
  const hydratedTask = structuredClone(task);
  hydratedTask.executionProfile = normalizeExecutionProfile(task.executionProfile);
  hydratedTask.desktopReplySyncToFeishu = task.desktopReplySyncToFeishu ?? Boolean(task.feishuBinding);
  hydratedTask.feishuBindingDisabled = task.feishuBindingDisabled ?? false;
  hydrateTaskDiffs(hydratedTask);
  return hydratedTask;
}

function cloneTask(task: BridgeTask): BridgeTask {
  const clonedTask = structuredClone(task);
  clonedTask.executionProfile = normalizeExecutionProfile(clonedTask.executionProfile);
  clonedTask.desktopReplySyncToFeishu = clonedTask.desktopReplySyncToFeishu ?? Boolean(clonedTask.feishuBinding);
  hydrateTaskDiffs(clonedTask);
  return clonedTask;
}

function cloneSnapshot(snapshot: BridgeServiceSnapshot): BridgeServiceSnapshot {
  return structuredClone(snapshot);
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function mapRuntimeStatus(status: unknown): TaskStatus {
  const normalizedStatus =
    status && typeof status === "object"
      ? (status as {
          type?: string;
          activeFlags?: string[];
        })
      : null;
  const value =
    typeof status === "string" ? status : normalizedStatus?.type ? String(normalizedStatus.type) : "idle";

  if (value === "active") {
    const activeFlags = normalizedStatus?.activeFlags ?? [];
    if (activeFlags.includes("waitingOnApproval")) {
      return "awaiting-approval";
    }
    if (activeFlags.includes("waitingOnUserInput")) {
      return "blocked";
    }
    return "running";
  }

  switch (value) {
    case "notLoaded":
      return "idle";
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
    case "systemError":
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

function shouldAutoImportRuntimeThread(status: TaskStatus): boolean {
  return status === "queued" || status === "running" || status === "awaiting-approval" || status === "blocked";
}

function runtimeStatusType(status: unknown): string {
  if (typeof status === "string") {
    return status;
  }

  if (status && typeof status === "object" && "type" in status) {
    const value = (status as { type?: unknown }).type;
    return typeof value === "string" ? value : "";
  }

  return "";
}

function isNotLoadedRuntimeThread(status: unknown): boolean {
  return runtimeStatusType(status) === "notLoaded";
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

function runtimeRequestIdFromTaskRequestId(requestId: string): number | string {
  return /^\d+$/.test(requestId) ? Number(requestId) : requestId;
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

function normalizeDiffHeaderPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/dev/null") {
    return undefined;
  }

  const withoutTimestamp = trimmed.split("\t")[0] ?? trimmed;
  if (withoutTimestamp.startsWith("a/") || withoutTimestamp.startsWith("b/")) {
    return withoutTimestamp.slice(2);
  }

  return withoutTimestamp;
}

function extractDiffPath(patch: string): string | undefined {
  let afterPath: string | undefined;
  let beforePath: string | undefined;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      afterPath = normalizeDiffHeaderPath(line.slice(4));
    }
    if (line.startsWith("--- ")) {
      beforePath = normalizeDiffHeaderPath(line.slice(4));
    }
  }

  return afterPath ?? beforePath;
}

function splitDiffSections(patch: string): string[] {
  const normalized = patch.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  let seenDiffHeader = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1] ?? "";
    const startsNewSection =
      line.startsWith("diff --git ") || (line.startsWith("--- ") && nextLine.startsWith("+++ "));

    if (startsNewSection && current.length > 0 && seenDiffHeader) {
      sections.push(current.join("\n").trimEnd());
      current = [];
      seenDiffHeader = false;
    }

    current.push(line);
    if (line.startsWith("--- ") && nextLine.startsWith("+++ ")) {
      seenDiffHeader = true;
    }
  }

  if (current.length > 0) {
    sections.push(current.join("\n").trimEnd());
  }

  return sections;
}

function extractTaskDiffsFromText(text: string): TaskDiffEntry[] {
  const entries: TaskDiffEntry[] = [];
  const blockPattern = /```diff\s*\n([\s\S]*?)```/g;

  for (const match of text.matchAll(blockPattern)) {
    const patch = (match[1] ?? "").trim();
    if (!patch) {
      continue;
    }

    const sections = splitDiffSections(patch);
    if (sections.length === 0) {
      continue;
    }

    for (const section of sections) {
      entries.push({
        path: extractDiffPath(section) ?? AGGREGATED_DIFF_PATH,
        summary: AGENT_DIFF_SUMMARY,
        patch: section,
      });
    }
  }

  return entries;
}

function canReplaceTaskDiffs(task: BridgeTask): boolean {
  return task.diffs.length === 0 || task.diffs.every((diff) => diff.path === AGGREGATED_DIFF_PATH);
}

function hydrateTaskDiffs(task: BridgeTask): void {
  if (!task.latestSummary || !canReplaceTaskDiffs(task)) {
    return;
  }

  const extractedDiffs = extractTaskDiffsFromText(task.latestSummary);
  if (extractedDiffs.length > 0) {
    task.diffs = extractedDiffs;
  }
}

export class BridgeService {
  private readonly emitter = new EventEmitter();
  private readonly tasks = new Map<string, BridgeTask>();
  private readonly pendingConversationSources = new Map<string, PendingConversationSource[]>();
  private readonly pendingTurnReplyPolicies = new Map<string, PendingConversationSource[]>();
  private readonly turnReplyPolicies = new Map<string, PendingConversationSource>();
  private readonly pendingTurnStarts = new Map<string, PendingTurnStart>();
  private readonly startedTurns = new Set<string>();
  private readonly stateFile: string;
  private seq = 0;
  private account: CodexAccountSnapshot | null = null;
  private rateLimits: CodexRateLimitSnapshot | null = null;
  private unsubscribeRuntime: (() => void) | null = null;
  private persistChain: Promise<void> = Promise.resolve();

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
      this.tasks.set(task.taskId, hydratePersistedTask(task));
    }

    this.unsubscribeRuntime = this.options.runtime.onNotification((notification) => {
      void this.handleRuntimeNotification(notification);
    });

    await this.reconcilePersistedTasks();
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

  async listModels(): Promise<CodexModelDescriptor[]> {
    return this.options.runtime.listModels();
  }

  async syncRuntimeThreads(): Promise<BridgeTask[]> {
    try {
      const runtimeThreads = await this.options.runtime.listThreads();
      const changed = this.applyRuntimeThreads(runtimeThreads, {
        importNewActiveOnly: true,
      });
      if (changed) {
        await this.persistState();
      }
    } catch (error) {
      this.options.logger.warn("failed to sync runtime threads", error);
    }

    return this.listTasks();
  }

  async importRecentRuntimeThreads(limit = 5): Promise<BridgeTask[]> {
    const normalizedLimit = Math.max(1, Math.min(50, Math.trunc(limit || 0) || 5));
    const runtimeThreads = await this.options.runtime.listThreads();
    const imported: BridgeTask[] = [];

    const candidates = runtimeThreads
      .filter((descriptor) => !this.tasks.has(descriptor.id))
      .filter((descriptor) => isNotLoadedRuntimeThread(descriptor.status))
      .sort((left, right) => {
        const leftTimestamp = left.updatedAt ?? left.createdAt ?? "";
        const rightTimestamp = right.updatedAt ?? right.createdAt ?? "";
        return rightTimestamp.localeCompare(leftTimestamp);
      })
      .slice(0, normalizedLimit);

    for (const descriptor of candidates) {
      const task = this.upsertTaskFromDescriptor(descriptor, "manual-import");
      this.touchTask(task, descriptor.updatedAt ?? descriptor.createdAt ?? task.updatedAt);
      imported.push(cloneTask(task));
      this.emitEvent(task.taskId, "task.updated", {
        task: cloneTask(task),
        imported: true,
        importedReason: "recent-host-thread",
      });
    }

    if (imported.length > 0) {
      await this.persistState();
    }

    return imported;
  }

  findTaskByFeishuBinding(chatId: string | undefined, lookupIds: string[]): BridgeTask | null {
    if (lookupIds.length === 0) {
      return null;
    }

    for (const task of this.tasks.values()) {
      if (!task.feishuBinding) {
        continue;
      }
      if (chatId && task.feishuBinding.chatId !== chatId) {
        continue;
      }
      if (
        lookupIds.some(
          (lookupId) =>
            lookupId === task.feishuBinding?.threadKey || lookupId === task.feishuBinding?.rootMessageId,
        )
      ) {
        return cloneTask(task);
      }
    }

    return null;
  }

  async createTask(request: CreateTaskRequest): Promise<BridgeTask> {
    const workspaceRoot = resolveWorkspacePath(
      this.options.config.workspaceRoot,
      request.workspaceRoot ?? this.options.config.workspaceRoot,
    );
    const descriptor = await this.options.runtime.startThread({
      cwd: workspaceRoot,
      title: request.title,
      model: request.executionProfile?.model,
      approvalPolicy: request.executionProfile?.approvalPolicy,
      sandbox: request.executionProfile?.sandbox,
    });

    let task = this.upsertTaskFromDescriptor(descriptor, "bridge-managed");
    task.title = request.title || task.title;
    task.workspaceRoot = workspaceRoot;
    task.executionProfile = normalizeExecutionProfile(request.executionProfile);
    task.desktopReplySyncToFeishu = request.replyToFeishu ?? task.desktopReplySyncToFeishu;
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "task.created", { task: cloneTask(task) });

    if (request.prompt?.trim() || request.imageAssetIds?.length) {
      task = await this.sendMessage(task.taskId, {
        content: request.prompt ?? "",
        imageAssetIds: request.imageAssetIds,
        source: request.source,
        replyToFeishu: request.replyToFeishu,
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
    const messageSource = request.source ?? "runtime";
    const replyToFeishu =
      request.replyToFeishu ??
      (messageSource === "feishu" ? true : task.feishuBinding ? task.desktopReplySyncToFeishu : false);
    this.enqueueConversationSource(task.taskId, {
      surface: messageSource,
      replyToFeishu,
    });

    if (task.activeTurnId && task.status === "running") {
      this.turnReplyPolicies.set(task.activeTurnId, {
        surface: messageSource,
        replyToFeishu,
      });
      await this.steerActiveTurn(task.threadId, task.activeTurnId, input);
      this.emitEvent(task.taskId, "task.steered", {
        taskId: task.taskId,
        turnId: task.activeTurnId,
      });
    } else {
      const pendingReplyPolicy = {
        surface: messageSource,
        replyToFeishu,
      } satisfies PendingConversationSource;
      this.enqueuePendingTurnReplyPolicy(task.taskId, pendingReplyPolicy);
      const turn = await this.options.runtime.startTurn({
        threadId: task.threadId,
        input,
        model: task.executionProfile.model,
        effort: task.executionProfile.effort,
        approvalPolicy: task.executionProfile.approvalPolicy,
      });
      this.trackPendingTurnStart(turn.id);
      this.turnReplyPolicies.set(turn.id, pendingReplyPolicy);
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
    if (!task.activeTurnId) {
      throw new Error(`Task ${taskId} has no active turn to interrupt.`);
    }
    await this.interruptActiveTurn(task.threadId, task.activeTurnId);
    this.clearTurnTracking(task.activeTurnId);
    this.turnReplyPolicies.delete(task.activeTurnId);

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
    task.feishuBindingDisabled = false;
    task.desktopReplySyncToFeishu = true;
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "feishu.thread.bound", {
      taskId,
      binding,
    });
    return cloneTask(task);
  }

  async unbindFeishuThread(taskId: string): Promise<BridgeTask> {
    const task = this.requireTask(taskId);
    delete task.feishuBinding;
    task.feishuBindingDisabled = true;
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "task.updated", {
      task: cloneTask(task),
      feishuUnbound: true,
    });
    return cloneTask(task);
  }

  async forgetTask(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    this.tasks.delete(taskId);
    this.pendingConversationSources.delete(taskId);
    this.pendingTurnReplyPolicies.delete(taskId);
    if (task.activeTurnId) {
      this.turnReplyPolicies.delete(task.activeTurnId);
      this.pendingTurnStarts.delete(task.activeTurnId);
      this.startedTurns.delete(task.activeTurnId);
    }
    await this.persistState();
    this.emitEvent(taskId, "task.updated", {
      taskId,
      forgotten: true,
    });
  }

  async updateTaskSettings(taskId: string, request: TaskSettingsRequest): Promise<BridgeTask> {
    const task = this.requireTask(taskId);
    if (typeof request.desktopReplySyncToFeishu === "boolean") {
      task.desktopReplySyncToFeishu = request.desktopReplySyncToFeishu;
    }
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "task.updated", {
      task: cloneTask(task),
      settingsUpdated: true,
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
    await this.options.runtime.respondToRequest(runtimeRequestIdFromTaskRequestId(requestId), {
      decision,
    });

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

  private enqueueConversationSource(taskId: string, source: PendingConversationSource): void {
    const queue = this.pendingConversationSources.get(taskId) ?? [];
    queue.push(source);
    this.pendingConversationSources.set(taskId, queue);
  }

  private dequeueConversationSource(taskId: string): PendingConversationSource | null {
    const queue = this.pendingConversationSources.get(taskId);
    if (!queue?.length) {
      return null;
    }

    const next = queue.shift() ?? null;
    if (!queue.length) {
      this.pendingConversationSources.delete(taskId);
    }
    return next;
  }

  private enqueuePendingTurnReplyPolicy(taskId: string, source: PendingConversationSource): void {
    const queue = this.pendingTurnReplyPolicies.get(taskId) ?? [];
    queue.push(source);
    this.pendingTurnReplyPolicies.set(taskId, queue);
  }

  private takePendingTurnReplyPolicy(taskId: string): PendingConversationSource | null {
    const queue = this.pendingTurnReplyPolicies.get(taskId);
    if (!queue?.length) {
      return null;
    }

    const next = queue.shift() ?? null;
    if (!queue.length) {
      this.pendingTurnReplyPolicies.delete(taskId);
    }
    return next;
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
        if (task.status !== "running") {
          if (task.activeTurnId) {
            this.turnReplyPolicies.delete(task.activeTurnId);
          }
          this.clearTurnTracking(task.activeTurnId);
        }
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
        if (!turn?.threadId) {
          return;
        }
        const task = this.tasks.get(turn.threadId);
        if (!task) {
          return;
        }
        if (!this.turnReplyPolicies.has(turn.id)) {
          const pendingReplyPolicy = this.takePendingTurnReplyPolicy(task.taskId);
          if (pendingReplyPolicy) {
            this.turnReplyPolicies.set(turn.id, pendingReplyPolicy);
          }
        }
        if (task.activeTurnId && task.activeTurnId !== turn.id) {
          this.turnReplyPolicies.delete(task.activeTurnId);
          this.clearTurnTracking(task.activeTurnId);
        }
        this.markTurnStarted(turn.id);
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
        if (!turn?.threadId) {
          return;
        }
        const task = this.tasks.get(turn.threadId);
        if (!task) {
          return;
        }
        this.turnReplyPolicies.delete(turn.id);
        this.clearTurnTracking(turn.id);
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
            path: AGGREGATED_DIFF_PATH,
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
        this.applyItemToTask(task, params.item, params.turnId);
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
        const runtimeRequestId = params.requestId ?? notification.requestId;
        if (!params.threadId || runtimeRequestId === undefined) {
          return;
        }
        const task = this.tasks.get(params.threadId);
        if (!task) {
          return;
        }

        const kind = notification.method.includes("fileChange") ? "file-change" : "command";
        const requestId = String(runtimeRequestId);
        const existing = task.pendingApprovals.find((entry) => entry.requestId === requestId);
        const approval: QueuedApproval =
          existing ??
          {
            requestId,
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
        const runtimeRequestId = params.requestId ?? notification.requestId;
        if (!params.threadId || runtimeRequestId === undefined) {
          return;
        }
        const task = this.tasks.get(params.threadId);
        if (!task) {
          return;
        }
        const requestId = String(runtimeRequestId);
        const approval = task.pendingApprovals.find((entry) => entry.requestId === requestId);
        if (approval && approval.state === "pending") {
          approval.state = "cancelled";
          approval.resolvedAt = new Date().toISOString();
        }
        this.touchTask(task);
        await this.persistState();
        this.emitEvent(task.taskId, "approval.resolved", {
          taskId: task.taskId,
          requestId,
        });
        return;
      }
      default:
        return;
    }
  }

  private applyItemToTask(task: BridgeTask, item: CodexThreadItem, turnId?: string): void {
    if (turnId && !this.turnReplyPolicies.has(turnId)) {
      const pendingReplyPolicy = this.takePendingTurnReplyPolicy(task.taskId);
      if (pendingReplyPolicy) {
        this.turnReplyPolicies.set(turnId, pendingReplyPolicy);
      }
    }

    switch (item.type) {
      case "userMessage": {
        const inputContent = "content" in item ? item.content : [];
        const { content, imageAssetPaths } = conversationContentFromInput(inputContent);
        const source = this.dequeueConversationSource(task.taskId)?.surface ?? "runtime";
        this.upsertConversation(task, {
          messageId: item.id,
          author: "user",
          surface: source,
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
        const replyPolicy = turnId ? this.turnReplyPolicies.get(turnId) : null;
        this.upsertConversation(task, {
          messageId: item.id,
          author: "agent",
          surface: replyPolicy?.replyToFeishu && task.feishuBinding ? "feishu" : replyPolicy?.surface ?? "runtime",
          content: text,
          createdAt: new Date().toISOString(),
        });
        task.latestSummary = text || task.latestSummary;
        hydrateTaskDiffs(task);
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
      existing.executionProfile = normalizeExecutionProfile(existing.executionProfile);
      this.touchTask(existing, descriptor.updatedAt);
      return existing;
    }

    const task = createBridgeTask({
      threadId: descriptor.id,
      title: descriptor.name ?? "Untitled task",
      workspaceRoot: descriptor.cwd ?? this.options.config.workspaceRoot,
      mode,
      createdAt: descriptor.updatedAt ?? new Date().toISOString(),
      executionProfile: {},
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

  private async reconcilePersistedTasks(): Promise<void> {
    try {
      const runtimeThreads = await this.options.runtime.listThreads();
      const changed = this.applyRuntimeThreads(runtimeThreads, {
        importNewActiveOnly: true,
      });
      if (changed) {
        await this.persistState();
      }
    } catch (error) {
      this.options.logger.warn("failed to reconcile persisted tasks", error);
    }
  }

  private applyRuntimeThreads(
    runtimeThreads: CodexThreadDescriptor[],
    options: {
      importNewActiveOnly: boolean;
    },
  ): boolean {
    const runtimeThreadsById = new Map(runtimeThreads.map((thread) => [thread.id, thread]));
    let changed = false;

    for (const task of this.tasks.values()) {
      const runtimeThread = runtimeThreadsById.get(task.threadId);
      if (!runtimeThread) {
        if (task.activeTurnId) {
          this.clearTurnTracking(task.activeTurnId);
          task.activeTurnId = undefined;
          changed = true;
        }
        changed = this.expirePendingApprovals(task) || changed;
        continue;
      }

      const nextTitle = runtimeThread.name ?? task.title;
      const nextWorkspaceRoot = runtimeThread.cwd ?? task.workspaceRoot;
      const nextStatus = mapRuntimeStatus(runtimeThread.status);
      const nextUpdatedAt = runtimeThread.updatedAt ?? task.updatedAt;

      if (task.title !== nextTitle) {
        task.title = nextTitle;
        changed = true;
      }
      if (task.workspaceRoot !== nextWorkspaceRoot) {
        task.workspaceRoot = nextWorkspaceRoot;
        changed = true;
      }
      if (task.status !== nextStatus) {
        task.status = nextStatus;
        changed = true;
      }
      if (task.updatedAt !== nextUpdatedAt) {
        changed = true;
      }
      if (nextStatus === "idle" || nextStatus === "completed" || nextStatus === "failed" || nextStatus === "interrupted") {
        if (task.activeTurnId) {
          this.clearTurnTracking(task.activeTurnId);
          task.activeTurnId = undefined;
          changed = true;
        }
        changed = this.expirePendingApprovals(task) || changed;
      }
      this.touchTask(task, nextUpdatedAt);
    }

    for (const descriptor of runtimeThreads) {
      if (this.tasks.has(descriptor.id)) {
        continue;
      }

      const runtimeStatus = mapRuntimeStatus(descriptor.status);
      if (options.importNewActiveOnly && !shouldAutoImportRuntimeThread(runtimeStatus)) {
        continue;
      }

      this.upsertTaskFromDescriptor(descriptor, "manual-import");
      changed = true;
    }

    return changed;
  }

  private expirePendingApprovals(task: BridgeTask): boolean {
    let changed = false;
    for (const approval of task.pendingApprovals) {
      if (approval.state !== "pending") {
        continue;
      }

      approval.state = "expired";
      approval.resolvedAt = new Date().toISOString();
      changed = true;
    }

    return changed;
  }

  private requireTask(taskId: string): BridgeTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    return task;
  }

  private trackPendingTurnStart(turnId: string): void {
    this.startedTurns.delete(turnId);
    if (this.pendingTurnStarts.has(turnId)) {
      return;
    }

    let resolve: (() => void) | undefined;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });

    this.pendingTurnStarts.set(turnId, {
      promise,
      resolve: resolve ?? (() => undefined),
    });
  }

  private markTurnStarted(turnId: string): void {
    this.startedTurns.add(turnId);
    const pending = this.pendingTurnStarts.get(turnId);
    if (!pending) {
      return;
    }

    pending.resolve();
    this.pendingTurnStarts.delete(turnId);
  }

  private clearTurnTracking(turnId: string | undefined): void {
    if (!turnId) {
      return;
    }

    this.startedTurns.delete(turnId);
    const pending = this.pendingTurnStarts.get(turnId);
    if (!pending) {
      return;
    }

    pending.resolve();
    this.pendingTurnStarts.delete(turnId);
  }

  private async steerActiveTurn(threadId: string, turnId: string, input: CodexInputItem[]): Promise<void> {
    const deadline = Date.now() + ACTIVE_TURN_START_TIMEOUT_MS;

    for (;;) {
      try {
        await this.options.runtime.steerTurn({
          threadId,
          turnId,
          input,
        });
        return;
      } catch (error) {
        if (!this.isTurnStillStartingError(error) || Date.now() >= deadline) {
          throw error;
        }

        await this.waitForTurnStartSignal(turnId, deadline - Date.now());
      }
    }
  }

  private isTurnStillStartingError(error: unknown): boolean {
    return error instanceof Error && error.message.includes("no active turn");
  }

  private async waitForTurnStartSignal(turnId: string, remainingMs: number): Promise<void> {
    if (this.startedTurns.has(turnId) || remainingMs <= 0) {
      return;
    }

    const pending = this.pendingTurnStarts.get(turnId);
    const delayMs = Math.min(ACTIVE_TURN_RETRY_INTERVAL_MS, remainingMs);

    await Promise.race([
      pending?.promise ?? Promise.resolve(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }),
    ]);
  }

  private async interruptActiveTurn(threadId: string, turnId: string): Promise<void> {
    const deadline = Date.now() + ACTIVE_TURN_START_TIMEOUT_MS;

    for (;;) {
      try {
        await this.options.runtime.interruptTurn({
          threadId,
          turnId,
        });
        return;
      } catch (error) {
        if (!this.isTurnStillStartingError(error) || Date.now() >= deadline) {
          throw error;
        }

        await this.waitForTurnStartSignal(turnId, deadline - Date.now());
      }
    }
  }

  private touchTask(task: BridgeTask, timestamp = new Date().toISOString()): void {
    task.updatedAt = timestamp;
  }

  private async persistState(): Promise<void> {
    const snapshot = {
      seq: this.seq,
      tasks: [...this.tasks.values()],
    } satisfies PersistedState;

    this.persistChain = this.persistChain.catch(() => undefined).then(() => writeJsonFile(this.stateFile, snapshot));
    await this.persistChain;
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
