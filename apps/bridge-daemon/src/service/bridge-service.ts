import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createReadStream, existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import {
  createBridgeEvent,
  createBridgeTask,
  type ApprovalPolicy,
  type ApprovalState,
  type BridgeEvent,
  type BridgeTask,
  type ConversationMessage,
  type FeishuRunningMessageMode,
  type FeishuThreadBinding,
  type MessageAuthor,
  type MessageSurface,
  type QueuedApproval,
  type SandboxMode,
  type TaskAsset,
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
const MIRRORED_ROLLOUT_DUPLICATE_WINDOW_MS = 50;
const SANDBOX_MODE_VALUES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
const APPROVAL_POLICY_VALUES: readonly ApprovalPolicy[] = ["untrusted", "on-failure", "on-request", "never"];

interface PersistedState {
  seq: number;
  tasks: BridgeTask[];
  queuedMessagesByTaskId?: Record<string, QueuedTaskMessage[]>;
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
  assetIds?: string[];
  imageAssetIds?: string[];
  executionProfile?: TaskExecutionProfile;
  source?: MessageSurface;
  replyToFeishu?: boolean;
}

export interface TaskMessageRequest {
  content: string;
  assetIds?: string[];
  imageAssetIds?: string[];
  executionProfile?: TaskExecutionProfile;
  source?: MessageSurface;
  replyToFeishu?: boolean;
}

export interface TaskSettingsRequest {
  desktopReplySyncToFeishu?: boolean;
  feishuRunningMessageMode?: FeishuRunningMessageMode;
  executionProfile?: TaskExecutionProfile;
}

export interface TaskRenameRequest {
  title: string;
  source?: MessageSurface;
}

export interface UploadAssetRequest {
  fileName: string;
  mimeType: string;
  contentBase64: string;
  kind?: TaskAsset["kind"];
}

export interface UploadAssetResult {
  asset: TaskAsset;
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
  content: string;
  assetIds: string[];
}

interface QueuedTaskMessage {
  surface: MessageSurface;
  replyToFeishu: boolean;
  content: string;
  assetIds: string[];
}

interface ImportedConversationRefreshResult {
  changed: boolean;
  appendedMessages: ConversationMessage[];
  latestMessageCreatedAt?: string;
}

interface RuntimeThreadUpdate {
  task: BridgeTask;
  imported?: boolean;
  importedReason?: string;
  importedConversationDelta?: ConversationMessage[];
}

interface RuntimeThreadApplyResult {
  changed: boolean;
  updates: RuntimeThreadUpdate[];
}

interface RolloutConversationSeed {
  author: MessageAuthor;
  surface: MessageSurface;
  content: string;
  createdAt: string;
}

interface RolloutConversationReadResult {
  messages: RolloutConversationSeed[];
  taskOrigin?: BridgeTask["taskOrigin"];
}

function isSandboxMode(value: string | undefined): value is SandboxMode {
  return typeof value === "string" && SANDBOX_MODE_VALUES.includes(value as SandboxMode);
}

function isApprovalPolicy(value: string | undefined): value is ApprovalPolicy {
  return typeof value === "string" && APPROVAL_POLICY_VALUES.includes(value as ApprovalPolicy);
}

function normalizeExecutionProfile(profile: TaskExecutionProfile | undefined): TaskExecutionProfile {
  return {
    ...(profile?.model ? { model: profile.model } : {}),
    ...(profile?.effort ? { effort: profile.effort } : {}),
    ...(profile?.sandbox ? { sandbox: profile.sandbox } : {}),
    ...(profile?.approvalPolicy ? { approvalPolicy: profile.approvalPolicy } : {}),
    ...(profile?.planMode ? { planMode: true } : {}),
  };
}

function normalizeTaskOrigin(
  taskOrigin: BridgeTask["taskOrigin"] | undefined,
  mode: BridgeTask["mode"],
): BridgeTask["taskOrigin"] {
  if (taskOrigin) {
    return taskOrigin;
  }

  return mode === "manual-import" ? "cli" : "runtime";
}

function normalizeFeishuRunningMessageMode(
  mode: BridgeTask["feishuRunningMessageMode"] | undefined,
): BridgeTask["feishuRunningMessageMode"] {
  return mode === "steer" ? "steer" : "queue";
}

function normalizeQueuedMessageCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

function normalizeTitleLocked(value: boolean | undefined): boolean {
  return value === true;
}

function taskOriginFromSource(
  source: MessageSurface | undefined,
  mode: BridgeTask["mode"],
): BridgeTask["taskOrigin"] {
  if (source === "feishu" || source === "vscode" || source === "runtime") {
    return source;
  }

  return normalizeTaskOrigin(undefined, mode);
}

function hydratePersistedTask(task: BridgeTask): BridgeTask {
  const hydratedTask = structuredClone(task);
  hydratedTask.assets = normalizeTaskAssets(hydratedTask);
  hydratedTask.taskOrigin = normalizeTaskOrigin(task.taskOrigin, task.mode);
  hydratedTask.titleLocked = normalizeTitleLocked(task.titleLocked);
  hydratedTask.executionProfile = normalizeExecutionProfile(task.executionProfile);
  hydratedTask.desktopReplySyncToFeishu = task.desktopReplySyncToFeishu ?? Boolean(task.feishuBinding);
  hydratedTask.feishuRunningMessageMode = normalizeFeishuRunningMessageMode(task.feishuRunningMessageMode);
  hydratedTask.queuedMessageCount = normalizeQueuedMessageCount(task.queuedMessageCount);
  hydratedTask.feishuBindingDisabled = task.feishuBindingDisabled ?? false;
  hydratedTask.conversation = hydratedTask.conversation.map(normalizeConversationMessage);
  hydrateTaskDiffs(hydratedTask);
  return hydratedTask;
}

function cloneTask(task: BridgeTask): BridgeTask {
  const clonedTask = structuredClone(task);
  clonedTask.assets = normalizeTaskAssets(clonedTask);
  clonedTask.taskOrigin = normalizeTaskOrigin(clonedTask.taskOrigin, clonedTask.mode);
  clonedTask.titleLocked = normalizeTitleLocked(clonedTask.titleLocked);
  clonedTask.executionProfile = normalizeExecutionProfile(clonedTask.executionProfile);
  clonedTask.desktopReplySyncToFeishu = clonedTask.desktopReplySyncToFeishu ?? Boolean(clonedTask.feishuBinding);
  clonedTask.feishuRunningMessageMode = normalizeFeishuRunningMessageMode(clonedTask.feishuRunningMessageMode);
  clonedTask.queuedMessageCount = normalizeQueuedMessageCount(clonedTask.queuedMessageCount);
  clonedTask.conversation = clonedTask.conversation.map(normalizeConversationMessage);
  hydrateTaskDiffs(clonedTask);
  return clonedTask;
}

function cloneSnapshot(snapshot: BridgeServiceSnapshot): BridgeServiceSnapshot {
  return structuredClone(snapshot);
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function assetKindFromMimeType(mimeType: string): TaskAsset["kind"] {
  return mimeType.startsWith("image/") ? "image" : "file";
}

function normalizeTaskAssets(task: BridgeTask): TaskAsset[] {
  const assets =
    task.assets ??
    (
      task as BridgeTask & {
        imageAssets?: Array<Partial<TaskAsset> & { assetId?: string; localPath?: string; mimeType?: string; createdAt?: string }>;
      }
    ).imageAssets ??
    [];

  return assets
    .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset?.assetId && asset.localPath && asset.mimeType && asset.createdAt))
    .map((asset) => ({
      assetId: asset.assetId,
      kind: asset.kind ?? assetKindFromMimeType(asset.mimeType),
      displayName: asset.displayName ?? path.basename(asset.localPath),
      localPath: asset.localPath,
      mimeType: asset.mimeType,
      createdAt: asset.createdAt,
    }));
}

