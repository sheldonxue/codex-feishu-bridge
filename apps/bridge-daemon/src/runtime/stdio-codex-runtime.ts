import type { BridgeConfig, Logger } from "@codex-feishu-bridge/shared";

import { JsonRpcStdioClient } from "./json-rpc-stdio-client";
import type {
  CodexAccountSnapshot,
  CodexApprovalPolicy,
  CodexInputItem,
  CodexLoginStartParams,
  CodexLoginStartResult,
  CodexModelDescriptor,
  CodexReasoningEffort,
  CodexRateLimitSnapshot,
  CodexRuntime,
  CodexRuntimeHealth,
  CodexRuntimeNotification,
  CodexSandboxMode,
  CodexTurnDescriptor,
  CodexThreadDescriptor,
} from "./types";

interface RawCodexTurnDescriptor {
  id: string;
  status: CodexTurnDescriptor["status"];
  items?: CodexTurnDescriptor["items"];
  error?: CodexTurnDescriptor["error"] | null;
}

interface RawCodexThreadDescriptor {
  id: string;
  name?: string | null;
  cwd?: string | null;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
  status?: unknown;
}

interface RawCodexModelDescriptor {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts?: Array<{
    reasoningEffort?: CodexReasoningEffort;
  }>;
  defaultReasoningEffort: CodexReasoningEffort;
}

function normalizeTimestamp(value: string | number | null | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return new Date(Number(trimmed) * 1000).toISOString();
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString();
}

function normalizeThreadDescriptor(thread: RawCodexThreadDescriptor): CodexThreadDescriptor {
  return {
    id: thread.id,
    name: thread.name ?? null,
    cwd: thread.cwd ?? null,
    createdAt: normalizeTimestamp(thread.createdAt),
    updatedAt: normalizeTimestamp(thread.updatedAt),
    status: thread.status,
  };
}

function normalizeTurnDescriptor(
  turn: RawCodexTurnDescriptor,
  threadId?: string,
): CodexTurnDescriptor {
  return {
    id: turn.id,
    threadId,
    status: turn.status,
    items: turn.items ?? [],
    error: turn.error?.message ? { message: turn.error.message } : undefined,
  };
}

function normalizeModelDescriptor(model: RawCodexModelDescriptor): CodexModelDescriptor {
  return {
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    isDefault: model.isDefault,
    supportedReasoningEfforts: (model.supportedReasoningEfforts ?? [])
      .map((entry) => entry.reasoningEffort)
      .filter((value): value is CodexReasoningEffort => Boolean(value)),
    defaultReasoningEffort: model.defaultReasoningEffort,
  };
}

export class StdioCodexRuntime implements CodexRuntime {
  readonly backend = "stdio";
  private readonly client: JsonRpcStdioClient;

  constructor(
    private readonly config: BridgeConfig,
    logger: Logger,
  ) {
    this.client = new JsonRpcStdioClient(config, logger);
  }

  async start(): Promise<void> {
    await this.client.start();
  }

  async health(): Promise<CodexRuntimeHealth> {
    return {
      backend: this.backend,
      connected: true,
      initialized: this.client.isInitialized(),
    };
  }

  async loginStart(params: CodexLoginStartParams): Promise<CodexLoginStartResult> {
    return this.client.request<CodexLoginStartResult>("account/login/start", params);
  }

  async readAccount(refreshToken = false): Promise<CodexAccountSnapshot> {
    return this.client.request<CodexAccountSnapshot>("account/read", { refreshToken });
  }

  async readRateLimits(): Promise<CodexRateLimitSnapshot> {
    return this.client.request<CodexRateLimitSnapshot>("account/rateLimits/read");
  }

  async listModels(): Promise<CodexModelDescriptor[]> {
    const response = await this.client.request<{ data?: RawCodexModelDescriptor[]; models?: RawCodexModelDescriptor[] }>(
      "model/list",
      {},
    );
    return (response.data ?? response.models ?? []).map(normalizeModelDescriptor);
  }

