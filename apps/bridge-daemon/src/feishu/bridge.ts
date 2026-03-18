import { createHmac } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import type {
  ApprovalPolicy,
  BridgeTask,
  ConversationMessage,
  FeishuThreadBinding,
  ReasoningEffort,
  SandboxMode,
  TaskExecutionProfile,
} from "@codex-feishu-bridge/protocol";
import { readJsonFile, writeJsonFile, type BridgeConfig, type Logger } from "@codex-feishu-bridge/shared";

import { BridgeService, type BridgeServiceEvent } from "../service/bridge-service";
import {
  createArchivedThreadCard,
  createCardTestCard,
  createDraftCard,
  createTaskControlCard,
  type FeishuCardActionValue,
  type FeishuInteractiveCard,
  type FeishuModelOption,
} from "./cards";

interface FeishuApiResponse<T> {
  code: number;
  msg?: string;
  data: T;
}

interface FeishuTenantTokenResponse {
  code: number;
  msg?: string;
  tenant_access_token: string;
  expire: number;
}

interface FeishuSendMessageResponse {
  message_id: string;
}

interface FeishuWebhookResult {
  statusCode: number;
  body: unknown;
}

interface FeishuWebhookHeaders {
  signature?: string;
  timestamp?: string;
  nonce?: string;
}

interface PersistedFeishuState {
  processedEventIds: string[];
  drafts: FeishuThreadDraft[];
  taskCards: FeishuTaskCardState[];
  archivedThreads: FeishuArchivedThreadState[];
}

interface FeishuThreadDraft {
  chatId: string;
  threadKey: string;
  rootMessageId?: string;
  prompt?: string;
  model?: string;
  effort?: ReasoningEffort;
  planMode: boolean;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  attachments: FeishuDraftAttachment[];
  cardMessageId?: string;
  cardRevision: number;
  note?: string;
}

interface FeishuDraftAttachment {
  localPath: string;
  fileName: string;
  mimeType: string;
  kind: "image" | "file";
}

interface FeishuTaskCardState {
  chatId: string;
  threadKey: string;
  rootMessageId?: string;
  taskId: string;
  messageId: string;
  revision: number;
  note?: string;
}

interface FeishuArchivedThreadState {
  chatId: string;
  threadKey: string;
  rootMessageId?: string;
  taskId?: string;
  taskTitle?: string;
  archivedAt: string;
}

export interface FeishuIncomingMessage {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  chat_id?: string;
  message_type?: string;
  content?: string;
}

export interface FeishuIncomingSender {
  sender_id?: {
    open_id?: string;
    union_id?: string;
    user_id?: string;
  };
}

export interface FeishuCardActionEvent {
  open_id?: string;
  user_id?: string;
  tenant_key?: string;
  open_message_id?: string;
  token?: string;
  action?: {
    value?: FeishuCardActionValue;
    tag?: string;
    option?: string;
    timezone?: string;
  };
}

export interface LongConnectionHandle {
  stop: () => Promise<void> | void;
}

export type LongConnectionFactory = (params: {
  onMessage: (message?: FeishuIncomingMessage, sender?: FeishuIncomingSender) => Promise<void>;
  onCardAction: (event?: FeishuCardActionEvent) => Promise<FeishuInteractiveCard | void>;
  config: BridgeConfig;
  logger: Logger;
}) => Promise<LongConnectionHandle>;

const FEISHU_TASK_LIST_LIMIT = 8;
const FEISHU_REPLY_MAX_CHARS = 3500;
const FEISHU_SYNCED_AGENT_MESSAGE_LIMIT = 200;
const FEISHU_KNOWN_COMMANDS = new Set([
  "help",
  "status",
  "bind",
  "unbind",
  "tasks",
  "task",
  "health",
  "account",
  "limits",
  "interrupt",
  "retry",
  "approve",
  "decline",
  "cancel",
  "new",
  "card-test",
]);
const REASONING_EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
const SANDBOX_MODE_VALUES = ["read-only", "workspace-write", "danger-full-access"] as const;
const APPROVAL_POLICY_VALUES = ["untrusted", "on-failure", "on-request", "never"] as const;
const DEFAULT_NEW_SANDBOX: SandboxMode = "workspace-write";
const DEFAULT_NEW_APPROVAL_POLICY: ApprovalPolicy = "on-request";

function parseMessageContent(rawContent: string | undefined): Record<string, unknown> {
  if (!rawContent) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseTextContent(rawContent: string | undefined): string {
  if (!rawContent) {
    return "";
  }

  try {
    const parsed = parseMessageContent(rawContent) as { text?: string };
    return parsed.text?.trim() ?? rawContent.trim();
  } catch {
    return rawContent.trim();
  }
}

function normalizeCommand(text: string): { command: string; args: string[] } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const rawCommand = tokens[0] ?? "";
  return {
    command: rawCommand.startsWith("/") ? rawCommand.slice(1).toLowerCase() : rawCommand.toLowerCase(),
    args: tokens.slice(1),
  };
}

function isSlashCommand(text: string): boolean {
  return text.trim().startsWith("/");
}

function collectLookupIds(message: FeishuIncomingMessage): string[] {
  const ids = [message.thread_id, message.root_id, message.parent_id, message.message_id].filter(
    (value): value is string => Boolean(value),
  );
  return [...new Set(ids)];
}

function buildBindingFromMessage(message: FeishuIncomingMessage): FeishuThreadBinding | null {
  if (!message.chat_id) {
    return null;
  }

  const threadKey = message.thread_id ?? message.root_id ?? message.parent_id ?? message.message_id;
  const rootMessageId = message.root_id ?? message.parent_id ?? message.message_id;
  if (!threadKey || !rootMessageId) {
    return null;
  }

  return {
    chatId: message.chat_id,
    threadKey,
    rootMessageId,
  };
}

function draftStorageKey(binding: Pick<FeishuThreadBinding, "chatId" | "threadKey">): string {
  return `${binding.chatId}:${binding.threadKey}`;
}

function createDefaultDraft(binding: FeishuThreadBinding): FeishuThreadDraft {
  return {
    chatId: binding.chatId,
    threadKey: binding.threadKey,
    rootMessageId: binding.rootMessageId,
    planMode: false,
    sandbox: DEFAULT_NEW_SANDBOX,
    approvalPolicy: DEFAULT_NEW_APPROVAL_POLICY,
    attachments: [],
    cardRevision: 1,
  };
}

function createTaskTitleFromDraft(draft: FeishuThreadDraft): string {
  const prompt = draft.prompt?.trim();
  if (!prompt) {
    return `Feishu task ${new Date().toISOString()}`;
  }

  return prompt.replace(/\s+/g, " ").slice(0, 60);
}

function formatExecutionProfile(profile: TaskExecutionProfile | undefined): string[] {
  return [
    `model: ${profile?.model ?? "runtime-default"}`,
    `effort: ${profile?.effort ?? "model-default"}`,
    `planMode: ${profile?.planMode ? "on" : "off"}`,
    `sandbox: ${profile?.sandbox ?? DEFAULT_NEW_SANDBOX}`,
    `approvalPolicy: ${profile?.approvalPolicy ?? DEFAULT_NEW_APPROVAL_POLICY}`,
  ];
}

function formatDraftAttachmentsSummary(draft: FeishuThreadDraft): string {
  if (draft.attachments.length === 0) {
    return "none";
  }

  const imageCount = draft.attachments.filter((attachment) => attachment.kind === "image").length;
  const fileCount = draft.attachments.length - imageCount;
  const parts: string[] = [];
  if (imageCount > 0) {
    parts.push(`${imageCount} photo${imageCount === 1 ? "" : "s"}`);
  }
  if (fileCount > 0) {
    parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

function fileNameFromContentDisposition(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }

  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }

  const quotedMatch = /filename="([^"]+)"/i.exec(header);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  const plainMatch = /filename=([^;]+)/i.exec(header);
  return plainMatch?.[1]?.trim();
}