function normalizeConversationMessage(message: ConversationMessage): ConversationMessage {
  const legacyAssetIds = (message as ConversationMessage & { imageAssetIds?: string[] }).imageAssetIds;
  return {
    ...message,
    assetIds: message.assetIds ?? legacyAssetIds ?? [],
  };
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

function isTaskBusyForQueuedFeishuMessage(task: Pick<BridgeTask, "status" | "activeTurnId">): boolean {
  return (
    Boolean(task.activeTurnId) ||
    task.status === "queued" ||
    task.status === "running" ||
    task.status === "awaiting-approval" ||
    task.status === "blocked"
  );
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

function formatAssetOnlyMessage(assets: TaskAsset[]): string {
  if (assets.length === 0) {
    return "";
  }

  if (assets.length === 1) {
    const [asset] = assets;
    return asset.kind === "image" ? "[image attachment]" : "[file attachment]";
  }

  const imageCount = assets.filter((asset) => asset.kind === "image").length;
  const fileCount = assets.length - imageCount;
  const parts: string[] = [];
  if (imageCount > 0) {
    parts.push(`${imageCount} image${imageCount === 1 ? "" : "s"}`);
  }
  if (fileCount > 0) {
    parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
  }
  return `[${parts.join(", ")} attached]`;
}

function buildAttachedFilesPrompt(files: TaskAsset[]): string {
  if (files.length === 0) {
    return "";
  }

  return [
    "Attached local file paths:",
    ...files.map((asset) => `- ${asset.displayName}: ${asset.localPath}`),
    "Read the files from disk if you need their contents.",
  ].join("\n");
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

function fallbackConversationContent(imageCount: number): string {
  if (imageCount <= 0) {
    return "";
  }

  return imageCount === 1 ? "[local image]" : `[${imageCount} local images]`;
}

function normalizeRolloutSurface(value: unknown, originator: unknown): MessageSurface | undefined {
  const direct = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (direct === "vscode" || direct === "feishu") {
    return direct;
  }

  const normalizedOriginator = typeof originator === "string" ? originator.trim().toLowerCase() : "";
  if (normalizedOriginator.includes("vscode")) {
    return "vscode";
  }
  if (normalizedOriginator.includes("feishu")) {
    return "feishu";
  }

  return undefined;
}

function rolloutTaskOriginFromSurface(surface: MessageSurface | undefined, mode: BridgeTask["mode"]): BridgeTask["taskOrigin"] {
  if (surface === "vscode" || surface === "feishu") {
    return surface;
  }

  return normalizeTaskOrigin(undefined, mode);
}

function messageTextFromResponseContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  const parts = content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      if ("text" in entry && typeof (entry as { text?: unknown }).text === "string") {
        return (entry as { text: string }).text.trim();
      }
      return "";
    })
    .filter(Boolean);

  return parts.join("\n").trim();
}

function prefersExistingConversationSurface(
  existing: ConversationMessage,
  next: ConversationMessage,
): boolean {
  return existing.author === next.author && existing.surface !== "runtime" && next.surface === "runtime";
}

function isMirroredRolloutMessagePair(
  previous: RolloutConversationSeed | undefined,
  next: RolloutConversationSeed,
): boolean {
  if (!previous) {
    return false;
  }

  const previousTimestamp = Date.parse(previous.createdAt);
  const nextTimestamp = Date.parse(next.createdAt);
  const timestampsMatch =
    Number.isFinite(previousTimestamp) &&
    Number.isFinite(nextTimestamp) &&
    Math.abs(previousTimestamp - nextTimestamp) <= MIRRORED_ROLLOUT_DUPLICATE_WINDOW_MS;

  return (
    previous.author === next.author &&
    previous.surface === next.surface &&
    previous.content === next.content &&
    (previous.createdAt === next.createdAt || timestampsMatch)
  );
}

function parseRolloutConversationSeed(line: string, defaultSurface = "runtime" as MessageSurface): {
  message: RolloutConversationSeed | null;
  sessionSurface?: MessageSurface;
} {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return { message: null };
  }

  if (!record || typeof record !== "object") {
    return { message: null };
  }

  const type = "type" in record ? (record as { type?: unknown }).type : undefined;
  if (type === "session_meta") {
    const payload = "payload" in record ? (record as { payload?: unknown }).payload : undefined;
    if (!payload || typeof payload !== "object") {
      return { message: null };
    }
    return {
      message: null,
      sessionSurface: normalizeRolloutSurface(
        "source" in payload ? (payload as { source?: unknown }).source : undefined,
        "originator" in payload ? (payload as { originator?: unknown }).originator : undefined,
      ),
    };
  }

  const timestamp =
    "timestamp" in record && typeof (record as { timestamp?: unknown }).timestamp === "string"
      ? (record as { timestamp: string }).timestamp
      : new Date().toISOString();
  if (type === "event_msg") {
    const payload = "payload" in record ? (record as { payload?: unknown }).payload : undefined;
    if (!payload || typeof payload !== "object") {
      return { message: null };
    }

    const payloadType = "type" in payload ? (payload as { type?: unknown }).type : undefined;
    if (payloadType === "user_message") {
      const message =
        "message" in payload && typeof (payload as { message?: unknown }).message === "string"
          ? (payload as { message: string }).message.trim()
          : "";
      const localImages =
        "local_images" in payload && Array.isArray((payload as { local_images?: unknown[] }).local_images)
          ? (payload as { local_images?: unknown[] }).local_images?.length ?? 0
          : 0;
      const content = message || fallbackConversationContent(localImages);
      return {
        message: content
          ? {
              author: "user",
              surface: defaultSurface,
              content,
              createdAt: timestamp,
            }
          : null,
      };
    }

    if (payloadType === "agent_message") {
      const message =
        "message" in payload && typeof (payload as { message?: unknown }).message === "string"
          ? (payload as { message: string }).message.trim()
          : "";
      return {
        message: message
          ? {
              author: "agent",
              surface: "runtime",
              content: message,
              createdAt: timestamp,
            }
          : null,
      };
    }

    return { message: null };
  }

  if (type !== "response_item") {
    return { message: null };
  }

  const payload = "payload" in record ? (record as { payload?: unknown }).payload : undefined;
  if (!payload || typeof payload !== "object") {
    return { message: null };
  }

  const payloadType = "type" in payload ? (payload as { type?: unknown }).type : undefined;
  if (payloadType !== "message") {
    return { message: null };
  }

  const role = "role" in payload ? (payload as { role?: unknown }).role : undefined;
  const text = messageTextFromResponseContent("content" in payload ? (payload as { content?: unknown }).content : undefined);
  if (!text) {
    return { message: null };
  }

  if (role === "user") {
    return {
      message: {
        author: "user",
        surface: defaultSurface,
        content: text,
        createdAt: timestamp,
      },
    };
  }

  if (role === "assistant") {
    return {
      message: {
        author: "agent",
        surface: "runtime",
        content: text,
        createdAt: timestamp,
      },
    };
  }

  return { message: null };
}

