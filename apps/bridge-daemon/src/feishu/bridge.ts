import { createHmac } from "node:crypto";
import path from "node:path";

import type {
  ApprovalPolicy,
  BridgeTask,
  FeishuThreadBinding,
  ReasoningEffort,
  SandboxMode,
  TaskExecutionProfile,
} from "@codex-feishu-bridge/protocol";
import { readJsonFile, writeJsonFile, type BridgeConfig, type Logger } from "@codex-feishu-bridge/shared";

import { BridgeService, type BridgeServiceEvent } from "../service/bridge-service";

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
}

interface FeishuThreadDraft {
  chatId: string;
  threadKey: string;
  rootMessageId?: string;
  prompt?: string;
  model?: string;
  effort?: ReasoningEffort;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
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

export interface LongConnectionHandle {
  stop: () => Promise<void> | void;
}

export type LongConnectionFactory = (params: {
  onMessage: (message?: FeishuIncomingMessage, sender?: FeishuIncomingSender) => Promise<void>;
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
]);
const REASONING_EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
const SANDBOX_MODE_VALUES = ["read-only", "workspace-write", "danger-full-access"] as const;
const APPROVAL_POLICY_VALUES = ["untrusted", "on-failure", "on-request", "never"] as const;
const DEFAULT_NEW_SANDBOX: SandboxMode = "workspace-write";
const DEFAULT_NEW_APPROVAL_POLICY: ApprovalPolicy = "on-request";

function parseTextContent(rawContent: string | undefined): string {
  if (!rawContent) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawContent) as { text?: string };
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
    sandbox: DEFAULT_NEW_SANDBOX,
    approvalPolicy: DEFAULT_NEW_APPROVAL_POLICY,
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
    `sandbox: ${profile?.sandbox ?? DEFAULT_NEW_SANDBOX}`,
    `approvalPolicy: ${profile?.approvalPolicy ?? DEFAULT_NEW_APPROVAL_POLICY}`,
  ];
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
    `messages: ${task.conversation.length}`,
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
    `sandbox: ${draft.sandbox}`,
    `approvalPolicy: ${draft.approvalPolicy}`,
    "",
    "Next steps:",
    "/new prompt <text>",
    "/new models",
    "/new model <model-id>",
    "/new effort <none|minimal|low|medium|high|xhigh>",
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