function formatTaskSummary(task: BridgeTask): string {
  return [
    `taskId: ${task.taskId}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `mode: ${task.mode}`,
    `workspace: ${task.workspaceRoot}`,
    `pendingApprovals: ${task.pendingApprovals.length}`,
    `diffs: ${task.diffs.length}`,
    `attachments: ${task.assets.length}`,
    `messages: ${task.conversation.length}`,
    `desktopReplySyncToFeishu: ${task.desktopReplySyncToFeishu}`,
    `feishuRunningMessageMode: ${task.feishuRunningMessageMode}`,
    `queuedMessageCount: ${task.queuedMessageCount}`,
    ...formatExecutionProfile(task.executionProfile),
    task.feishuBinding ? `threadKey: ${task.feishuBinding.threadKey}` : "threadKey: unbound",
  ].join("\n");
}

function formatTaskList(tasks: BridgeTask[], currentTaskId?: string): string {
  if (tasks.length === 0) {
    return "No bridge tasks are currently available.";
  }

  const lines = tasks.slice(0, FEISHU_TASK_LIST_LIMIT).map((task) => {
    const marker = task.taskId === currentTaskId ? "*" : "-";
    return `${marker} ${task.taskId} [${task.status}] ${task.title}`;
  });

  if (tasks.length > FEISHU_TASK_LIST_LIMIT) {
    lines.push(`... ${tasks.length - FEISHU_TASK_LIST_LIMIT} more task(s) omitted`);
  }

  return [`Recent tasks (${tasks.length} total):`, ...lines].join("\n");
}

function formatAccountSummary(
  snapshot: ReturnType<BridgeService["getSnapshot"]>,
): string {
  if (!snapshot.account?.account) {
    return `No Codex account is currently loaded.\nrequiresOpenaiAuth: ${snapshot.account?.requiresOpenaiAuth ?? true}`;
  }

  return [
    `accountType: ${snapshot.account.account.type}`,
    snapshot.account.account.email ? `email: ${snapshot.account.account.email}` : undefined,
    snapshot.account.account.planType ? `plan: ${snapshot.account.account.planType}` : undefined,
    `requiresOpenaiAuth: ${snapshot.account.requiresOpenaiAuth}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatRateLimitWindow(
  label: string,
  window:
    | {
        usedPercent: number;
        windowDurationMins: number;
        resetsAt: number;
      }
    | null
    | undefined,
): string[] {
  if (!window) {
    return [`${label}: unavailable`];
  }

  return [
    `${label}: ${window.usedPercent}% used`,
    `${label} window: ${window.windowDurationMins}m`,
    `${label} resetsAt: ${new Date(window.resetsAt * 1000).toISOString()}`,
  ];
}

function formatRateLimitSummary(
  snapshot: ReturnType<BridgeService["getSnapshot"]>,
): string {
  if (!snapshot.rateLimits?.rateLimits) {
    return "Codex rate limits are currently unavailable.";
  }

  const limit = snapshot.rateLimits.rateLimits;
  return [
    `limitId: ${limit.limitId}`,
    limit.limitName ? `limitName: ${limit.limitName}` : undefined,
    ...formatRateLimitWindow("primary", limit.primary),
    ...formatRateLimitWindow("secondary", limit.secondary),
  ]
    .filter(Boolean)
    .join("\n");
}

function formatHealthSummary(
  config: BridgeConfig,
  snapshot: ReturnType<BridgeService["getSnapshot"]>,
  feishuEnabled: boolean,
): string {
  return [
    "status: ok",
    `backend: ${config.codexBackend}`,
    `feishuEnabled: ${feishuEnabled}`,
    `seq: ${snapshot.seq}`,
    `tasks: ${snapshot.tasks.length}`,
    `accountLoaded: ${Boolean(snapshot.account?.account)}`,
    `rateLimitsLoaded: ${Boolean(snapshot.rateLimits?.rateLimits)}`,
  ].join("\n");
}

function formatHelpText(): string {
  return [
    "Feishu bridge commands:",
    "/help",
    "/status",
    "/bind <taskId>",
    "/unbind",
    "/tasks",
    "/task [taskId]",
    "/health",
    "/account",
    "/limits",
    "/new",
    "/new prompt <text>",
    "/new models",
    "/new model <model-id>",
    "/new effort <none|minimal|low|medium|high|xhigh>",
    "/new plan <on|off>",
    "/new sandbox <read-only|workspace-write|danger-full-access>",
    "/new approval <untrusted|on-failure|on-request|never>",
    "/new create",
    "/new cancel",
    "/interrupt",
    "/retry [text]",
    "/approve [requestId]",
    "/decline [requestId]",
    "/cancel [requestId]",
  ].join("\n");
}

function formatDraftSummary(draft: FeishuThreadDraft): string {
  return [
    "Current /new draft:",
    `prompt: ${draft.prompt?.trim() ? draft.prompt : "(not set)"}`,
    `model: ${draft.model ?? "runtime-default"}`,
    `effort: ${draft.effort ?? "model-default"}`,
    `planMode: ${draft.planMode ? "on" : "off"}`,
    `sandbox: ${draft.sandbox}`,
    `approvalPolicy: ${draft.approvalPolicy}`,
    `attachments: ${formatDraftAttachmentsSummary(draft)}`,
    "",
    "Next steps:",
    "/new prompt <text>",
    "/new models",
    "/new model <model-id>",
    "/new effort <none|minimal|low|medium|high|xhigh>",
    "/new plan <on|off>",
    "/new sandbox <read-only|workspace-write|danger-full-access>",
    "/new approval <untrusted|on-failure|on-request|never>",
    "/new create",
    "/new cancel",
  ].join("\n");
}

function formatModelsList(
  models: Array<{
    id: string;
    displayName: string;
    isDefault: boolean;
    defaultReasoningEffort: ReasoningEffort;
    supportedReasoningEfforts: ReasoningEffort[];
  }>,
): string {
  if (models.length === 0) {
    return "No Codex models are currently available.";
  }

  return [
    "Available models:",
    ...models.map((model) =>
      [
        `${model.isDefault ? "*" : "-"} ${model.id} (${model.displayName})`,
        `  defaultEffort: ${model.defaultReasoningEffort}`,
        `  supportedEfforts: ${model.supportedReasoningEfforts.join(", ") || "none"}`,
      ].join("\n"),
    ),
  ].join("\n");
}

function formatApprovalResolved(task: BridgeTask, payload: { approval?: BridgeTask["pendingApprovals"][number]; requestId?: string }): string {
  if (payload.approval) {
    return [
      `Approval resolved for ${task.title}`,
      `requestId: ${payload.approval.requestId}`,
      `state: ${payload.approval.state}`,
    ].join("\n");
  }

  return [
    `Approval resolved for ${task.title}`,
    `requestId: ${payload.requestId ?? "unknown"}`,
  ].join("\n");
}

function formatTaskFailure(task: BridgeTask, payload: unknown): string {
  const turnError =
    payload &&
    typeof payload === "object" &&
    "turn" in payload &&
    payload.turn &&
    typeof payload.turn === "object" &&
    "error" in payload.turn &&
    payload.turn.error &&
    typeof payload.turn.error === "object" &&
    "message" in payload.turn.error
      ? String((payload.turn.error as { message?: unknown }).message ?? "")
      : undefined;

  return [
    `Task failed: ${task.title}`,
    turnError || task.latestSummary || "Unknown task failure.",
  ].join("\n");
}

function formatArchivedThreadNotice(taskId?: string): string {
  return [
    `This Feishu topic is archived${taskId ? ` from task ${taskId}` : ""}.`,
    "Start a new topic with the bot if you want to launch or bind more work.",
  ].join("\n");
}

function formatCreatedTaskNotice(taskId: string, initialMessageQueued: boolean): string {
  return initialMessageQueued
    ? `Created task ${taskId}. Initial message queued.`
    : `Created task ${taskId}. Send the first plain-text message in this thread to start the first turn.`;
}

function truncateReplyText(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= FEISHU_REPLY_MAX_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, FEISHU_REPLY_MAX_CHARS - 16)}\n\n[truncated]`;
}

function summarizeIncomingMessage(
  message: FeishuIncomingMessage | undefined,
  sender: FeishuIncomingSender | undefined,
): Record<string, string | undefined> {
  return {
    actorId: sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.sender_id?.union_id,
    messageId: message?.message_id,
    rootId: message?.root_id,
    parentId: message?.parent_id,
    threadId: message?.thread_id,
    chatId: message?.chat_id,
    messageType: message?.message_type,
    textPreview: parseTextContent(message?.content).slice(0, 120) || undefined,
  };
}

function summarizeCardAction(event: FeishuCardActionEvent | undefined): Record<string, string | undefined> {
  return {
    openId: event?.open_id,
    userId: event?.user_id,
    tenantKey: event?.tenant_key,
    openMessageId: event?.open_message_id,
    actionTag: event?.action?.tag,
    actionOption: event?.action?.option,
    actionKind: event?.action?.value?.kind,
    threadKey: event?.action?.value?.threadKey,
    taskId: event?.action?.value?.taskId,
  };
}

function buildCardActionDedupeId(event: FeishuCardActionEvent | undefined): string {
  const value = event?.action?.value;
  const token = event?.token?.trim();
  if (token) {
    return `token:${token}`;
  }

  return [
    event?.open_message_id ?? "unknown",
    value?.chatId ?? "unknown-chat",
    value?.threadKey ?? "unknown-thread",
    value?.rootMessageId ?? "",
    value?.taskId ?? "",
    value?.kind ?? "unknown",
    String(value?.revision ?? ""),
    event?.action?.option ?? "",
    value?.requestId ?? "",
  ].join(":");
}

export class FeishuBridge {
  private readonly stateFile: string;
  private readonly processedEventIds = new Set<string>();
  private readonly threadDrafts = new Map<string, FeishuThreadDraft>();
  private readonly threadTaskCards = new Map<string, FeishuTaskCardState>();
  private readonly archivedThreads = new Map<string, FeishuArchivedThreadState>();
  private serviceUnsubscribe: (() => void) | null = null;
  private tenantAccessToken?: string;
  private tenantAccessTokenExpiresAt = 0;
  private subscribed = false;
  private longConnectionHandle: LongConnectionHandle | null = null;
  private readonly longConnectionFactory?: LongConnectionFactory;
  private readonly deliveredAgentMessageIds = new Set<string>();
  private readonly deliveredApprovalResolutionKeys = new Set<string>();

  constructor(
    private readonly options: {
      config: BridgeConfig;
      logger: Logger;
      service: BridgeService;
      longConnectionFactory?: LongConnectionFactory;
    },
  ) {
    this.stateFile = path.join(options.config.stateDir, "feishu-events.json");
    this.longConnectionFactory = options.longConnectionFactory;
  }

  get enabled(): boolean {
    return this.hasLongConnectionConfig() || this.webhookEnabled;
  }

  get webhookEnabled(): boolean {
    return (
      Boolean(this.options.config.feishuAppId) &&
      Boolean(this.options.config.feishuAppSecret) &&
      Boolean(this.options.config.feishuVerificationToken) &&
      Boolean(this.options.config.feishuEncryptKey) &&
      Boolean(this.options.config.feishuDefaultChatId)
    );
  }

  private hasLongConnectionConfig(): boolean {
    return Boolean(
      this.options.config.feishuAppId &&
        this.options.config.feishuAppSecret &&
        this.options.config.feishuDefaultChatId &&
        this.longConnectionFactory,
    );
  }

  async initialize(): Promise<void> {
    const persisted = await readJsonFile<PersistedFeishuState>(this.stateFile, {
      processedEventIds: [],
      drafts: [],
      taskCards: [],
      archivedThreads: [],
    });
    for (const eventId of persisted.processedEventIds.slice(-200)) {
      this.processedEventIds.add(eventId);
    }
    for (const draft of persisted.drafts ?? []) {
      this.threadDrafts.set(draftStorageKey(draft), {
        ...draft,
        planMode: draft.planMode ?? false,
        attachments: draft.attachments ?? [],
      });
    }
    for (const card of persisted.taskCards ?? []) {
      this.threadTaskCards.set(draftStorageKey(card), card);
    }
    for (const archivedThread of persisted.archivedThreads ?? []) {
      this.archivedThreads.set(draftStorageKey(archivedThread), archivedThread);
    }

    if (!this.enabled || this.subscribed) {
      return;
    }

    this.serviceUnsubscribe = this.options.service.subscribe((payload) => {
      void this.handleServiceEvent(payload).catch((error) => {
        this.options.logger.warn("failed to sync task event to feishu", error);
      });
    });
    this.subscribed = true;

    await this.startLongConnection();
  }

  dispose(): void {
    this.serviceUnsubscribe?.();
    this.serviceUnsubscribe = null;
    this.subscribed = false;
    this.threadDrafts.clear();
    this.threadTaskCards.clear();
    this.archivedThreads.clear();
    void this.longConnectionHandle?.stop();
    this.longConnectionHandle = null;
  }

  async handleWebhook(rawBody: string, headers: FeishuWebhookHeaders): Promise<FeishuWebhookResult> {
    const body = JSON.parse(rawBody) as {
      challenge?: string;
      token?: string;
      type?: string;
      header?: {
        event_id?: string;
        event_type?: string;
        token?: string;
      };
      event?: {
        sender?: {
          sender_id?: {
            open_id?: string;
            union_id?: string;
            user_id?: string;
          };
        };
        message?: {
          message_id?: string;
          root_id?: string;
          parent_id?: string;
          chat_id?: string;
          message_type?: string;
          content?: string;
        };
      };
    };

    if (body.challenge || body.type === "url_verification") {
      return {
        statusCode: 200,
        body: {
          challenge: body.challenge,
        },
      };
    }

    if (!this.verifyToken(body) || !this.verifySignature(rawBody, headers)) {
      return {
        statusCode: 403,
        body: { error: "invalid feishu signature or token" },
      };
    }

    const eventId = body.header?.event_id;
    if (eventId && this.processedEventIds.has(eventId)) {
      return {
        statusCode: 200,
        body: { ok: true, deduped: true },
      };
    }

    if (body.header?.event_type === "im.message.receive_v1") {
      await this.handleIncomingMessage(body.event?.message, body.event?.sender);
    }

    if (eventId) {
      this.processedEventIds.add(eventId);
      await this.persistState();
    }

    return {
      statusCode: 200,
      body: { ok: true },
    };
  }

  async bindTaskToNewTopic(taskId: string): Promise<BridgeTask> {
    const defaultChatId = this.options.config.feishuDefaultChatId;
    if (!this.enabled || !defaultChatId) {
      throw new Error("Feishu bridge is not configured with a default chat.");
    }

    const task = this.options.service.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    if (task.feishuBinding) {
      throw new Error(`Task ${taskId} is already bound to Feishu. Unbind it before creating a new topic.`);
    }

    const rootMessageId = await this.sendChatMessage(
      defaultChatId,
      [
        "Codex task linked from VSCode monitor",
        `Task: ${task.title.replace(/\s+/g, " ").trim()}`,
        `Task ID: ${task.taskId}`,
        "Reply in this thread to continue from Feishu.",
      ].join("\n"),
    );
    const binding: FeishuThreadBinding = {
      chatId: defaultChatId,
      threadKey: rootMessageId,
      rootMessageId,
    };

    this.deleteArchivedThread(binding);
    const boundTask = await this.options.service.bindFeishuThread(task.taskId, binding);
    await this.renderTaskControlCard({
      task: this.options.service.getTask(task.taskId) ?? boundTask,
      binding,
      replyTargetId: rootMessageId,
      note: "Bound from the VSCode monitor.",
    });
    return this.options.service.getTask(task.taskId) ?? boundTask;
  }

  private async handleServiceEvent(payload: BridgeServiceEvent): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const { event } = payload;
    if (event.taskId === "system" || event.kind === "feishu.thread.bound") {
      return;
    }

    const task = this.options.service.getTask(event.taskId);
    if (!task?.feishuBinding) {
      return;
    }

    const syncedAgentReplies = this.extractAgentReplies(event, task);
    if (syncedAgentReplies.length > 0) {
      for (const syncedAgentReply of syncedAgentReplies) {
        await this.replyToMessage(
          task.feishuBinding.rootMessageId ?? task.feishuBinding.threadKey,
          syncedAgentReply,
        );
      }
      await this.renderTaskControlCard({
        task,
        binding: task.feishuBinding,
      });
      return;
    }

    switch (event.kind) {
      case "task.message.queued":
        await this.renderTaskControlCard({
          task,
          binding: task.feishuBinding,
          note:
            task.queuedMessageCount === 1
              ? "Queued 1 Feishu message for the next turn."
              : `Queued ${task.queuedMessageCount} Feishu messages for upcoming turns.`,
        });
        return;
      case "task.message.sent":
        await this.renderTaskControlCard({
          task,
          binding: task.feishuBinding,
        });
        return;
      case "approval.requested": {
        const approval =
          event.payload &&
          typeof event.payload === "object" &&
          "approval" in event.payload
            ? ((event.payload as { approval?: BridgeTask["pendingApprovals"][number] }).approval ?? null)
            : null;
        if (!approval) {
          return;
        }
        await this.renderTaskControlCard({
          task,
          binding: task.feishuBinding,
          note: `Approval requested: ${approval.kind} - ${approval.reason}`,
          forceReply: true,
        });
        return;
      }
      case "approval.resolved": {
        const approvalPayload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as { approval?: BridgeTask["pendingApprovals"][number]; requestId?: string })
            : {};
        const requestId = approvalPayload.approval?.requestId ?? approvalPayload.requestId;
        const resolutionState =
          approvalPayload.approval?.state ??
          task.pendingApprovals.find((entry) => entry.requestId === requestId)?.state ??
          "resolved";
        if (resolutionState === "accepted") {
          return;
        }
        const resolutionKey = `${task.taskId}:${requestId ?? "unknown"}:${resolutionState}`;
        if (this.deliveredApprovalResolutionKeys.has(resolutionKey)) {
          return;
        }
        this.deliveredApprovalResolutionKeys.add(resolutionKey);
        if (this.deliveredApprovalResolutionKeys.size > FEISHU_SYNCED_AGENT_MESSAGE_LIMIT) {
          const oldest = this.deliveredApprovalResolutionKeys.values().next().value;
          if (oldest) {
            this.deliveredApprovalResolutionKeys.delete(oldest);
          }
        }
        await this.replyToMessage(
          task.feishuBinding.rootMessageId ?? task.feishuBinding.threadKey,
          formatApprovalResolved(task, approvalPayload),
        );
        await this.renderTaskControlCard({
          task,
          binding: task.feishuBinding,
          note: `Approval ${requestId ?? "unknown"} resolved as ${resolutionState}.`,
        });
        return;
      }
      case "task.failed":
        await this.replyToMessage(
          task.feishuBinding.rootMessageId ?? task.feishuBinding.threadKey,
          formatTaskFailure(task, event.payload),
        );
        await this.renderTaskControlCard({
          task,
          binding: task.feishuBinding,
          note: formatTaskFailure(task, event.payload),
        });
        return;
      case "task.completed":
      case "task.interrupted":
        await this.renderTaskControlCard({
          task,
          binding: task.feishuBinding,
        });
        return;
      default:
        return;
    }
  }

  private extractAgentReplies(event: BridgeServiceEvent["event"], task: BridgeTask): string[] {
    if (event.kind !== "task.updated") {
      return [];
    }

    const payload = event.payload as {
      task?: BridgeTask;
      item?: {
        id?: string;
        type?: string;
        text?: string;
      };
      importedConversationDelta?: ConversationMessage[];
    };
    const replies: string[] = [];
    const item = payload.item;
    if (item?.type === "agentMessage" && item.id && item.text?.trim()) {
      const syncedConversationEntry = payload.task?.conversation.find((entry) => entry.messageId === item.id);
      if (this.shouldSyncAgentReply(task, syncedConversationEntry)) {
        const tracked = this.trackDeliveredAgentMessage(item.id, item.text.trim());
        if (tracked) {
          replies.push(tracked);
        }
      }
    }

    const importedConversationDelta = Array.isArray(payload.importedConversationDelta) ? payload.importedConversationDelta : [];
    for (const entry of importedConversationDelta) {
      if (entry.author !== "agent" || !entry.content.trim()) {
        continue;
      }
      if (!this.shouldSyncAgentReply(task, entry)) {
        continue;
      }
      const tracked = this.trackDeliveredAgentMessage(entry.messageId, entry.content.trim());
      if (tracked) {
        replies.push(tracked);
      }
    }

    return replies;
  }

  private shouldSyncAgentReply(
    task: BridgeTask,
    conversationEntry: ConversationMessage | undefined,
  ): boolean {
    if (!conversationEntry) {
      return task.desktopReplySyncToFeishu;
    }

    return conversationEntry.surface === "feishu" || task.desktopReplySyncToFeishu;
  }

  private trackDeliveredAgentMessage(messageId: string, text: string): string | null {
    if (this.deliveredAgentMessageIds.has(messageId)) {
      return null;
    }

    this.deliveredAgentMessageIds.add(messageId);
    if (this.deliveredAgentMessageIds.size > FEISHU_SYNCED_AGENT_MESSAGE_LIMIT) {
      const oldest = this.deliveredAgentMessageIds.values().next().value;
      if (oldest) {
        this.deliveredAgentMessageIds.delete(oldest);
      }
    }

    return text;
  }

  private async handleIncomingMessage(
    message:
      | FeishuIncomingMessage
      | undefined,
    sender:
      | FeishuIncomingSender
      | undefined,
  ): Promise<void> {
    const summary = summarizeIncomingMessage(message, sender);
    if (!message) {
      this.options.logger.info("ignoring feishu incoming event without message", summary);
      return;
    }

    const lookupIds = collectLookupIds(message);
    const lookupId = lookupIds[0];
    if (!lookupId) {
      this.options.logger.info("ignoring feishu incoming message without lookup id", summary);
      return;
    }

    const actorId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.sender_id?.union_id ?? "unknown";
    const replyTargetId = message.message_id ?? message.root_id ?? message.parent_id ?? message.thread_id ?? lookupId;
    const currentBinding = buildBindingFromMessage(message);
    const task = this.options.service.findTaskByFeishuBinding(message.chat_id, lookupIds);
    const archivedThread = currentBinding ? this.getArchivedThread(currentBinding) : null;

    if (message.message_type === "image" || message.message_type === "file") {
      await this.handleIncomingAttachmentMessage({
        message,
        task,
        currentBinding,
        archivedThread,
        replyTargetId,
        actorId,
      });
      return;
    }

    if (message.message_type !== "text") {
      this.options.logger.info("ignoring unsupported feishu message type", summary);
      return;
    }

    if (!task && archivedThread) {
      await this.replyToMessage(replyTargetId, formatArchivedThreadNotice(archivedThread.taskId));
      return;
    }

    const text = parseTextContent(message.content);
    const { command, args } = normalizeCommand(text);
    const slashCommand = isSlashCommand(text);

    if (slashCommand) {
      try {
        await this.handleSlashCommand({
          command,
          args,
          task,
          currentBinding,
          replyTargetId,
        });
      } catch (error) {
        this.options.logger.warn("failed to execute feishu slash command", {
          ...summary,
          lookupIds,
          command: command || "/",
          error,
        });
        await this.replyToMessage(replyTargetId, `Command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (!task) {
      if (currentBinding) {
        const draft = this.getThreadDraft(currentBinding) ?? createDefaultDraft(currentBinding);
        draft.prompt = text || draft.prompt;
        draft.note = "Draft updated from the latest plain-text message.";
        draft.cardRevision += 1;
        await this.saveThreadDraft(draft);
        await this.renderDraftCard({
          binding: currentBinding,
          draft,
          replyTargetId,
          note: draft.note,
        });
        return;
      }

      this.options.logger.info("no feishu task binding matched incoming message", {
        ...summary,
        lookupIds,
      });
      return;
    }

    this.options.logger.info("routing feishu incoming message", {
      ...summary,
      lookupIds,
      taskId: task.taskId,
      command: "message",
    });

    try {
      await this.options.service.sendMessage(task.taskId, {
        content: text || `Message from ${actorId}`,
        source: "feishu",
        replyToFeishu: true,
      });
    } catch (error) {
      this.options.logger.warn("failed to route feishu task message", {
        ...summary,
        lookupIds,
        taskId: task.taskId,
        error,
      });
      await this.replyToMessage(
        task.feishuBinding?.rootMessageId ?? replyTargetId,
        `Task action failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleIncomingAttachmentMessage(params: {
    message: FeishuIncomingMessage;
    task: BridgeTask | null;
    currentBinding: FeishuThreadBinding | null;
    archivedThread: FeishuArchivedThreadState | null;
    replyTargetId: string;
    actorId: string;
  }): Promise<void> {
    const { message, task, currentBinding, archivedThread, replyTargetId, actorId } = params;
    if (!task && archivedThread) {
      await this.replyToMessage(replyTargetId, formatArchivedThreadNotice(archivedThread.taskId));
      return;
    }

    const attachment = await this.downloadIncomingAttachment(message);
    if (!attachment) {
      await this.replyToMessage(replyTargetId, "This attachment type is not supported yet.");
      return;
    }

    if (!task) {
      if (!currentBinding) {
        this.options.logger.info("ignoring feishu attachment without task or draft binding", {
          messageType: message.message_type,
          messageId: message.message_id,
        });
        return;
      }

      const draft = this.getThreadDraft(currentBinding) ?? createDefaultDraft(currentBinding);
      const storedAttachment = await this.saveDraftAttachment(currentBinding, attachment);
      draft.attachments = [...draft.attachments, storedAttachment];
      draft.note = `Queued ${storedAttachment.kind === "image" ? "photo" : "file"} attachment ${storedAttachment.fileName}.`;
      draft.cardRevision += 1;
      await this.saveThreadDraft(draft);
      await this.renderDraftCard({
        binding: currentBinding,
        draft,
        replyTargetId,
        note: draft.note,
      });
      return;
    }

    const upload = await this.options.service.uploadTaskAsset(task.taskId, {
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      contentBase64: attachment.buffer.toString("base64"),
      kind: attachment.kind,
    });
    await this.options.service.sendMessage(task.taskId, {
      content: "",
      assetIds: [upload.asset.assetId],
      source: "feishu",
      replyToFeishu: true,
      executionProfile: task.executionProfile,
    });

    await this.replyToMessage(
      task.feishuBinding?.rootMessageId ?? replyTargetId,
      `Queued ${attachment.kind === "image" ? "photo" : "file"} attachment from ${actorId}.`,
    );
  }

  private async downloadIncomingAttachment(message: FeishuIncomingMessage): Promise<{
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    kind: "image" | "file";
  } | null> {
    const content = parseMessageContent(message.content);
    if (message.message_type === "image") {
      const imageKey = typeof content.image_key === "string" ? content.image_key : "";
      if (!imageKey) {
        return null;
      }
      const response = await this.requestFeishuBinary(`/open-apis/im/v1/images/${encodeURIComponent(imageKey)}`);
      const mimeType = response.mimeType || "image/png";
      const extension = mimeType.split("/")[1] ?? "png";
      return {
        buffer: response.buffer,
        fileName: response.fileName ?? `${imageKey}.${extension}`,
        mimeType,
        kind: "image",
      };
    }

    if (message.message_type === "file") {
      const fileKey = typeof content.file_key === "string" ? content.file_key : "";
      if (!fileKey) {
        return null;
      }
      const response = await this.requestFeishuBinary(`/open-apis/im/v1/files/${encodeURIComponent(fileKey)}`);
      return {
        buffer: response.buffer,
        fileName:
          (typeof content.file_name === "string" && content.file_name) ||
          response.fileName ||
          `${fileKey}.bin`,
        mimeType: response.mimeType || "application/octet-stream",
        kind: "file",
      };
    }

    return null;
  }

  private async saveDraftAttachment(
    binding: FeishuThreadBinding,
    attachment: {
      buffer: Buffer;
      fileName: string;
      mimeType: string;
      kind: "image" | "file";
    },
  ): Promise<FeishuDraftAttachment> {
    const draftDir = path.join(
      this.options.config.uploadsDir,
      "feishu-drafts",
      `${binding.chatId}-${binding.threadKey}`,
    );
    await mkdir(draftDir, { recursive: true });
    const fileName = `${Date.now()}-${path.basename(attachment.fileName).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const localPath = path.join(draftDir, fileName);
    await writeFile(localPath, attachment.buffer);
    return {
      localPath,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
    };
  }

  private async uploadDraftAttachmentsToTask(taskId: string, draft: FeishuThreadDraft): Promise<string[]> {
    const assetIds: string[] = [];
    for (const attachment of draft.attachments) {
      const contentBase64 = (await readFile(attachment.localPath)).toString("base64");
      const upload = await this.options.service.uploadTaskAsset(taskId, {
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        contentBase64,
        kind: attachment.kind,
      });
      assetIds.push(upload.asset.assetId);
    }
    return assetIds;
  }

  private async handleSlashCommand(params: {
    command: string;
      args: string[];
      task: BridgeTask | null;
      currentBinding: FeishuThreadBinding | null;
      replyTargetId: string;
  }): Promise<void> {
    const { command, args, task, currentBinding, replyTargetId } = params;
    const snapshot = this.options.service.getSnapshot();

    if (!command || command === "help") {
      await this.replyToMessage(
        replyTargetId,
        `Card-first workflow:\n- send plain text in an unbound thread to open a config card\n- create a task from the card\n- keep chatting with plain text in the same thread\n- use the control card for task actions\n\nSlash commands remain as a compatibility fallback.\n\n${formatHelpText()}`,
      );
      return;
    }

    if (command === "card-test") {
      await this.sendCardReply(replyTargetId, createCardTestCard());
      return;
    }

    if (command === "new") {
      await this.handleNewCommand({
        args,
        task,
        currentBinding,
        replyTargetId,
      });
      return;
    }

    if (command === "tasks") {
      await this.replyToMessage(replyTargetId, formatTaskList(this.options.service.listTasks(), task?.taskId));
      return;
    }

    if (command === "task") {
      const targetTask = args[0] ? this.options.service.getTask(args[0]) : task;
      if (!targetTask) {
        await this.replyToMessage(replyTargetId, "No task is currently selected for this thread. Use /task <taskId> or /bind <taskId>.");
        return;
      }

      await this.replyToMessage(replyTargetId, formatTaskSummary(targetTask));
      return;
    }

    if (command === "health") {
      await this.replyToMessage(replyTargetId, formatHealthSummary(this.options.config, snapshot, this.enabled));
      return;
    }

    if (command === "account") {
      await this.replyToMessage(replyTargetId, formatAccountSummary(snapshot));
      return;
    }

    if (command === "limits") {
      await this.replyToMessage(replyTargetId, formatRateLimitSummary(snapshot));
      return;
    }

    if (command === "status") {
      const draft = currentBinding ? this.getThreadDraft(currentBinding) : null;
      if (!task) {
        await this.replyToMessage(
          replyTargetId,
          [
            "Thread status: unbound",
            draft ? formatDraftSummary(draft) : "Use /new to draft a task or /bind <taskId> to attach an existing one.",
          ].join("\n\n"),
        );
        return;
      }

      const binding = task.feishuBinding;
      await this.replyToMessage(
        replyTargetId,
        [
          "Thread status: bound",
          `taskId: ${task.taskId}`,
          `title: ${task.title}`,
          `status: ${task.status}`,
          ...formatExecutionProfile(task.executionProfile),
          binding ? `threadKey: ${binding.threadKey}` : undefined,
          binding?.rootMessageId ? `rootMessageId: ${binding.rootMessageId}` : undefined,
          `desktopReplySyncToFeishu: ${task.desktopReplySyncToFeishu}`,
          `feishuRunningMessageMode: ${task.feishuRunningMessageMode}`,
          `queuedMessageCount: ${task.queuedMessageCount}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }

    if (command === "bind") {
      if (!currentBinding) {
        await this.replyToMessage(
          replyTargetId,
          "This message cannot be bound because the current Feishu thread identifiers are incomplete.",
        );
        return;
      }

      const targetTaskId = args[0];
      if (!targetTaskId) {
        if (task) {
          await this.replyToMessage(
            replyTargetId,
            `This thread is already bound to ${task.taskId}. Use /unbind to detach it or /bind <taskId> to rebind.`,
          );
        } else {
          await this.replyToMessage(replyTargetId, "Usage: /bind <taskId>");
        }
        return;
      }

      const targetTask = this.options.service.getTask(targetTaskId);
      if (!targetTask) {
        await this.replyToMessage(replyTargetId, `Unknown task: ${targetTaskId}`);
        return;
      }

      if (task && task.taskId !== targetTaskId) {
        await this.options.service.unbindFeishuThread(task.taskId);
      }

      this.deleteArchivedThread(currentBinding);
      this.deleteThreadDraft(currentBinding);
      const reboundTask = await this.options.service.bindFeishuThread(targetTaskId, currentBinding);
      await this.renderTaskControlCard({
        task: reboundTask,
        binding: currentBinding,
        replyTargetId,
        note: `Bound this thread to ${reboundTask.taskId}.`,
      });
      await this.replyToMessage(
        replyTargetId,
        `Bound this Feishu thread to task ${reboundTask.taskId} (${reboundTask.title}). Use /status to inspect or /unbind to detach.`,
      );
      return;
    }

    if (command === "unbind") {
      if (!task) {
        await this.replyToMessage(replyTargetId, "This Feishu thread is already unbound.");
        return;
      }

      const unboundTaskId = task.taskId;
      await this.options.service.unbindFeishuThread(task.taskId);
      if (task.feishuBinding) {
        await this.markThreadUnbound(
          task.feishuBinding,
          `Thread unbound from ${unboundTaskId}. Send a plain-text message to draft a new task.`,
        );
      }
      await this.replyToMessage(
        replyTargetId,
        `Unbound this Feishu thread from task ${unboundTaskId}. Use /bind <taskId> to attach it again.`,
      );
      return;
    }

    if (!FEISHU_KNOWN_COMMANDS.has(command)) {
      await this.replyToMessage(replyTargetId, `Unknown command: /${command}\n\n${formatHelpText()}`);
      return;
    }

    if (!task) {
      await this.replyToMessage(
        replyTargetId,
        `This Feishu thread is currently unbound. Use /new or /bind <taskId> before running /${command}.`,
      );
      return;
    }

    switch (command) {
      case "interrupt":
        await this.options.service.interruptTask(task.taskId);
        await this.replyToMessage(replyTargetId, `Interrupted task ${task.taskId}.`);
        return;
      case "retry":
        await this.options.service.sendMessage(task.taskId, {
          content: args.join(" ") || "Retry the last turn and continue.",
          source: "feishu",
          replyToFeishu: true,
        });
        await this.replyToMessage(replyTargetId, `Queued retry for task ${task.taskId}.`);
        return;
      case "approve":
      case "decline":
      case "cancel": {
        const decision = command === "approve" ? "accept" : command;
        const requestId = args[0];
        const approval =
          task.pendingApprovals.find((entry) => entry.requestId === requestId && entry.state === "pending") ??
          task.pendingApprovals.find((entry) => entry.state === "pending");
        if (!approval) {
          await this.replyToMessage(replyTargetId, `No pending approval was found for ${task.title}.`);
          return;
        }

        await this.options.service.resolveApproval(task.taskId, approval.requestId, decision);
        return;
      }
      default:
        await this.replyToMessage(replyTargetId, formatHelpText());
    }
  }

  private getThreadDraft(binding: Pick<FeishuThreadBinding, "chatId" | "threadKey">): FeishuThreadDraft | null {
    return this.threadDrafts.get(draftStorageKey(binding)) ?? null;
  }

  private async saveThreadDraft(draft: FeishuThreadDraft): Promise<void> {
    this.threadDrafts.set(draftStorageKey(draft), draft);
    await this.persistState();
  }

  private deleteThreadDraft(binding: Pick<FeishuThreadBinding, "chatId" | "threadKey"> | null): void {
    if (!binding) {
      return;
    }

    const existing = this.threadDrafts.get(draftStorageKey(binding));
    this.threadDrafts.delete(draftStorageKey(binding));
    if (existing?.attachments.length) {
      void Promise.allSettled(existing.attachments.map((attachment) => rm(attachment.localPath, { force: true })));
    }
    void this.persistState();
  }

  private getThreadTaskCard(binding: Pick<FeishuThreadBinding, "chatId" | "threadKey">): FeishuTaskCardState | null {
    return this.threadTaskCards.get(draftStorageKey(binding)) ?? null;
  }

  private async saveThreadTaskCard(card: FeishuTaskCardState): Promise<void> {
    this.threadTaskCards.set(draftStorageKey(card), card);
    await this.persistState();
  }

  private deleteThreadTaskCard(binding: Pick<FeishuThreadBinding, "chatId" | "threadKey"> | null): void {
    if (!binding) {
      return;
    }

    this.threadTaskCards.delete(draftStorageKey(binding));
    void this.persistState();
  }

  private getArchivedThread(binding: Pick<FeishuThreadBinding, "chatId" | "threadKey">): FeishuArchivedThreadState | null {
    return this.archivedThreads.get(draftStorageKey(binding)) ?? null;
  }

  private isThreadArchived(binding: Pick<FeishuThreadBinding, "chatId" | "threadKey"> | null): boolean {
    if (!binding) {
      return false;
    }

    return this.archivedThreads.has(draftStorageKey(binding));
  }

  private async saveArchivedThread(archivedThread: FeishuArchivedThreadState): Promise<void> {
    this.archivedThreads.set(draftStorageKey(archivedThread), archivedThread);
    await this.persistState();
  }

  private deleteArchivedThread(binding: Pick<FeishuThreadBinding, "chatId" | "threadKey"> | null): void {
    if (!binding) {
      return;
    }

    this.archivedThreads.delete(draftStorageKey(binding));
    void this.persistState();
  }

  private toModelOptions(models: Awaited<ReturnType<BridgeService["listModels"]>>): FeishuModelOption[] {
    return models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      isDefault: model.isDefault,
      defaultReasoningEffort: model.defaultReasoningEffort,
      supportedReasoningEfforts: model.supportedReasoningEfforts,
    }));
  }

  private async sendCardReply(messageId: string, card: FeishuInteractiveCard): Promise<string> {
    const response = await this.requestFeishu<FeishuSendMessageResponse>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({
          msg_type: "interactive",
          reply_in_thread: true,
          content: JSON.stringify(card),
        }),
      },
    );
    return response.message_id;
  }

  private async patchCardMessage(messageId: string, card: FeishuInteractiveCard): Promise<void> {
    await this.requestFeishu<{}>(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        content: JSON.stringify(card),
      }),
    });
  }

  private async renderDraftCard(params: {
    binding: FeishuThreadBinding;
    draft: FeishuThreadDraft;
    replyTargetId?: string;
    note?: string;
  }): Promise<FeishuInteractiveCard> {
    const { binding, draft, replyTargetId, note } = params;
    const card = await this.buildDraftCard(binding, draft, note ?? draft.note);
    const nextReplyTargetId = replyTargetId ?? (!draft.cardMessageId ? binding.rootMessageId : undefined);

    if (nextReplyTargetId && !draft.cardMessageId) {
      draft.cardMessageId = await this.sendCardReply(nextReplyTargetId, card);
      if (note !== undefined) {
        draft.note = note;
      }
      await this.saveThreadDraft(draft);
      return card;
    }

    if (draft.cardMessageId) {
      await this.patchCardMessage(draft.cardMessageId, card);
      if (note !== undefined) {
        draft.note = note;
      }
      await this.saveThreadDraft(draft);
    }

    return card;
  }

  private async buildDraftCard(
    binding: FeishuThreadBinding,
    draft: FeishuThreadDraft,
  note?: string,
  ): Promise<FeishuInteractiveCard> {
    return createDraftCard({
      prompt: draft.prompt,
      model: draft.model,
      effort: draft.effort,
      planMode: draft.planMode,
      sandbox: draft.sandbox,
      approvalPolicy: draft.approvalPolicy,
      attachmentSummary: formatDraftAttachmentsSummary(draft),
      note,
      binding,
      revision: draft.cardRevision,
      modelOptions: this.toModelOptions(await this.options.service.listModels()),
    });
  }

  private async renderTaskControlCard(params: {
    task: BridgeTask;
    binding: FeishuThreadBinding;
    replyTargetId?: string;
    note?: string;
    forceReply?: boolean;
  }): Promise<FeishuInteractiveCard | null> {
    const { task, binding, replyTargetId, note, forceReply = false } = params;
    const existing = this.getThreadTaskCard(binding);
    const revision = (existing?.revision ?? 0) + 1;
    const card = await this.buildTaskControlCard(task, binding, revision, note ?? existing?.note);

    let messageId = forceReply ? undefined : existing?.messageId;
    const nextReplyTargetId =
      replyTargetId ??
      (forceReply ? (binding.rootMessageId ?? binding.threadKey) : !messageId ? binding.rootMessageId : undefined);
    if (!messageId && nextReplyTargetId) {
      messageId = await this.sendCardReply(nextReplyTargetId, card);
    } else if (messageId) {
      await this.patchCardMessage(messageId, card);
    } else {
      return null;
    }

    await this.saveThreadTaskCard({
      chatId: binding.chatId,
      threadKey: binding.threadKey,
      rootMessageId: binding.rootMessageId,
      taskId: task.taskId,
      messageId,
      revision,
      note: note ?? existing?.note,
    });
    return card;
  }

  private async buildTaskControlCard(
    task: BridgeTask,
    binding: FeishuThreadBinding,
    revision: number,
    note?: string,
  ): Promise<FeishuInteractiveCard> {
    return createTaskControlCard({
      task,
      binding,
      note,
      revision,
      modelOptions: this.toModelOptions(await this.options.service.listModels()),
    });
  }

  private async renderArchivedThreadCard(params: {
    binding: FeishuThreadBinding;
    taskId?: string;
    taskTitle?: string;
    archivedAt?: string;
    messageId?: string;
    note?: string;
  }): Promise<FeishuInteractiveCard> {
    const { binding, taskId, taskTitle, archivedAt, messageId, note } = params;
    const card = createArchivedThreadCard({
      binding,
      taskId,
      taskTitle,
      archivedAt,
      note,
    });

    const targetMessageId = messageId ?? this.getThreadTaskCard(binding)?.messageId ?? this.getThreadDraft(binding)?.cardMessageId;
    if (!targetMessageId) {
      return card;
    }

    await this.patchCardMessage(targetMessageId, card);
    return card;
  }

  private async markThreadUnbound(binding: FeishuThreadBinding, note: string): Promise<void> {
    const existing = this.getThreadTaskCard(binding);
    if (!existing?.messageId) {
      this.deleteThreadTaskCard(binding);
      return;
    }

    await this.patchCardMessage(
      existing.messageId,
      await this.buildDraftCard(
        binding,
        {
          ...createDefaultDraft(binding),
          note,
          cardRevision: existing.revision + 1,
        },
        note,
      ),
    );
    this.deleteThreadTaskCard(binding);
  }

  private async handleNewCommand(params: {
    args: string[];
    task: BridgeTask | null;
    currentBinding: FeishuThreadBinding | null;
    replyTargetId: string;
  }): Promise<void> {
    const { args, task, currentBinding, replyTargetId } = params;
    if (task) {
      await this.replyToMessage(
        replyTargetId,
        `This thread is already bound to ${task.taskId}. Use /unbind before creating a new task.`,
      );
      return;
    }

    if (!currentBinding) {
      await this.replyToMessage(
        replyTargetId,
        "This Feishu message does not expose stable thread identifiers, so /new is unavailable here.",
      );
      return;
    }

    const action = (args[0] ?? "").toLowerCase();
    let draft = this.getThreadDraft(currentBinding);

    if (!action) {
      draft = draft ?? createDefaultDraft(currentBinding);
      await this.saveThreadDraft(draft);
      await this.renderDraftCard({
        binding: currentBinding,
        draft,
        replyTargetId,
      });
      return;
    }

    if (action === "cancel") {
      if (!draft) {
        await this.replyToMessage(replyTargetId, "There is no active /new draft for this thread.");
        return;
      }
      this.deleteThreadDraft(currentBinding);
      await this.replyToMessage(replyTargetId, "Discarded the current /new draft.");
      return;
    }

    if (action === "models") {
      const models = await this.options.service.listModels();
      await this.replyToMessage(replyTargetId, formatModelsList(models));
      return;
    }

    draft = draft ?? createDefaultDraft(currentBinding);

    switch (action) {
      case "prompt": {
        const prompt = args.slice(1).join(" ").trim();
        if (!prompt) {
          await this.replyToMessage(replyTargetId, "Usage: /new prompt <text>");
          return;
        }

        draft.prompt = prompt;
        draft.cardRevision += 1;
        await this.saveThreadDraft(draft);
        await this.renderDraftCard({
          binding: currentBinding,
          draft,
          replyTargetId,
          note: "Prompt updated from slash command.",
        });
        return;
      }
      case "model": {
        const modelId = args[1];
        if (!modelId) {
          await this.replyToMessage(replyTargetId, "Usage: /new model <model-id>");
          return;
        }

        const models = await this.options.service.listModels();
        const model = models.find((entry) => entry.id === modelId || entry.model === modelId);
        if (!model) {
          await this.replyToMessage(replyTargetId, `Unknown model: ${modelId}`);
          return;
        }

        draft.model = model.id;
        let fallbackNote: string | undefined;
        if (draft.effort && !model.supportedReasoningEfforts.includes(draft.effort)) {
          draft.effort = model.defaultReasoningEffort;
          fallbackNote = `effort reverted to ${model.defaultReasoningEffort} because ${model.id} does not support the previous value.`;
        }

        draft.cardRevision += 1;
        await this.saveThreadDraft(draft);
        await this.renderDraftCard({
          binding: currentBinding,
          draft,
          replyTargetId,
          note: fallbackNote ?? "Model updated from slash command.",
        });
        return;
      }
      case "effort": {
        const effort = args[1] as ReasoningEffort | undefined;
        if (!effort || !REASONING_EFFORT_VALUES.includes(effort)) {
          await this.replyToMessage(replyTargetId, "Usage: /new effort <none|minimal|low|medium|high|xhigh>");
          return;
        }

        if (draft.model) {
          const models = await this.options.service.listModels();
          const model = models.find((entry) => entry.id === draft.model || entry.model === draft.model);
          if (!model) {
            await this.replyToMessage(replyTargetId, `Configured model ${draft.model} is no longer available.`);
            return;
          }
          if (!model.supportedReasoningEfforts.includes(effort)) {
            await this.replyToMessage(
              replyTargetId,
              `Model ${model.id} does not support effort ${effort}. Supported values: ${model.supportedReasoningEfforts.join(", ")}`,
            );
            return;
          }
        }

        draft.effort = effort;
        draft.cardRevision += 1;
        await this.saveThreadDraft(draft);
        await this.renderDraftCard({
          binding: currentBinding,
          draft,
          replyTargetId,
          note: "Reasoning effort updated from slash command.",
        });
        return;
      }
      case "plan": {
        const rawValue = args[1]?.toLowerCase();
        if (rawValue !== "on" && rawValue !== "off") {
          await this.replyToMessage(replyTargetId, "Usage: /new plan <on|off>");
          return;
        }

        draft.planMode = rawValue === "on";
        draft.cardRevision += 1;
        await this.saveThreadDraft(draft);
        await this.renderDraftCard({
          binding: currentBinding,
          draft,
          replyTargetId,
          note: `Plan mode ${draft.planMode ? "enabled" : "disabled"} from slash command.`,
        });
        return;
      }
      case "sandbox": {
        const sandbox = args[1] as SandboxMode | undefined;
        if (!sandbox || !SANDBOX_MODE_VALUES.includes(sandbox)) {
          await this.replyToMessage(
            replyTargetId,
            "Usage: /new sandbox <read-only|workspace-write|danger-full-access>",
          );
          return;
        }

        draft.sandbox = sandbox;
        draft.cardRevision += 1;
        await this.saveThreadDraft(draft);
        await this.renderDraftCard({
          binding: currentBinding,
          draft,
          replyTargetId,
          note: "Sandbox updated from slash command.",
        });
        return;
      }
      case "approval": {
        const approvalPolicy = args[1] as ApprovalPolicy | undefined;
        if (!approvalPolicy || !APPROVAL_POLICY_VALUES.includes(approvalPolicy)) {
          await this.replyToMessage(
            replyTargetId,
            "Usage: /new approval <untrusted|on-failure|on-request|never>",
          );
          return;
        }

        draft.approvalPolicy = approvalPolicy;
        draft.cardRevision += 1;
        await this.saveThreadDraft(draft);
        await this.renderDraftCard({
          binding: currentBinding,
          draft,
          replyTargetId,
          note: "Approval policy updated from slash command.",
        });
        return;
      }
      case "create": {
        let fallbackNote: string | undefined;
        if (draft.model) {
          const models = await this.options.service.listModels();
          const model = models.find((entry) => entry.id === draft.model || entry.model === draft.model);
          if (!model) {
            await this.replyToMessage(replyTargetId, `Configured model ${draft.model} is no longer available.`);
            return;
          }
          if (draft.effort && !model.supportedReasoningEfforts.includes(draft.effort)) {
            draft.effort = model.defaultReasoningEffort;
            await this.saveThreadDraft(draft);
            fallbackNote = `effort reverted to ${model.defaultReasoningEffort} because ${model.id} no longer supports the previous value.`;
          }
        }

        const executionProfile: TaskExecutionProfile = {
          ...(draft.model ? { model: draft.model } : {}),
          ...(draft.effort ? { effort: draft.effort } : {}),
          ...(draft.planMode ? { planMode: true } : {}),
          sandbox: draft.sandbox,
          approvalPolicy: draft.approvalPolicy,
        };

        const task = await this.options.service.createTask({
          title: createTaskTitleFromDraft(draft),
          executionProfile,
          replyToFeishu: true,
        });
        await this.options.service.bindFeishuThread(task.taskId, currentBinding);
        const attachmentAssetIds = await this.uploadDraftAttachmentsToTask(task.taskId, draft);
        this.deleteThreadDraft(currentBinding);

        let response = [
          `Created task ${task.taskId}.`,
          `title: ${task.title}`,
          ...formatExecutionProfile(executionProfile),
          attachmentAssetIds.length ? `attachmentsQueued: ${attachmentAssetIds.length}` : undefined,
          fallbackNote,
        ]
          .filter(Boolean)
          .join("\n");

        if (draft.prompt?.trim() || attachmentAssetIds.length) {
          void this.options.service
            .sendMessage(task.taskId, {
              content: draft.prompt ?? "",
              assetIds: attachmentAssetIds,
              source: "feishu",
              replyToFeishu: true,
              executionProfile,
            })
            .catch((error) => {
              this.options.logger.warn("failed to queue initial draft prompt from slash create", {
                taskId: task.taskId,
                error,
              });
            });
          response = `${response}\ninitialMessage: queued`;
        } else {
          response = `${response}\nnextStep: send the first plain-text message in this thread to start the first turn`;
        }

        await this.renderTaskControlCard({
          task: this.options.service.getTask(task.taskId) ?? task,
          binding: currentBinding,
          replyTargetId,
          note: response,
        });
        await this.replyToMessage(replyTargetId, response);
        return;
      }
      default:
        await this.replyToMessage(replyTargetId, `Unknown /new subcommand: ${action}\n\n${formatHelpText()}`);
    }
  }

  private async handleCardAction(event?: FeishuCardActionEvent): Promise<FeishuInteractiveCard | void> {
    const action = event?.action;
    const value = action?.value;
    if (!value?.kind) {
      this.options.logger.info("ignoring feishu card action without actionable value", summarizeCardAction(event));
      return;
    }

    const binding: FeishuThreadBinding = {
      chatId: value.chatId,
      threadKey: value.threadKey,
      ...(value.rootMessageId ? { rootMessageId: value.rootMessageId } : {}),
    };

    if (value.kind === "test.ping") {
      return createCardTestCard(`Pong from long connection at ${new Date().toISOString()}.`);
    }

    if (value.kind.startsWith("draft.")) {
      if (value.kind === "draft.cancel") {
        const existingDraft = this.getThreadDraft(binding);
        if (existingDraft?.attachments.length) {
          await Promise.allSettled(existingDraft.attachments.map((attachment) => rm(attachment.localPath, { force: true })));
        }

        const resetDraft: FeishuThreadDraft = {
          ...createDefaultDraft(binding),
          cardMessageId: event?.open_message_id ?? existingDraft?.cardMessageId,
          cardRevision: 1,
        };
        await this.saveThreadDraft(resetDraft);
        return this.renderDraftCard({
          binding,
          draft: resetDraft,
          note: "Draft cancelled. Send plain text in this thread to start a new draft.",
        });
      }

      const draft = this.getThreadDraft(binding) ?? createDefaultDraft(binding);
      if (event?.open_message_id ?? draft.cardMessageId) {
        draft.cardMessageId = event?.open_message_id ?? draft.cardMessageId;
      }

      switch (value.kind) {
        case "draft.use-defaults":
          draft.model = undefined;
          draft.effort = undefined;
          draft.planMode = false;
          draft.sandbox = DEFAULT_NEW_SANDBOX;
          draft.approvalPolicy = DEFAULT_NEW_APPROVAL_POLICY;
          draft.note = "Reset to defaults.";
          break;
        case "draft.select.model": {
          const modelId = action?.option;
          if (!modelId) {
            draft.note = "Model selection was empty.";
            break;
          }
          const models = await this.options.service.listModels();
          const model = models.find((entry) => entry.id === modelId || entry.model === modelId);
          if (!model) {
            draft.note = `Unknown model: ${modelId}`;
            break;
          }
          draft.model = model.id;
          draft.note = `Selected model ${model.id}.`;
          if (draft.effort && !model.supportedReasoningEfforts.includes(draft.effort)) {
            draft.effort = model.defaultReasoningEffort;
            draft.note = `Selected model ${model.id}; effort reverted to ${model.defaultReasoningEffort}.`;
          }
          break;
        }
        case "draft.select.effort": {
          const effort = action?.option as ReasoningEffort | undefined;
          if (!effort || !REASONING_EFFORT_VALUES.includes(effort)) {
            draft.note = "Unsupported reasoning effort.";
            break;
          }
          if (draft.model) {
            const models = await this.options.service.listModels();
            const model = models.find((entry) => entry.id === draft.model || entry.model === draft.model);
            if (!model) {
              draft.note = `Configured model ${draft.model} is no longer available.`;
              break;
            }
            if (!model.supportedReasoningEfforts.includes(effort)) {
              draft.note = `Model ${model.id} does not support effort ${effort}.`;
              break;
            }
          }
          draft.effort = effort;
          draft.note = `Selected effort ${effort}.`;
          break;
        }
        case "draft.toggle.plan-mode":
          draft.planMode = !draft.planMode;
          draft.note = `Plan mode ${draft.planMode ? "enabled" : "disabled"}.`;
          break;
        case "draft.select.sandbox": {
          const sandbox = action?.option as SandboxMode | undefined;
          if (!sandbox || !SANDBOX_MODE_VALUES.includes(sandbox)) {
            draft.note = "Unsupported sandbox mode.";
            break;
          }
          draft.sandbox = sandbox;
          draft.note = `Selected sandbox ${sandbox}.`;
          break;
        }
        case "draft.select.approval": {
          const approvalPolicy = action?.option as ApprovalPolicy | undefined;
          if (!approvalPolicy || !APPROVAL_POLICY_VALUES.includes(approvalPolicy)) {
            draft.note = "Unsupported approval policy.";
            break;
          }
          draft.approvalPolicy = approvalPolicy;
          draft.note = `Selected approval policy ${approvalPolicy}.`;
          break;
        }
        case "draft.create": {
          const executionProfile: TaskExecutionProfile = {
            ...(draft.model ? { model: draft.model } : {}),
            ...(draft.effort ? { effort: draft.effort } : {}),
            ...(draft.planMode ? { planMode: true } : {}),
            sandbox: draft.sandbox,
            approvalPolicy: draft.approvalPolicy,
          };

          const task = await this.options.service.createTask({
            title: createTaskTitleFromDraft(draft),
            executionProfile,
            replyToFeishu: true,
          });
          this.deleteArchivedThread(binding);
          await this.options.service.bindFeishuThread(task.taskId, binding);
          const attachmentAssetIds = await this.uploadDraftAttachmentsToTask(task.taskId, draft);
          this.deleteThreadDraft(binding);

          const boundTask = this.options.service.getTask(task.taskId) ?? task;
          const initialMessageQueued = Boolean(draft.prompt?.trim() || attachmentAssetIds.length);
          const createdTaskNote = formatCreatedTaskNotice(task.taskId, initialMessageQueued);
          const messageId = event?.open_message_id ?? draft.cardMessageId;
          if (messageId) {
            await this.saveThreadTaskCard({
              chatId: binding.chatId,
              threadKey: binding.threadKey,
              rootMessageId: binding.rootMessageId,
              taskId: task.taskId,
              messageId,
              revision: 0,
              note: createdTaskNote,
            });
          }

          if (initialMessageQueued) {
            void this.options.service
              .sendMessage(task.taskId, {
                content: draft.prompt ?? "",
                assetIds: attachmentAssetIds,
                source: "feishu",
                replyToFeishu: true,
                executionProfile,
              })
              .catch((error) => {
                this.options.logger.warn("failed to queue initial draft prompt from card create", {
                  taskId: task.taskId,
                  error,
                });
              });
          }

          return (
            (await this.renderTaskControlCard({
              task: boundTask,
              binding,
              note: createdTaskNote,
            })) ??
            (await this.buildTaskControlCard(
              boundTask,
              binding,
              (this.getThreadTaskCard(binding)?.revision ?? 0) + 1,
              createdTaskNote,
            ))
          );
        }
        default:
          draft.note = `Unsupported draft action ${value.kind}.`;
      }

      draft.cardRevision += 1;
      await this.saveThreadDraft(draft);
      return this.renderDraftCard({
        binding,
        draft,
        note: draft.note,
      });
    }

    const task =
      (value.taskId && this.options.service.getTask(value.taskId)) ??
      this.options.service.findTaskByFeishuBinding(
        binding.chatId,
        [binding.threadKey, binding.rootMessageId].filter(Boolean) as string[],
      );
    if (!task) {
      const archivedThread = this.getArchivedThread(binding);
      if (archivedThread) {
        return this.renderArchivedThreadCard({
          binding,
          taskId: archivedThread.taskId,
          taskTitle: archivedThread.taskTitle,
          archivedAt: archivedThread.archivedAt,
          messageId: event?.open_message_id,
          note: formatArchivedThreadNotice(archivedThread.taskId),
        });
      }

      const existingDraft = this.getThreadDraft(binding);
      const fallbackDraft: FeishuThreadDraft = {
        ...createDefaultDraft(binding),
        cardMessageId: event?.open_message_id ?? existingDraft?.cardMessageId,
        cardRevision: 1,
      };
      await this.saveThreadDraft(fallbackDraft);
      return this.renderDraftCard({
        binding,
        draft: fallbackDraft,
        note: "No bound task was found for this card.",
      });
    }

    const currentCard = this.getThreadTaskCard(binding);
    const revision = (currentCard?.revision ?? 0) + 1;
    let note = currentCard?.note;

    switch (value.kind) {
      case "task.select.model": {
        const modelId = action?.option ?? "";
        const models = await this.options.service.listModels();
        const model = modelId ? models.find((entry) => entry.id === modelId || entry.model === modelId) : null;
        if (modelId && !model) {
          note = `Unknown model: ${modelId}`;
          break;
        }

        const nextProfile: TaskExecutionProfile = {
          ...(model ? { model: model.id } : {}),
          ...(task.executionProfile.effort ? { effort: task.executionProfile.effort } : {}),
          ...(task.executionProfile.planMode ? { planMode: true } : {}),
          ...(task.executionProfile.sandbox ? { sandbox: task.executionProfile.sandbox } : {}),
          ...(task.executionProfile.approvalPolicy ? { approvalPolicy: task.executionProfile.approvalPolicy } : {}),
        };

        if (model && nextProfile.effort && !model.supportedReasoningEfforts.includes(nextProfile.effort)) {
          nextProfile.effort = model.defaultReasoningEffort;
          note = `Selected model ${model.id}; effort reverted to ${model.defaultReasoningEffort}.`;
        } else {
          note = model ? `Selected model ${model.id}.` : "Reverted to runtime-default model.";
        }

        await this.options.service.updateTaskSettings(task.taskId, {
          executionProfile: nextProfile,
        });
        break;
      }
      case "task.select.effort": {
        const rawEffort = action?.option ?? "";
        const effort = rawEffort as ReasoningEffort | "";
        if (effort && !REASONING_EFFORT_VALUES.includes(effort)) {
          note = "Unsupported reasoning effort.";
          break;
        }

        const modelId = task.executionProfile.model;
        if (modelId && effort) {
          const models = await this.options.service.listModels();
          const model = models.find((entry) => entry.id === modelId || entry.model === modelId);
          if (!model) {
            note = `Configured model ${modelId} is no longer available.`;
            break;
          }
          if (!model.supportedReasoningEfforts.includes(effort)) {
            note = `Model ${model.id} does not support effort ${effort}.`;
            break;
          }
        }

        await this.options.service.updateTaskSettings(task.taskId, {
          executionProfile: {
            ...(task.executionProfile.model ? { model: task.executionProfile.model } : {}),
            ...(effort ? { effort } : {}),
            ...(task.executionProfile.planMode ? { planMode: true } : {}),
            ...(task.executionProfile.sandbox ? { sandbox: task.executionProfile.sandbox } : {}),
            ...(task.executionProfile.approvalPolicy ? { approvalPolicy: task.executionProfile.approvalPolicy } : {}),
          },
        });
        note = effort ? `Selected effort ${effort}.` : "Reverted to model-default effort.";
        break;
      }
      case "task.toggle.plan-mode":
        {
        const nextPlanMode = !task.executionProfile.planMode;
        await this.options.service.updateTaskSettings(task.taskId, {
          executionProfile: {
            ...(task.executionProfile.model ? { model: task.executionProfile.model } : {}),
            ...(task.executionProfile.effort ? { effort: task.executionProfile.effort } : {}),
            ...(nextPlanMode ? { planMode: true } : {}),
            ...(task.executionProfile.sandbox ? { sandbox: task.executionProfile.sandbox } : {}),
            ...(task.executionProfile.approvalPolicy ? { approvalPolicy: task.executionProfile.approvalPolicy } : {}),
          },
        });
        note = `Plan mode ${nextPlanMode ? "enabled" : "disabled"}.`;
        break;
        }
      case "task.toggle.feishu-running-mode": {
        const nextMode = task.feishuRunningMessageMode === "queue" ? "steer" : "queue";
        await this.options.service.updateTaskSettings(task.taskId, {
          feishuRunningMessageMode: nextMode,
        });
        note =
          nextMode === "queue"
            ? "Feishu messages sent during a running turn will now queue for the next turn."
            : "Feishu messages sent during a running turn will now steer the active turn immediately.";
        break;
      }
      case "task.status":
        note = formatTaskSummary(task);
        break;
      case "task.interrupt":
        await this.options.service.interruptTask(task.taskId);
        note = `Interrupted task ${task.taskId}.`;
        break;
      case "task.retry":
        await this.options.service.sendMessage(task.taskId, {
          content: "Retry the last turn and continue.",
          source: "feishu",
          replyToFeishu: true,
        });
        note = `Queued retry for task ${task.taskId}.`;
        break;
      case "task.archive": {
        const archivedAt = new Date().toISOString();
        await this.options.service.unbindFeishuThread(task.taskId);
        this.deleteThreadDraft(binding);
        await this.saveArchivedThread({
          chatId: binding.chatId,
          threadKey: binding.threadKey,
          rootMessageId: binding.rootMessageId,
          taskId: task.taskId,
          taskTitle: task.title,
          archivedAt,
        });
        this.deleteThreadTaskCard(binding);
        return this.renderArchivedThreadCard({
          binding,
          taskId: task.taskId,
          taskTitle: task.title,
          archivedAt,
          messageId: event?.open_message_id ?? currentCard?.messageId,
          note: "Archived this topic. Continue the host task from VSCode or CLI, or start a new Feishu topic for more work.",
        });
      }
      case "task.approve":
      case "task.decline":
      case "task.cancel-approval": {
        const decision =
          value.kind === "task.approve" ? "accept" : value.kind === "task.decline" ? "decline" : "cancel";
        const approval =
          task.pendingApprovals.find((entry) => entry.requestId === value.requestId && entry.state === "pending") ??
          task.pendingApprovals.find((entry) => entry.state === "pending");
        if (!approval) {
          note = "No pending approval is available.";
          break;
        }
        await this.options.service.resolveApproval(task.taskId, approval.requestId, decision);
        note = `Approval ${approval.requestId} resolved as ${decision}.`;
        break;
      }
      case "task.unbind":
        await this.options.service.unbindFeishuThread(task.taskId);
        this.deleteThreadTaskCard(binding);
        {
          const resetDraft: FeishuThreadDraft = {
            ...createDefaultDraft(binding),
            cardMessageId: event?.open_message_id ?? currentCard?.messageId,
            cardRevision: 1,
          };
          await this.saveThreadDraft(resetDraft);
          return this.renderDraftCard({
            binding,
            draft: resetDraft,
            note: `Thread unbound from ${task.taskId}. Send plain text to start a new draft.`,
          });
        }
      case "task.inspect.global": {
        const snapshot = this.options.service.getSnapshot();
        switch (action?.option) {
          case "tasks":
            note = formatTaskList(this.options.service.listTasks(), task.taskId);
            break;
          case "task":
            note = formatTaskSummary(task);
            break;
          case "health":
            note = formatHealthSummary(this.options.config, snapshot, this.enabled);
            break;
          case "account":
            note = formatAccountSummary(snapshot);
            break;
          case "limits":
            note = formatRateLimitSummary(snapshot);
            break;
          default:
            note = "Select one of Task, Tasks, Health, Account, or Limits.";
        }
        break;
      }
      default:
        note = `Unsupported card action ${value.kind}.`;
        break;
    }

    if (event?.open_message_id ?? currentCard?.messageId) {
      await this.saveThreadTaskCard({
        chatId: binding.chatId,
        threadKey: binding.threadKey,
        rootMessageId: binding.rootMessageId,
        taskId: task.taskId,
        messageId: event?.open_message_id ?? currentCard?.messageId ?? "",
        revision: currentCard?.revision ?? 0,
        note: currentCard?.note,
      });
    }

    const nextTask = this.options.service.getTask(task.taskId) ?? task;
    return (
      (await this.renderTaskControlCard({
        task: nextTask,
        binding,
        note,
      })) ??
      (await this.buildTaskControlCard(nextTask, binding, revision, note))
    );
  }

  private async startLongConnection(): Promise<void> {
    if (!this.hasLongConnectionConfig()) {
      return;
    }

    if (this.longConnectionHandle) {
      return;
    }

    try {
      this.longConnectionHandle = await this.longConnectionFactory!({
        config: this.options.config,
        logger: this.options.logger,
        onMessage: async (message, sender) => {
          const dedupeId =
            message?.message_id ?? message?.root_id ?? message?.parent_id ?? sender?.sender_id?.open_id;
          if (dedupeId && this.processedEventIds.has(dedupeId)) {
            this.options.logger.info("deduped feishu long-connection message", {
              ...summarizeIncomingMessage(message, sender),
              dedupeId,
            });
            return;
          }

          await this.handleIncomingMessage(message, sender);

          if (dedupeId) {
            this.processedEventIds.add(dedupeId);
            await this.persistState();
          }
        },
        onCardAction: async (event) => {
          const dedupeId = buildCardActionDedupeId(event);
          if (this.processedEventIds.has(dedupeId)) {
            this.options.logger.info("deduped feishu long-connection card action", summarizeCardAction(event));
            return;
          }

          try {
            this.options.logger.info("received feishu long-connection card action", summarizeCardAction(event));
            const nextCard = await this.handleCardAction(event);
            this.processedEventIds.add(dedupeId);
            await this.persistState();
            return nextCard;
          } catch (error) {
            this.options.logger.warn("failed to process feishu long-connection card action", {
              action: summarizeCardAction(event),
              error,
            });
            throw error;
          }
        },
      });
    } catch (error) {
      this.options.logger.warn("failed to start feishu long connection", error);
    }
  }

  private verifyToken(body: { token?: string; header?: { token?: string } }): boolean {
    const expected = this.options.config.feishuVerificationToken;
    if (!expected) {
      return true;
    }

    return body.token === expected || body.header?.token === expected;
  }

  private verifySignature(rawBody: string, headers: FeishuWebhookHeaders): boolean {
    const encryptKey = this.options.config.feishuEncryptKey;
    if (!encryptKey) {
      return true;
    }

    if (!headers.signature || !headers.timestamp || !headers.nonce) {
      return false;
    }

    const base = `${headers.timestamp}${headers.nonce}${encryptKey}${rawBody}`;
    const expected = createHmac("sha256", encryptKey).update(base).digest("base64");
    return expected === headers.signature;
  }

  private async sendChatMessage(chatId: string, text: string): Promise<string> {
    const response = await this.requestFeishu<FeishuSendMessageResponse>(
      `/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: truncateReplyText(text) }),
        }),
      },
    );
    return response.message_id;
  }

  private async replyToMessage(messageId: string, text: string): Promise<string> {
    const response = await this.requestFeishu<FeishuSendMessageResponse>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({
          msg_type: "text",
          reply_in_thread: true,
          content: JSON.stringify({ text: truncateReplyText(text) }),
        }),
      },
    );
    return response.message_id;
  }

  private async requestFeishu<T>(pathname: string, init: RequestInit): Promise<T> {
    const accessToken = await this.getTenantAccessToken();
    const url = new URL(pathname, this.options.config.feishuBaseUrl);
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=utf-8",
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new Error(`Feishu API failed (${response.status}): ${await response.text()}`);
    }

    const body = (await response.json()) as FeishuApiResponse<T>;
    if (body.code !== 0) {
      throw new Error(`Feishu API error ${body.code}: ${body.msg ?? "unknown error"}`);
    }

    return body.data;
  }

  private async requestFeishuBinary(pathname: string, init?: RequestInit): Promise<{
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
  }> {
    const accessToken = await this.getTenantAccessToken();
    const url = new URL(pathname, this.options.config.feishuBaseUrl);
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new Error(`Feishu API failed (${response.status}): ${await response.text()}`);
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
      fileName: fileNameFromContentDisposition(response.headers.get("content-disposition")),
    };
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tenantAccessToken && Date.now() < this.tenantAccessTokenExpiresAt) {
      return this.tenantAccessToken;
    }

    const response = await fetch(new URL("/open-apis/auth/v3/tenant_access_token/internal", this.options.config.feishuBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: this.options.config.feishuAppId,
        app_secret: this.options.config.feishuAppSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to obtain Feishu tenant token (${response.status})`);
    }

    const body = (await response.json()) as FeishuTenantTokenResponse;
    if (body.code !== 0) {
      throw new Error(`Feishu auth error ${body.code}: ${body.msg ?? "unknown error"}`);
    }

    this.tenantAccessToken = body.tenant_access_token;
    this.tenantAccessTokenExpiresAt = Date.now() + body.expire * 1000 - 60_000;
    return this.tenantAccessToken;
  }

  private async persistState(): Promise<void> {
    await writeJsonFile(this.stateFile, {
      processedEventIds: [...this.processedEventIds].slice(-200),
      drafts: [...this.threadDrafts.values()],
      taskCards: [...this.threadTaskCards.values()],
      archivedThreads: [...this.archivedThreads.values()],
    } satisfies PersistedFeishuState);
  }
}
