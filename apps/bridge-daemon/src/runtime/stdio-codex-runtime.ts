import type { BridgeConfig, Logger } from "@codex-feishu-bridge/shared";

import { JsonRpcStdioClient } from "./json-rpc-stdio-client";
import type {
  CodexAccountSnapshot,
  CodexInputItem,
  CodexLoginStartParams,
  CodexLoginStartResult,
  CodexRateLimitSnapshot,
  CodexRuntime,
  CodexRuntimeHealth,
  CodexRuntimeNotification,
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

  async startThread(params: { cwd: string; title?: string }): Promise<CodexThreadDescriptor> {
    const response = await this.client.request<{ thread: CodexThreadDescriptor }>("thread/start", {
      cwd: params.cwd,
      serviceName: "codex_feishu_bridge",
      ...(params.title ? { title: params.title } : {}),
    });
    return response.thread;
  }

  async listThreads(): Promise<CodexThreadDescriptor[]> {
    const response = await this.client.request<{ threads: CodexThreadDescriptor[] }>("thread/list");
    return response.threads;
  }

  async readThread(threadId: string): Promise<CodexThreadDescriptor | null> {
    const response = await this.client.request<{ thread: CodexThreadDescriptor | null }>("thread/read", {
      threadId,
      includeTurns: false,
    });
    return response.thread;
  }

  async resumeThread(threadId: string): Promise<CodexThreadDescriptor> {
    const response = await this.client.request<{ thread: CodexThreadDescriptor }>("thread/resume", {
      threadId,
    });
    return response.thread;
  }

  async startTurn(params: { threadId: string; input: CodexInputItem[] }): Promise<CodexTurnDescriptor> {
    const response = await this.client.request<{ turn: CodexTurnDescriptor }>("turn/start", params);
    return response.turn;
  }

  async steerTurn(params: { threadId: string; turnId: string; input: CodexInputItem[] }): Promise<{ turnId: string }> {
    return this.client.request<{ turnId: string }>("turn/steer", params);
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
      listener({
        method: notification.method,
        params: notification.params,
        requestId: notification.id,
      }),
    );
  }
}