function formatApprovalRequested(task: BridgeTask, approval: BridgeTask["pendingApprovals"][number]): string {
  return [
    `Approval requested for ${task.title}`,
    `requestId: ${approval.requestId}`,
    `kind: ${approval.kind}`,
    `reason: ${approval.reason}`,
    "Use /approve, /decline, or /cancel.",
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

export class FeishuBridge {
  private readonly stateFile: string;
  private readonly processedEventIds = new Set<string>();
  private readonly threadDrafts = new Map<string, FeishuThreadDraft>();
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
    });
    for (const eventId of persisted.processedEventIds.slice(-200)) {
      this.processedEventIds.add(eventId);
    }
    for (const draft of persisted.drafts ?? []) {
      this.threadDrafts.set(draftStorageKey(draft), draft);
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

    const syncedAgentReply = this.extractAgentReply(event);
    if (syncedAgentReply) {
      await this.replyToMessage(
        task.feishuBinding.rootMessageId ?? task.feishuBinding.threadKey,
        syncedAgentReply,
      );
      return;
    }

    switch (event.kind) {
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
        await this.replyToMessage(
          task.feishuBinding.rootMessageId ?? task.feishuBinding.threadKey,
          formatApprovalRequested(task, approval),
        );
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
        return;
      }
      case "task.failed":
        await this.replyToMessage(
          task.feishuBinding.rootMessageId ?? task.feishuBinding.threadKey,
          formatTaskFailure(task, event.payload),
        );
        return;
      default:
        return;
    }
  }

  private extractAgentReply(event: BridgeServiceEvent["event"]): string | null {
    if (event.kind !== "task.updated") {
      return null;
    }

    const payload = event.payload as {
      item?: {
        id?: string;
        type?: string;
        text?: string;
      };
    };
    const item = payload.item;
    if (!item || item.type !== "agentMessage" || !item.id || !item.text?.trim()) {
      return null;
    }

    if (this.deliveredAgentMessageIds.has(item.id)) {
      return null;
    }

    this.deliveredAgentMessageIds.add(item.id);
    if (this.deliveredAgentMessageIds.size > FEISHU_SYNCED_AGENT_MESSAGE_LIMIT) {
      const oldest = this.deliveredAgentMessageIds.values().next().value;
      if (oldest) {
        this.deliveredAgentMessageIds.delete(oldest);
      }
    }

    return item.text.trim();
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

    if (message.message_type !== "text") {
      this.options.logger.info("ignoring non-text feishu message", summary);
      return;
    }

    const lookupIds = collectLookupIds(message);
    const lookupId = lookupIds[0];
    if (!lookupId) {
      this.options.logger.info("ignoring feishu incoming text without lookup id", summary);
      return;
    }

    const actorId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.sender_id?.union_id ?? "unknown";
    const text = parseTextContent(message.content);
    const { command, args } = normalizeCommand(text);
    const slashCommand = isSlashCommand(text);
    const replyTargetId = message.message_id ?? message.root_id ?? message.parent_id ?? message.thread_id ?? lookupId;
    const currentBinding = buildBindingFromMessage(message);
    const task = this.options.service.findTaskByFeishuBinding(message.chat_id, lookupIds);

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
      await this.replyToMessage(replyTargetId, formatHelpText());
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

      this.deleteThreadDraft(currentBinding);
      const reboundTask = await this.options.service.bindFeishuThread(targetTaskId, currentBinding);
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
        await this.replyToMessage(replyTargetId, `${command} applied to approval ${approval.requestId}.`);
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

    this.threadDrafts.delete(draftStorageKey(binding));
    void this.persistState();
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
      await this.replyToMessage(replyTargetId, formatDraftSummary(draft));
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
        await this.saveThreadDraft(draft);
        await this.replyToMessage(replyTargetId, formatDraftSummary(draft));
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

        await this.saveThreadDraft(draft);
        await this.replyToMessage(
          replyTargetId,
          [formatDraftSummary(draft), fallbackNote].filter(Boolean).join("\n\n"),
        );
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
        await this.saveThreadDraft(draft);
        await this.replyToMessage(replyTargetId, formatDraftSummary(draft));
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
        await this.saveThreadDraft(draft);
        await this.replyToMessage(replyTargetId, formatDraftSummary(draft));
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
        await this.saveThreadDraft(draft);
        await this.replyToMessage(replyTargetId, formatDraftSummary(draft));
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
          sandbox: draft.sandbox,
          approvalPolicy: draft.approvalPolicy,
        };

        const task = await this.options.service.createTask({
          title: createTaskTitleFromDraft(draft),
          executionProfile,
        });
        await this.options.service.bindFeishuThread(task.taskId, currentBinding);
        this.deleteThreadDraft(currentBinding);

        let response = [
          `Created task ${task.taskId}.`,
          `title: ${task.title}`,
          ...formatExecutionProfile(executionProfile),
          fallbackNote,
        ]
          .filter(Boolean)
          .join("\n");

        if (draft.prompt?.trim()) {
          await this.options.service.sendMessage(task.taskId, {
            content: draft.prompt,
          });
          response = `${response}\nfirstPrompt: queued`;
        }

        await this.replyToMessage(replyTargetId, response);
        return;
      }
      default:
        await this.replyToMessage(replyTargetId, `Unknown /new subcommand: ${action}\n\n${formatHelpText()}`);
    }
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
    } satisfies PersistedFeishuState);
  }
}
