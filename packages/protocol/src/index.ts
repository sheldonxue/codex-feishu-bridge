export type TaskMode = "bridge-managed" | "manual-import";
export type TaskOrigin = "feishu" | "vscode" | "cli" | "runtime";

export type TaskStatus =
  | "idle"
  | "queued"
  | "running"
  | "awaiting-approval"
  | "blocked"
  | "completed"
  | "failed"
  | "interrupted";

export type BridgeEventKind =
  | "daemon.ready"
  | "auth.login.started"
  | "auth.login.completed"
  | "auth.account.updated"
  | "task.created"
  | "task.resumed"
  | "task.updated"
  | "task.completed"
  | "task.failed"
  | "task.interrupted"
  | "task.message.queued"
  | "task.message.sent"
  | "task.steered"
  | "task.diff.updated"
  | "task.asset.added"
  | "approval.requested"
  | "approval.resolved"
  | "feishu.thread.bound"
  | "feishu.action.received";

export type ApprovalKind = "command" | "file-change" | "turn" | "message";
export type ApprovalState = "pending" | "accepted" | "declined" | "cancelled" | "expired";
export type DesktopClientKind = "vscode-extension" | "cli-wrapper" | "diagnostic-client";
export type FeishuActionKind = "reply" | "steer" | "interrupt" | "approve" | "cancel" | "retry";
export type MessageAuthor = "user" | "agent" | "system";
export type MessageSurface = "feishu" | "vscode" | "runtime";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type TaskAssetKind = "image" | "file";
export type FeishuRunningMessageMode = "steer" | "queue";

export interface FeishuThreadBinding {
  chatId: string;
  threadKey: string;
  rootMessageId?: string;
  webhookTenantKey?: string;
}

export interface TaskExecutionProfile {
  model?: string;
  effort?: ReasoningEffort;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  planMode?: boolean;
}

export interface TaskAsset {
  assetId: string;
  kind: TaskAssetKind;
  displayName: string;
  localPath: string;
  mimeType: string;
  createdAt: string;
}

export type ImageAsset = TaskAsset;

export interface TaskDiffEntry {
  path: string;
  summary: string;
  patch?: string;
}

export interface ConversationMessage {
  messageId: string;
  author: MessageAuthor;
  surface: MessageSurface;
  content: string;
  createdAt: string;
  assetIds?: string[];
}

export interface DesktopClientState {
  clientId: string;
  kind: DesktopClientKind;
  connectedAt: string;
  lastSeenAt: string;
}

export interface QueuedApproval {
  requestId: string;
  taskId: string;
  turnId?: string;
  kind: ApprovalKind;
  reason: string;
  state: ApprovalState;
  requestedAt: string;
  resolvedAt?: string;
}

export interface BridgeTask {
  taskId: string;
  threadId: string;
  mode: TaskMode;
  taskOrigin: TaskOrigin;
  title: string;
  titleLocked?: boolean;
  workspaceRoot: string;
  status: TaskStatus;
  activeTurnId?: string;
  latestSummary?: string;
  executionProfile: TaskExecutionProfile;
  desktopReplySyncToFeishu: boolean;
  feishuRunningMessageMode: FeishuRunningMessageMode;
  queuedMessageCount: number;
  feishuBinding?: FeishuThreadBinding;
  feishuBindingDisabled?: boolean;
  pendingApprovals: QueuedApproval[];
  diffs: TaskDiffEntry[];
  assets: TaskAsset[];
  conversation: ConversationMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface BridgeEvent<TPayload = unknown> {
  seq: number;
  taskId: string;
  kind: BridgeEventKind;
  timestamp: string;
  payload: TPayload;
}

export interface FeishuActionPayload {
  kind: FeishuActionKind;
  text?: string;
  actorId: string;
  messageId: string;
}

export interface BridgeTaskSeed {
  threadId: string;
  title: string;
  workspaceRoot: string;
  mode: TaskMode;
  taskOrigin?: TaskOrigin;
  executionProfile?: TaskExecutionProfile;
  createdAt?: string;
}

export function createBridgeTask(seed: BridgeTaskSeed): BridgeTask {
  const timestamp = seed.createdAt ?? new Date().toISOString();
  const taskOrigin = seed.taskOrigin ?? (seed.mode === "manual-import" ? "cli" : "runtime");

  return {
    taskId: seed.threadId,
    threadId: seed.threadId,
    mode: seed.mode,
    taskOrigin,
    title: seed.title,
    titleLocked: false,
    workspaceRoot: seed.workspaceRoot,
    status: "idle",
    executionProfile: structuredClone(seed.executionProfile ?? {}),
    desktopReplySyncToFeishu: false,
    feishuRunningMessageMode: "queue",
    queuedMessageCount: 0,
    feishuBindingDisabled: false,
    pendingApprovals: [],
    diffs: [],
    assets: [],
    conversation: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createBridgeEvent<TPayload>(
  seq: number,
  taskId: string,
  kind: BridgeEventKind,
  payload: TPayload,
  timestamp = new Date().toISOString(),
): BridgeEvent<TPayload> {
  return {
    seq,
    taskId,
    kind,
    timestamp,
    payload,
  };
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}