  async startThread(params: {
    cwd: string;
    title?: string;
    model?: string;
    approvalPolicy?: CodexApprovalPolicy;
    sandbox?: CodexSandboxMode;
  }): Promise<CodexThreadDescriptor> {
    const response = await this.client.request<{ thread: RawCodexThreadDescriptor }>("thread/start", {
      cwd: params.cwd,
      serviceName: "codex_feishu_bridge",
      ...(params.title ? { title: params.title } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
      ...(params.sandbox ? { sandbox: params.sandbox } : {}),
    });
    return normalizeThreadDescriptor(response.thread);
  }

  async listThreads(): Promise<CodexThreadDescriptor[]> {
    const response = await this.client.request<{
      data?: RawCodexThreadDescriptor[];
      threads?: RawCodexThreadDescriptor[];
    }>("thread/list", {});
    return (response.data ?? response.threads ?? []).map(normalizeThreadDescriptor);
  }

  async readThread(threadId: string): Promise<CodexThreadDescriptor | null> {
    const response = await this.client.request<{ thread: RawCodexThreadDescriptor | null }>("thread/read", {
      threadId,
      includeTurns: false,
    });
    return response.thread ? normalizeThreadDescriptor(response.thread) : null;
  }

  async resumeThread(threadId: string): Promise<CodexThreadDescriptor> {
    const response = await this.client.request<{ thread: RawCodexThreadDescriptor }>("thread/resume", {
      threadId,
    });
    return normalizeThreadDescriptor(response.thread);
  }

  async startTurn(params: {
    threadId: string;
    input: CodexInputItem[];
    model?: string;
    effort?: CodexReasoningEffort;
    approvalPolicy?: CodexApprovalPolicy;
  }): Promise<CodexTurnDescriptor> {
    const response = await this.client.request<{ turn: RawCodexTurnDescriptor }>("turn/start", params);
    return normalizeTurnDescriptor(response.turn, params.threadId);
  }

  async steerTurn(params: { threadId: string; turnId: string; input: CodexInputItem[] }): Promise<{ turnId: string }> {
    return this.client.request<{ turnId: string }>("turn/steer", {
      threadId: params.threadId,
      expectedTurnId: params.turnId,
      input: params.input,
    });
  }

  async interruptTurn(params: { threadId: string; turnId?: string }): Promise<void> {
    await this.client.request("turn/interrupt", params);
  }

  async respondToRequest(requestId: number | string, result: unknown): Promise<void> {
    this.client.respond(requestId, result);
  }

  async dispose(): Promise<void> {
    await this.client.stop();
  }

  onNotification(listener: (notification: CodexRuntimeNotification) => void): () => void {
    return this.client.onNotification((notification) =>
      listener(this.normalizeNotification(notification)),
    );
  }

  private normalizeNotification(notification: {
    method: string;
    params?: unknown;
    id?: number | string;
  }): CodexRuntimeNotification {
    if (notification.method === "thread/started") {
      const params = notification.params as { thread?: RawCodexThreadDescriptor } | undefined;
      return {
        method: notification.method,
        params: params?.thread
          ? {
              ...params,
              thread: normalizeThreadDescriptor(params.thread),
            }
          : notification.params,
        requestId: notification.id,
      };
    }

    if (notification.method === "turn/started" || notification.method === "turn/completed") {
      const params = notification.params as
        | {
            threadId?: string;
            turn?: RawCodexTurnDescriptor;
          }
        | undefined;
      return {
        method: notification.method,
        params:
          params?.turn && params.threadId
            ? {
                ...params,
                turn: normalizeTurnDescriptor(params.turn, params.threadId),
              }
            : notification.params,
        requestId: notification.id,
      };
    }

    return {
      method: notification.method,
      params: notification.params,
      requestId: notification.id,
    };
  }
}