export class BridgeService {
  private static readonly DEFAULT_RUNTIME_SYNC_INTERVAL_MS = 5_000;
  private readonly emitter = new EventEmitter();
  private readonly tasks = new Map<string, BridgeTask>();
  private readonly pendingConversationSources = new Map<string, PendingConversationSource[]>();
  private readonly pendingTurnReplyPolicies = new Map<string, PendingConversationSource[]>();
  private readonly queuedMessages = new Map<string, QueuedTaskMessage[]>();
  private readonly turnReplyPolicies = new Map<string, PendingConversationSource>();
  private readonly pendingTurnStarts = new Map<string, PendingTurnStart>();
  private readonly startedTurns = new Set<string>();
  private readonly queuedMessageDrains = new Set<string>();
  private readonly stateFile: string;
  private seq = 0;
  private account: CodexAccountSnapshot | null = null;
  private rateLimits: CodexRateLimitSnapshot | null = null;
  private unsubscribeRuntime: (() => void) | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private runtimeSyncTimer: NodeJS.Timeout | null = null;
  private runtimeSyncInFlight = false;

  constructor(
    private readonly options: {
      config: BridgeConfig;
      logger: Logger;
      runtime: CodexRuntime;
      runtimeSyncIntervalMs?: number;
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
    for (const [taskId, queuedMessages] of Object.entries(persisted.queuedMessagesByTaskId ?? {})) {
      if (queuedMessages.length === 0) {
        continue;
      }
      const task = this.tasks.get(taskId);
      if (!task) {
        continue;
      }
      this.queuedMessages.set(taskId, queuedMessages.map((message) => ({
        surface: message.surface,
        replyToFeishu: message.replyToFeishu,
        content: message.content,
        assetIds: [...message.assetIds],
      })));
      task.queuedMessageCount = queuedMessages.length;
    }

    let restoredImportedExecutionProfiles = false;
    for (const task of this.tasks.values()) {
      restoredImportedExecutionProfiles =
        (await this.hydrateImportedTaskExecutionProfile(task)) || restoredImportedExecutionProfiles;
    }

    this.unsubscribeRuntime = this.options.runtime.onNotification((notification) => {
      void this.handleRuntimeNotification(notification);
    });

    await this.reconcilePersistedTasks();
    if (restoredImportedExecutionProfiles) {
      await this.persistState();
    }
    await this.refreshAccountState();
    await this.resumeQueuedMessagesAfterInitialize();
    this.startRuntimeSyncLoop();
    this.emitEvent(SYSTEM_TASK_ID, "daemon.ready", {
      tasks: this.listTasks(),
    });
  }

  async dispose(): Promise<void> {
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    if (this.runtimeSyncTimer) {
      clearInterval(this.runtimeSyncTimer);
      this.runtimeSyncTimer = null;
    }
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

  async readRuntimeHealth() {
    return this.options.runtime.health();
  }

  async syncRuntimeThreads(): Promise<BridgeTask[]> {
    try {
      const runtimeThreads = await this.options.runtime.listThreads();
      const result = await this.applyRuntimeThreads(runtimeThreads, {
        importNewActiveOnly: true,
      });
      if (result.changed) {
        await this.persistState();
        for (const update of result.updates) {
          this.emitEvent(update.task.taskId, "task.updated", {
            task: update.task,
            ...(update.imported ? { imported: true } : {}),
            ...(update.importedReason ? { importedReason: update.importedReason } : {}),
            ...(update.importedConversationDelta?.length
              ? { importedConversationDelta: structuredClone(update.importedConversationDelta) }
              : {}),
          });
        }
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
      await this.hydrateImportedTaskExecutionProfile(task);
      await this.hydrateImportedTaskConversation(task);
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
    if (request.title?.trim()) {
      task.title = request.title.trim();
      task.titleLocked = true;
    }
    task.workspaceRoot = workspaceRoot;
    task.taskOrigin = taskOriginFromSource(request.source, task.mode);
    task.executionProfile = normalizeExecutionProfile(request.executionProfile);
    task.desktopReplySyncToFeishu = request.replyToFeishu ?? task.desktopReplySyncToFeishu;
    task.feishuRunningMessageMode =
      request.source === "feishu" || request.replyToFeishu
        ? "queue"
        : normalizeFeishuRunningMessageMode(task.feishuRunningMessageMode);
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "task.created", { task: cloneTask(task) });

    const assetIds = request.assetIds ?? request.imageAssetIds ?? [];
    if (request.prompt?.trim() || assetIds.length) {
      task = await this.sendMessage(task.taskId, {
        content: request.prompt ?? "",
        assetIds,
        executionProfile: request.executionProfile,
        source: request.source,
        replyToFeishu: request.replyToFeishu,
      });
    }

    return task;
  }

  async resumeTask(taskId: string): Promise<BridgeTask> {
    const descriptor = await this.options.runtime.resumeThread(taskId);
    const task = this.upsertTaskFromDescriptor(descriptor, this.tasks.get(taskId)?.mode ?? "manual-import");
    await this.hydrateImportedTaskExecutionProfile(task);
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
      await this.hydrateImportedTaskExecutionProfile(task);
      await this.hydrateImportedTaskConversation(task);
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
    if (request.executionProfile) {
      task.executionProfile = normalizeExecutionProfile(request.executionProfile);
    }

    const input = this.buildInputItems(task, request);
    const messageSource = request.source ?? "runtime";
    const replyToFeishu =
      request.replyToFeishu ??
      (messageSource === "feishu" ? true : task.feishuBinding ? task.desktopReplySyncToFeishu : false);
    const assetIds = request.assetIds ?? request.imageAssetIds ?? [];
    const normalizedSource: PendingConversationSource = {
      surface: messageSource,
      replyToFeishu,
      content: request.content.trim(),
      assetIds,
    };

    if (messageSource === "feishu" && task.feishuRunningMessageMode === "queue" && isTaskBusyForQueuedFeishuMessage(task)) {
      await this.refreshTaskRuntimeStatus(task);
    }

    if (
      messageSource === "feishu" &&
      task.feishuRunningMessageMode === "queue" &&
      isTaskBusyForQueuedFeishuMessage(task)
    ) {
      this.enqueueQueuedMessage(task, normalizedSource);
      this.touchTask(task);
      await this.persistState();
      this.emitEvent(task.taskId, "task.message.queued", {
        task: cloneTask(task),
        queuedMessageCount: task.queuedMessageCount,
      });
      return cloneTask(task);
    }

    this.enqueueConversationSource(task.taskId, normalizedSource);

    if (task.activeTurnId && task.status === "running") {
      this.turnReplyPolicies.set(task.activeTurnId, normalizedSource);
      await this.steerActiveTurn(task.threadId, task.activeTurnId, input);
      this.emitEvent(task.taskId, "task.steered", {
        taskId: task.taskId,
        turnId: task.activeTurnId,
      });
    } else {
      const pendingReplyPolicy = {
        surface: messageSource,
        replyToFeishu,
        content: request.content.trim(),
        assetIds,
      } satisfies PendingConversationSource;
      this.enqueuePendingTurnReplyPolicy(task.taskId, pendingReplyPolicy);
      await this.resumeImportedTaskBeforeMessage(task);
      const turn = await this.options.runtime.startTurn({
        threadId: task.threadId,
        input,
        model: task.executionProfile.model,
        effort: task.executionProfile.effort,
        approvalPolicy: task.executionProfile.approvalPolicy,
        planMode: task.executionProfile.planMode,
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

  private async refreshTaskRuntimeStatus(task: BridgeTask): Promise<void> {
    try {
      const descriptor = await this.options.runtime.readThread(task.threadId);
      if (!descriptor) {
        return;
      }
      this.upsertTaskFromDescriptor(descriptor, task.mode);
    } catch (error) {
      this.options.logger.warn("failed to refresh task runtime status before feishu queue decision", {
        taskId: task.taskId,
        error,
      });
    }
  }

  private async resumeImportedTaskBeforeMessage(task: BridgeTask): Promise<void> {
    await this.hydrateImportedTaskExecutionProfile(task);
    if (task.mode !== "manual-import") {
      return;
    }

    const descriptor = await this.options.runtime.resumeThread(task.threadId);
    this.upsertTaskFromDescriptor(descriptor, task.mode);
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

  async uploadTaskAsset(taskId: string, request: UploadAssetRequest): Promise<UploadAssetResult> {
    const task = this.requireTask(taskId);
    const assetId = `asset_${randomUUID()}`;
    const taskUploadDir = path.join(this.options.config.uploadsDir, taskId);
    const fileName = `${assetId}-${sanitizeFileName(request.fileName)}`;
    const targetFile = path.join(taskUploadDir, fileName);

    await ensureDir(taskUploadDir);
    await writeFile(targetFile, Buffer.from(request.contentBase64, "base64"));

    const asset: TaskAsset = {
      assetId,
      kind: request.kind ?? assetKindFromMimeType(request.mimeType),
      displayName: request.fileName,
      localPath: targetFile,
      mimeType: request.mimeType,
      createdAt: new Date().toISOString(),
    };

    task.assets = [...normalizeTaskAssets(task), asset];
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "task.asset.added", {
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
    await this.hydrateImportedTaskExecutionProfile(task);
    task.feishuBinding = binding;
    task.feishuBindingDisabled = false;
    task.desktopReplySyncToFeishu = true;
    task.feishuRunningMessageMode = "queue";
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
    this.forgetTaskRecord(task);
    await this.persistState();
    this.emitEvent(taskId, "task.updated", {
      taskId,
      forgotten: true,
    });
  }

  async deleteLocalTask(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    if (task.feishuBinding) {
      throw new Error("Cannot permanently delete a Feishu-bound task from local storage.");
    }

    await this.deleteCodexThreadArtifacts(task.threadId);
    this.forgetTaskRecord(task);
    await this.persistState();
    this.emitEvent(taskId, "task.updated", {
      taskId,
      localDeleted: true,
    });
  }

  async forgetImportedTasks(): Promise<{ removedTaskIds: string[] }> {
    const removableTasks = [...this.tasks.values()].filter((task) => task.mode === "manual-import" && !task.feishuBinding);
    const removedTaskIds = removableTasks.map((task) => task.taskId);
    if (removedTaskIds.length === 0) {
      return { removedTaskIds };
    }

    for (const task of removableTasks) {
      this.forgetTaskRecord(task);
    }

    await this.persistState();
    this.emitEvent(SYSTEM_TASK_ID, "task.updated", {
      removedTaskIds,
      removedReason: "clear-imported-local-tasks",
    });
    return { removedTaskIds };
  }

  async updateTaskSettings(taskId: string, request: TaskSettingsRequest): Promise<BridgeTask> {
    const task = this.requireTask(taskId);
    if (typeof request.desktopReplySyncToFeishu === "boolean") {
      task.desktopReplySyncToFeishu = request.desktopReplySyncToFeishu;
    }
    if (request.feishuRunningMessageMode) {
      task.feishuRunningMessageMode = normalizeFeishuRunningMessageMode(request.feishuRunningMessageMode);
    }
    if (request.executionProfile) {
      task.executionProfile = normalizeExecutionProfile(request.executionProfile);
    }
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "task.updated", {
      task: cloneTask(task),
      settingsUpdated: true,
    });
    return cloneTask(task);
  }

  async renameTask(taskId: string, request: TaskRenameRequest): Promise<BridgeTask> {
    const task = this.requireTask(taskId);
    const nextTitle = request.title.trim();
    if (!nextTitle) {
      throw new Error("title is required");
    }
    if (task.title === nextTitle && task.titleLocked) {
      return cloneTask(task);
    }

    const previousTitle = task.title;
    task.title = nextTitle;
    task.titleLocked = true;
    this.touchTask(task);
    await this.persistState();
    this.emitEvent(task.taskId, "task.updated", {
      task: cloneTask(task),
      titleRenamed: true,
      previousTitle,
      nextTitle,
      renamedBy: request.source ?? "runtime",
    });
    return cloneTask(task);
  }

  async forceStartQueuedMessage(taskId: string): Promise<BridgeTask> {
    const task = this.requireTask(taskId);
    if (this.getQueuedMessageCount(taskId) === 0) {
      return cloneTask(task);
    }

    if (task.status === "awaiting-approval") {
      throw new Error("Task is waiting for approval. Resolve the approval before forcing the queued turn.");
    }

    if (task.status === "blocked") {
      throw new Error("Task is blocked on user input. Unblock the current turn before forcing the queued turn.");
    }

    if (task.activeTurnId && task.status === "running") {
      await this.interruptTask(taskId);
    } else if (task.activeTurnId) {
      throw new Error("Task still has an active turn. Wait for it to clear before forcing the queued turn.");
    }

    await this.processQueuedMessages(taskId);
    return cloneTask(this.requireTask(taskId));
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
    const assetIds = request.assetIds ?? request.imageAssetIds ?? [];
    const assets = assetIds.map((assetId) => {
      const asset = normalizeTaskAssets(task).find((entry) => entry.assetId === assetId);
      if (!asset) {
        throw new Error(`Unknown attachment asset: ${assetId}`);
      }
      return asset;
    });

    const images = assets.filter((asset) => asset.kind === "image");
    const files = assets.filter((asset) => asset.kind === "file");
    const filePrompt = buildAttachedFilesPrompt(files);
    const textParts = [request.content.trim(), filePrompt].filter(Boolean);

    if (textParts.length > 0) {
      items.push({
        type: "text",
        text: textParts.join("\n\n"),
      });
    }

    for (const asset of images) {
      items.push({
        type: "localImage",
        path: asset.localPath,
      });
    }

    if (items.length === 0) {
      throw new Error("Message request must include text, images, or files.");
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

  private enqueueQueuedMessage(task: BridgeTask, message: QueuedTaskMessage): void {
    const queue = this.queuedMessages.get(task.taskId) ?? [];
    queue.push({
      surface: message.surface,
      replyToFeishu: message.replyToFeishu,
      content: message.content,
      assetIds: [...message.assetIds],
    });
    this.queuedMessages.set(task.taskId, queue);
    task.queuedMessageCount = queue.length;
  }

  private dequeueQueuedMessage(task: BridgeTask): QueuedTaskMessage | null {
    const queue = this.queuedMessages.get(task.taskId);
    if (!queue?.length) {
      task.queuedMessageCount = 0;
      return null;
    }

    const next = queue.shift() ?? null;
    if (!queue.length) {
      this.queuedMessages.delete(task.taskId);
    }
    task.queuedMessageCount = queue.length;
    return next;
  }

  private requeueQueuedMessageFront(task: BridgeTask, message: QueuedTaskMessage): void {
    const queue = this.queuedMessages.get(task.taskId) ?? [];
    queue.unshift({
      surface: message.surface,
      replyToFeishu: message.replyToFeishu,
      content: message.content,
      assetIds: [...message.assetIds],
    });
    this.queuedMessages.set(task.taskId, queue);
    task.queuedMessageCount = queue.length;
  }

  private getQueuedMessageCount(taskId: string): number {
    return this.queuedMessages.get(taskId)?.length ?? 0;
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

  private async resumeQueuedMessagesAfterInitialize(): Promise<void> {
    const queuedTaskIds = [...this.queuedMessages.keys()];
    for (const taskId of queuedTaskIds) {
      await this.processQueuedMessages(taskId);
    }
  }

  private async processQueuedMessages(taskId: string): Promise<void> {
    if (this.queuedMessageDrains.has(taskId)) {
      return;
    }

    const task = this.tasks.get(taskId);
    if (!task || task.activeTurnId || task.status === "running" || task.status === "awaiting-approval" || task.status === "blocked") {
      return;
    }

    const nextQueuedMessage = this.dequeueQueuedMessage(task);
    if (!nextQueuedMessage) {
      return;
    }

    this.queuedMessageDrains.add(taskId);
    try {
      await this.persistState();
      await this.sendMessage(taskId, {
        content: nextQueuedMessage.content,
        assetIds: nextQueuedMessage.assetIds,
        source: nextQueuedMessage.surface,
        replyToFeishu: nextQueuedMessage.replyToFeishu,
      });
    } catch (error) {
      this.requeueQueuedMessageFront(task, nextQueuedMessage);
      await this.persistState();
      this.emitEvent(task.taskId, "task.updated", {
        task: cloneTask(task),
        queuedMessageStartFailed: true,
        queuedMessageError: error instanceof Error ? error.message : String(error),
      });
      this.options.logger.warn("failed to start queued task message", {
        taskId,
        error,
      });
    } finally {
      this.queuedMessageDrains.delete(taskId);
    }
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
        await this.processQueuedMessages(task.taskId);
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
        const source = this.dequeueConversationSource(task.taskId);
        const sourceAssets = (source?.assetIds ?? [])
          .map((assetId) => normalizeTaskAssets(task).find((asset) => asset.assetId === assetId))
          .filter((asset): asset is TaskAsset => Boolean(asset));
        this.upsertConversation(task, {
          messageId: item.id,
          author: "user",
          surface: source?.surface ?? "runtime",
          content:
            source?.content ||
            content ||
            formatAssetOnlyMessage(
              sourceAssets.length
                ? sourceAssets
                : normalizeTaskAssets(task).filter((asset) => imageAssetPaths.includes(asset.localPath)),
            ),
          createdAt: new Date().toISOString(),
          assetIds:
            source?.assetIds ??
            normalizeTaskAssets(task)
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
      const existing = task.conversation[existingIndex];
      task.conversation[existingIndex] = {
        ...message,
        createdAt: existing.createdAt,
        content: message.content || existing.content,
        assetIds: message.assetIds?.length ? message.assetIds : existing.assetIds,
        surface: prefersExistingConversationSurface(existing, message) ? existing.surface : message.surface,
      };
      return;
    }

    task.conversation = [...task.conversation, message];
  }

  private upsertTaskFromDescriptor(descriptor: CodexThreadDescriptor, mode: BridgeTask["mode"]): BridgeTask {
    const existing = this.tasks.get(descriptor.id);
    if (existing) {
      existing.mode = mode;
      existing.taskOrigin = normalizeTaskOrigin(existing.taskOrigin, mode);
      if (!existing.titleLocked && descriptor.name?.trim()) {
        existing.title = descriptor.name;
      }
      existing.workspaceRoot = descriptor.cwd ?? existing.workspaceRoot;
      existing.status = mapRuntimeStatus(descriptor.status);
      existing.executionProfile = normalizeExecutionProfile(existing.executionProfile);
      existing.feishuRunningMessageMode = normalizeFeishuRunningMessageMode(existing.feishuRunningMessageMode);
      existing.queuedMessageCount = this.getQueuedMessageCount(existing.taskId);
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
    task.queuedMessageCount = this.getQueuedMessageCount(task.taskId);
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
      const result = await this.applyRuntimeThreads(runtimeThreads, {
        importNewActiveOnly: true,
      });
      if (result.changed) {
        await this.persistState();
      }
    } catch (error) {
      this.options.logger.warn("failed to reconcile persisted tasks", error);
    }
  }

  private async applyRuntimeThreads(
    runtimeThreads: CodexThreadDescriptor[],
    options: {
      importNewActiveOnly: boolean;
    },
  ): Promise<RuntimeThreadApplyResult> {
    const runtimeThreadsById = new Map(runtimeThreads.map((thread) => [thread.id, thread]));
    let changed = false;
    const updates: RuntimeThreadUpdate[] = [];

    for (const task of this.tasks.values()) {
      const runtimeThread = runtimeThreadsById.get(task.threadId);
      let taskChanged = false;
      if (await this.hydrateImportedTaskExecutionProfile(task)) {
        changed = true;
        taskChanged = true;
      }
      if (!runtimeThread) {
        if (task.activeTurnId) {
          this.clearTurnTracking(task.activeTurnId);
          task.activeTurnId = undefined;
          changed = true;
          taskChanged = true;
        }
        if (this.expirePendingApprovals(task)) {
          changed = true;
          taskChanged = true;
        }
        if (taskChanged) {
          updates.push({ task: cloneTask(task) });
        }
        continue;
      }

      const nextTitle = runtimeThread.name ?? task.title;
      const nextWorkspaceRoot = runtimeThread.cwd ?? task.workspaceRoot;
      const nextStatus = mapRuntimeStatus(runtimeThread.status);
      const nextUpdatedAt = runtimeThread.updatedAt ?? task.updatedAt;
      let effectiveUpdatedAt = nextUpdatedAt;
      let importedConversationDelta: ConversationMessage[] = [];

      if (!task.titleLocked && task.title !== nextTitle) {
        task.title = nextTitle;
        changed = true;
        taskChanged = true;
      }
      if (task.workspaceRoot !== nextWorkspaceRoot) {
        task.workspaceRoot = nextWorkspaceRoot;
        changed = true;
        taskChanged = true;
      }
      if (task.status !== nextStatus) {
        task.status = nextStatus;
        changed = true;
        taskChanged = true;
      }
      const shouldRefreshImportedConversation =
        this.shouldRefreshImportedConversation(task, nextUpdatedAt);

      if (task.updatedAt !== nextUpdatedAt) {
        changed = true;
        taskChanged = true;
      }
      if (shouldRefreshImportedConversation) {
        const refreshResult = await this.refreshImportedTaskConversation(task);
        if (refreshResult.changed) {
          importedConversationDelta = refreshResult.appendedMessages;
          changed = true;
          taskChanged = true;
          if (task.updatedAt === nextUpdatedAt) {
            effectiveUpdatedAt = refreshResult.latestMessageCreatedAt ?? new Date().toISOString();
          }
        }
      }
      if (nextStatus === "idle" || nextStatus === "completed" || nextStatus === "failed" || nextStatus === "interrupted") {
        if (task.activeTurnId) {
          this.clearTurnTracking(task.activeTurnId);
          task.activeTurnId = undefined;
          changed = true;
          taskChanged = true;
        }
        if (this.expirePendingApprovals(task)) {
          changed = true;
          taskChanged = true;
        }
      }
      this.touchTask(task, effectiveUpdatedAt);
      if (taskChanged) {
        updates.push({
          task: cloneTask(task),
          ...(importedConversationDelta.length > 0
            ? { importedConversationDelta: structuredClone(importedConversationDelta) }
            : {}),
        });
      }
    }

    for (const descriptor of runtimeThreads) {
      if (this.tasks.has(descriptor.id)) {
        continue;
      }

      const runtimeStatus = mapRuntimeStatus(descriptor.status);
      if (options.importNewActiveOnly && !shouldAutoImportRuntimeThread(runtimeStatus)) {
        continue;
      }

      const task = this.upsertTaskFromDescriptor(descriptor, "manual-import");
      await this.hydrateImportedTaskExecutionProfile(task);
      changed = true;
      updates.push({
        task: cloneTask(task),
        imported: true,
        importedReason: "active-runtime-thread",
      });
    }

    return {
      changed,
      updates,
    };
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

  private forgetTaskRecord(task: BridgeTask): void {
    this.tasks.delete(task.taskId);
    this.pendingConversationSources.delete(task.taskId);
    this.pendingTurnReplyPolicies.delete(task.taskId);
    this.queuedMessages.delete(task.taskId);
    this.queuedMessageDrains.delete(task.taskId);
    if (task.activeTurnId) {
      this.turnReplyPolicies.delete(task.activeTurnId);
      this.pendingTurnStarts.delete(task.activeTurnId);
      this.startedTurns.delete(task.activeTurnId);
    }
  }

  private async deleteCodexThreadArtifacts(threadId: string): Promise<void> {
    const stateDbPath = path.join(this.options.config.codexHome, "state_5.sqlite");
    const logsDbPath = path.join(this.options.config.codexHome, "logs_1.sqlite");
    const rolloutPath = await this.deleteThreadFromStateDatabase(stateDbPath, threadId);
    await this.deleteThreadFromLogsDatabase(logsDbPath, threadId);
    if (rolloutPath) {
      await rm(rolloutPath, { force: true });
    }
  }

  private async hydrateImportedTaskConversation(task: BridgeTask): Promise<void> {
    if (task.mode !== "manual-import" || task.conversation.length > 0) {
      return;
    }

    await this.refreshImportedTaskConversation(task);
  }

  private async refreshImportedTaskConversation(task: BridgeTask): Promise<ImportedConversationRefreshResult> {
    if (!this.canRefreshImportedTaskConversation(task)) {
      return {
        changed: false,
        appendedMessages: [],
        latestMessageCreatedAt: undefined,
      };
    }

    try {
      const rolloutPath = await this.findThreadRolloutPath(task.threadId);
      if (!rolloutPath || !existsSync(rolloutPath)) {
        return {
          changed: false,
          appendedMessages: [],
          latestMessageCreatedAt: undefined,
        };
      }

      const { messages, taskOrigin } = await this.readConversationFromRollout(task, rolloutPath);
      if (taskOrigin && task.taskOrigin !== taskOrigin) {
        task.taskOrigin = taskOrigin;
      }
      if (messages.length === 0) {
        return {
          changed: false,
          appendedMessages: [],
          latestMessageCreatedAt: undefined,
        };
      }

      const nextConversation: ConversationMessage[] = messages.map((message, index) => ({
        messageId: `${task.threadId}:imported:${index}`,
        author: message.author,
        surface: message.surface,
        content: message.content,
        createdAt: message.createdAt,
      }));
      if (!this.hasImportedConversationChanged(task.conversation, nextConversation)) {
        return {
          changed: false,
          appendedMessages: [],
          latestMessageCreatedAt: nextConversation.at(-1)?.createdAt,
        };
      }

      const appendedMessages = this.appendedImportedConversationMessages(task.conversation, nextConversation);
      task.conversation = nextConversation;
      const latestAgentMessage = [...nextConversation].reverse().find((entry) => entry.author === "agent");
      if (latestAgentMessage) {
        task.latestSummary = latestAgentMessage.content;
        hydrateTaskDiffs(task);
      }
      return {
        changed: true,
        appendedMessages,
        latestMessageCreatedAt: nextConversation.at(-1)?.createdAt,
      };
    } catch (error) {
      this.options.logger.warn("failed to hydrate imported task conversation", {
        taskId: task.taskId,
        threadId: task.threadId,
        error,
      });
      return {
        changed: false,
        appendedMessages: [],
        latestMessageCreatedAt: undefined,
      };
    }
  }

  private appendedImportedConversationMessages(
    currentConversation: ConversationMessage[],
    nextConversation: ConversationMessage[],
  ): ConversationMessage[] {
    if (currentConversation.length === 0 || currentConversation.length >= nextConversation.length) {
      return [];
    }

    const hasStablePrefix = currentConversation.every((entry, index) => {
      const nextEntry = nextConversation[index];
      return (
        nextEntry !== undefined &&
        entry.messageId === nextEntry.messageId &&
        entry.author === nextEntry.author &&
        entry.surface === nextEntry.surface &&
        entry.content === nextEntry.content &&
        entry.createdAt === nextEntry.createdAt
      );
    });
    if (!hasStablePrefix) {
      return [];
    }

    return nextConversation.slice(currentConversation.length);
  }

  private canRefreshImportedTaskConversation(task: BridgeTask): boolean {
    if (task.mode !== "manual-import") {
      return false;
    }

    return this.usesImportedSyntheticConversation(task);
  }

  private shouldRefreshImportedConversation(task: BridgeTask, nextUpdatedAt: string): boolean {
    if (!this.canRefreshImportedTaskConversation(task)) {
      return false;
    }

    if (task.conversation.length === 0) {
      return true;
    }

    if (task.updatedAt !== nextUpdatedAt) {
      return true;
    }

    return Boolean(task.feishuBinding);
  }

  private usesImportedSyntheticConversation(task: BridgeTask): boolean {
    if (task.conversation.length === 0) {
      return true;
    }

    return task.conversation.every((entry) => entry.messageId.startsWith(`${task.threadId}:imported:`));
  }

  private hasImportedConversationChanged(
    currentConversation: ConversationMessage[],
    nextConversation: ConversationMessage[],
  ): boolean {
    if (currentConversation.length !== nextConversation.length) {
      return true;
    }

    return currentConversation.some((entry, index) => {
      const nextEntry = nextConversation[index];
      return !nextEntry ||
        entry.messageId !== nextEntry.messageId ||
        entry.author !== nextEntry.author ||
        entry.surface !== nextEntry.surface ||
        entry.content !== nextEntry.content ||
        entry.createdAt !== nextEntry.createdAt;
    });
  }

  private async readConversationFromRollout(
    task: Pick<BridgeTask, "mode" | "taskOrigin">,
    rolloutPath: string,
  ): Promise<RolloutConversationReadResult> {
    const messages: RolloutConversationSeed[] = [];
    let sessionSurface: MessageSurface | undefined;
    const stream = createReadStream(rolloutPath, { encoding: "utf8" });
    const lines = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of lines) {
        const parsed = parseRolloutConversationSeed(line, sessionSurface ?? "runtime");
        if (parsed.sessionSurface) {
          sessionSurface = parsed.sessionSurface;
        }
        const message = parsed.message;
        if (!message) {
          continue;
        }
        if (isMirroredRolloutMessagePair(messages.at(-1), message)) {
          continue;
        }
        messages.push(message);
      }
    } finally {
      lines.close();
      stream.close();
    }

    return {
      messages,
      taskOrigin: rolloutTaskOriginFromSurface(sessionSurface, task.mode),
    };
  }

  private async hydrateImportedTaskExecutionProfile(task: BridgeTask): Promise<boolean> {
    if (task.mode !== "manual-import") {
      return false;
    }

    const currentProfile = normalizeExecutionProfile(task.executionProfile);
    if (currentProfile.sandbox && currentProfile.approvalPolicy) {
      return false;
    }

    const restoredProfile = await this.readThreadExecutionProfileFromStateDatabase(task.threadId);
    const nextProfile = normalizeExecutionProfile({
      ...restoredProfile,
      ...currentProfile,
    });
    if (
      nextProfile.sandbox === currentProfile.sandbox &&
      nextProfile.approvalPolicy === currentProfile.approvalPolicy &&
      nextProfile.model === currentProfile.model &&
      nextProfile.effort === currentProfile.effort &&
      nextProfile.planMode === currentProfile.planMode
    ) {
      return false;
    }

    task.executionProfile = nextProfile;
    return true;
  }

  private async readThreadExecutionProfileFromStateDatabase(threadId: string): Promise<TaskExecutionProfile> {
    const stateDbPath = path.join(this.options.config.codexHome, "state_5.sqlite");
    if (!existsSync(stateDbPath)) {
      return {};
    }

    try {
      const raw = await this.runPythonSqliteScript(
        `
import json
import os
import sqlite3

db_path = os.environ["BRIDGE_SQLITE_DB_PATH"]
thread_id = os.environ["BRIDGE_SQLITE_THREAD_ID"]
conn = sqlite3.connect(db_path)
cur = conn.cursor()
result = {}
table = cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'").fetchone()
if table is not None:
    columns = [row[1] for row in cur.execute("PRAGMA table_info(threads)")]
    select_columns = []
    if "sandbox_policy" in columns:
        select_columns.append("sandbox_policy")
    if "approval_mode" in columns:
        select_columns.append("approval_mode")
    if select_columns:
        row = cur.execute(f"SELECT {', '.join(select_columns)} FROM threads WHERE id = ?", (thread_id,)).fetchone()
        if row:
            for index, column in enumerate(select_columns):
                if row[index]:
                    result[column] = row[index]
conn.close()
print(json.dumps(result))
        `,
        stateDbPath,
        threadId,
      );
      const parsed = JSON.parse(raw.trim() || "{}") as {
        sandbox_policy?: string;
        approval_mode?: string;
      };
      return normalizeExecutionProfile({
        ...(isSandboxMode(parsed.sandbox_policy) ? { sandbox: parsed.sandbox_policy } : {}),
        ...(isApprovalPolicy(parsed.approval_mode) ? { approvalPolicy: parsed.approval_mode } : {}),
      });
    } catch (error) {
      this.options.logger.warn("failed to restore imported task execution profile", {
        threadId,
        error,
      });
      return {};
    }
  }

  private async findThreadRolloutPath(threadId: string): Promise<string | null> {
    const stateDbPath = path.join(this.options.config.codexHome, "state_5.sqlite");
    if (!existsSync(stateDbPath)) {
      return null;
    }

    const rolloutPath = await this.runPythonSqliteScript(
      `
import os
import sqlite3

db_path = os.environ["BRIDGE_SQLITE_DB_PATH"]
thread_id = os.environ["BRIDGE_SQLITE_THREAD_ID"]
conn = sqlite3.connect(db_path)
cur = conn.cursor()
rollout_path = ""
table = cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'").fetchone()
if table is not None:
    columns = [row[1] for row in cur.execute("PRAGMA table_info(threads)")]
    if "rollout_path" in columns:
        row = cur.execute("SELECT rollout_path FROM threads WHERE id = ?", (thread_id,)).fetchone()
        if row and row[0]:
            rollout_path = row[0]
conn.close()
print(rollout_path)
      `,
      stateDbPath,
      threadId,
    );

    return this.resolveCodexArtifactPath(rolloutPath.trim() || null);
  }

  private async deleteThreadFromStateDatabase(stateDbPath: string, threadId: string): Promise<string | null> {
    if (!existsSync(stateDbPath)) {
      return null;
    }
    const rolloutPath = await this.runPythonSqliteScript(
      `
import os
import sqlite3

db_path = os.environ["BRIDGE_SQLITE_DB_PATH"]
thread_id = os.environ["BRIDGE_SQLITE_THREAD_ID"]
conn = sqlite3.connect(db_path)
cur = conn.cursor()

def table_exists(name):
    return cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None

def column_exists(table, column):
    return any(row[1] == column for row in cur.execute(f"PRAGMA table_info({table})"))

rollout_path = None

if table_exists("threads"):
    row = cur.execute("SELECT rollout_path FROM threads WHERE id = ?", (thread_id,)).fetchone()
    if row and row[0]:
        rollout_path = row[0]

if table_exists("agent_job_items") and column_exists("agent_job_items", "assigned_thread_id"):
    cur.execute("UPDATE agent_job_items SET assigned_thread_id = NULL WHERE assigned_thread_id = ?", (thread_id,))

for table in ("logs", "stage1_outputs", "thread_dynamic_tools"):
    if table_exists(table) and column_exists(table, "thread_id"):
        cur.execute(f"DELETE FROM {table} WHERE thread_id = ?", (thread_id,))

if table_exists("threads"):
    cur.execute("DELETE FROM threads WHERE id = ?", (thread_id,))

conn.commit()
conn.close()
print(rollout_path or "")
      `,
      stateDbPath,
      threadId,
    );

    return this.resolveCodexArtifactPath(rolloutPath.trim() || null);
  }

  private async deleteThreadFromLogsDatabase(logsDbPath: string, threadId: string): Promise<void> {
    if (!existsSync(logsDbPath)) {
      return;
    }
    await this.runPythonSqliteScript(
      `
import os
import sqlite3

db_path = os.environ["BRIDGE_SQLITE_DB_PATH"]
thread_id = os.environ["BRIDGE_SQLITE_THREAD_ID"]
conn = sqlite3.connect(db_path)
cur = conn.cursor()
table = cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='logs'").fetchone()
if table is not None:
    columns = [row[1] for row in cur.execute("PRAGMA table_info(logs)")]
    if "thread_id" in columns:
        cur.execute("DELETE FROM logs WHERE thread_id = ?", (thread_id,))
conn.commit()
conn.close()
      `,
      logsDbPath,
      threadId,
    );
  }

  private resolveCodexArtifactPath(targetPath: string | null): string | null {
    if (!targetPath) {
      return null;
    }

    const codexHomeRoot = path.resolve(this.options.config.codexHome);
    const hostCodexHome = process.env.HOST_CODEX_HOME?.trim() ? path.resolve(process.env.HOST_CODEX_HOME) : null;
    if (targetPath.startsWith("/codex-home/")) {
      return path.join(codexHomeRoot, targetPath.slice("/codex-home/".length));
    }

    if (path.isAbsolute(targetPath)) {
      const resolved = path.resolve(targetPath);
      if (resolved === codexHomeRoot || resolved.startsWith(`${codexHomeRoot}${path.sep}`)) {
        return resolved;
      }
      if (hostCodexHome && (resolved === hostCodexHome || resolved.startsWith(`${hostCodexHome}${path.sep}`))) {
        return path.join(codexHomeRoot, path.relative(hostCodexHome, resolved));
      }
      return null;
    }

    return path.join(codexHomeRoot, targetPath);
  }

  private runPythonSqliteScript(script: string, dbPath: string, threadId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "python3",
        ["-c", script],
        {
          env: {
            ...process.env,
            BRIDGE_SQLITE_DB_PATH: dbPath,
            BRIDGE_SQLITE_THREAD_ID: threadId,
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr.trim() || error.message));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  private async persistState(): Promise<void> {
    const snapshot = {
      seq: this.seq,
      tasks: [...this.tasks.values()],
      queuedMessagesByTaskId: Object.fromEntries(
        [...this.queuedMessages.entries()]
          .filter(([, queuedMessages]) => queuedMessages.length > 0)
          .map(([taskId, queuedMessages]) => [
            taskId,
            queuedMessages.map((message) => ({
              surface: message.surface,
              replyToFeishu: message.replyToFeishu,
              content: message.content,
              assetIds: [...message.assetIds],
            })),
          ]),
      ),
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

  private startRuntimeSyncLoop(): void {
    const intervalMs = this.options.runtimeSyncIntervalMs ?? BridgeService.DEFAULT_RUNTIME_SYNC_INTERVAL_MS;
    if (intervalMs <= 0 || this.runtimeSyncTimer) {
      return;
    }

    this.runtimeSyncTimer = setInterval(() => {
      if (this.runtimeSyncInFlight) {
        return;
      }

      this.runtimeSyncInFlight = true;
      void this.syncRuntimeThreads().finally(() => {
        this.runtimeSyncInFlight = false;
      });
    }, intervalMs);
  }
}
