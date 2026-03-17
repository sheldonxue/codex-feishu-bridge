import { createHmac } from "node:crypto";
import path from "node:path";

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

function createSummary(task: ReturnType<BridgeService["getTask"]>, event: BridgeServiceEvent["event"]): string {
  if (!task) {
    return `Bridge event ${event.kind} was received, but the task snapshot is no longer available.`;
  }

  const headline = `[${task.title}] status=${task.status} mode=${task.mode}`;
  const extras = [
    task.latestSummary ? `summary: ${task.latestSummary}` : undefined,
    task.pendingApprovals.length > 0 ? `pending approvals: ${task.pendingApprovals.length}` : undefined,
    task.diffs.length > 0 ? `diffs: ${task.diffs.length}` : undefined,
    task.conversation.length > 0 ? `messages: ${task.conversation.length}` : undefined,
  ].filter(Boolean);

  return [headline, `event: ${event.kind}`, ...extras].join("\n");
}

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
  return {
    command: tokens[0]?.toLowerCase() ?? "",
    args: tokens.slice(1),
  };
}

export class FeishuBridge {
  private readonly stateFile: string;
  private readonly processedEventIds = new Set<string>();
  private serviceUnsubscribe: (() => void) | null = null;
  private tenantAccessToken?: string;
  private tenantAccessTokenExpiresAt = 0;
  private subscribed = false;
  private longConnectionHandle: LongConnectionHandle | null = null;
  private readonly longConnectionFactory?: LongConnectionFactory;

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
    });
    for (const eventId of persisted.processedEventIds.slice(-200)) {
      this.processedEventIds.add(eventId);
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

    if (
      ![
        "task.created",
        "task.resumed",
        "task.failed",
        "task.interrupted",
        "task.updated",
        "task.diff.updated",
        "approval.requested",
        "approval.resolved",
        "task.image.added",
        "task.message.sent",
        "task.steered",
      ].includes(event.kind)
    ) {
      return;
    }

    const task = this.options.service.getTask(event.taskId);
    if (!task) {
      return;
    }

    if (!task.feishuBinding) {
      const rootMessageId = await this.sendChatMessage(
        this.options.config.feishuDefaultChatId!,
        `Task created\n${createSummary(task, event)}`,
      );
      await this.options.service.bindFeishuThread(task.taskId, {
        chatId: this.options.config.feishuDefaultChatId!,
        threadKey: rootMessageId,
        rootMessageId,
      });
      return;
    }

    if (event.kind === "task.updated" && !(event.payload as { item?: { type?: string } })?.item?.type) {
      return;
    }

    await this.replyToMessage(task.feishuBinding.rootMessageId ?? task.feishuBinding.threadKey, createSummary(task, event));
  }

  private async handleIncomingMessage(
    message:
      | FeishuIncomingMessage
      | undefined,
    sender:
      | FeishuIncomingSender
      | undefined,
  ): Promise<void> {
    if (!message || message.message_type !== "text") {
      return;
    }

    const lookupId = message.root_id ?? message.parent_id ?? message.thread_id ?? message.message_id;
    if (!lookupId) {
      return;
    }

    const task = this.options
      .service
      .listTasks()
      .find((candidate) => candidate.feishuBinding?.rootMessageId === lookupId || candidate.feishuBinding?.threadKey === lookupId);
    if (!task) {
      return;
    }

    const actorId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.sender_id?.union_id ?? "unknown";
    const text = parseTextContent(message.content);
    const { command, args } = normalizeCommand(text);

    switch (command) {
      case "interrupt":
        await this.options.service.interruptTask(task.taskId);
        break;
      case "retry":
        await this.options.service.sendMessage(task.taskId, {
          content: args.join(" ") || "Retry the last turn and continue.",
        });
        break;
      case "approve":
      case "decline":
      case "cancel": {
        const decision = command === "approve" ? "accept" : command;
        const requestId = args[0];
        const approval =
          task.pendingApprovals.find((entry) => entry.requestId === requestId && entry.state === "pending") ??
          task.pendingApprovals.find((entry) => entry.state === "pending");
        if (approval) {
          await this.options.service.resolveApproval(task.taskId, approval.requestId, decision);
        } else {
          await this.replyToMessage(
            task.feishuBinding?.rootMessageId ?? lookupId,
            `No pending approval was found for ${task.title}.`,
          );
        }
        break;
      }
      default:
        await this.options.service.sendMessage(task.taskId, {
          content: text || `Message from ${actorId}`,
        });
        break;
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
          content: JSON.stringify({ text }),
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
          content: JSON.stringify({ text }),
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
    } satisfies PersistedFeishuState);
  }
}
