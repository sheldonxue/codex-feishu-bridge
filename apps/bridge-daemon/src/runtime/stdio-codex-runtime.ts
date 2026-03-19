import type { BridgeConfig, Logger } from "@codex-feishu-bridge/shared";

import {
  normalizeModelDescriptor,
  normalizeRuntimeNotification,
  normalizeThreadDescriptor,
  normalizeTurnDescriptor,
  type RawCodexModelDescriptor,
  type RawCodexThreadDescriptor,
  type RawCodexTurnDescriptor,
} from "./json-rpc-codex-runtime-shared";
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
    sandbox?: CodexSandboxMode;
    planMode?: boolean;
  }): Promise<CodexTurnDescriptor> {
    const response = await this.client.request<{ turn: RawCodexTurnDescriptor }>("turn/start", {
      threadId: params.threadId,
      input: params.input,
      ...(params.model ? { model: params.model } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
      ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
      ...(params.sandbox ? { sandbox: params.sandbox } : {}),
      ...(params.planMode ? { plan_mode: true } : {}),
    });
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
    return this.client.onNotification((notification) => listener(normalizeRuntimeNotification(notification)));
  }
}
