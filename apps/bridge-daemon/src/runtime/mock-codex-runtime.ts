import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import type { BridgeConfig, Logger } from "@codex-feishu-bridge/shared";

import type {
  CodexAccountSnapshot,
  CodexLoginStartParams,
  CodexLoginStartResult,
  CodexRateLimitSnapshot,
  CodexRuntime,
  CodexRuntimeHealth,
  CodexRuntimeNotification,
  CodexThreadDescriptor,
} from "./types";

export class MockCodexRuntime implements CodexRuntime {
  readonly backend = "mock";

  private readonly emitter = new EventEmitter();
  private readonly threads = new Map<string, CodexThreadDescriptor>();
  private account: CodexAccountSnapshot = {
    account: null,
    requiresOpenaiAuth: true,
  };

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.logger.info("mock codex runtime started");
  }

  async health(): Promise<CodexRuntimeHealth> {
    return {
      backend: this.backend,
      connected: true,
      initialized: true,
    };
  }

  async loginStart(params: CodexLoginStartParams): Promise<CodexLoginStartResult> {
    const loginId = params.type === "chatgpt" ? randomUUID() : null;
    const result: CodexLoginStartResult = {
      type: params.type,
      loginId,
      authUrl:
        params.type === "chatgpt"
          ? `https://chatgpt.com/mock-auth?login_id=${loginId}`
          : undefined,
    };

    this.emitNotification("auth.login.started", result);

    if (this.config.mockAutoCompleteLogin) {
      this.account = {
        account:
          params.type === "chatgpt"
            ? {
                type: "chatgpt",
                email: "mock-user@example.com",
                planType: "pro",
              }
            : {
                type: params.type,
              },
        requiresOpenaiAuth: true,
      };

      this.emitNotification("account/login/completed", {
        loginId,
        success: true,
        error: null,
      });
      this.emitNotification("account/updated", {
        authMode: params.type === "apiKey" ? "apikey" : params.type,
      });
    }

    return result;
  }

  async readAccount(): Promise<CodexAccountSnapshot> {
    return this.account;
  }

  async readRateLimits(): Promise<CodexRateLimitSnapshot> {
    return {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: {
          usedPercent: 12,
          windowDurationMins: 15,
          resetsAt: 1760000000,
        },
        secondary: null,
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 12,
            windowDurationMins: 15,
            resetsAt: 1760000000,
          },
          secondary: null,
        },
      },
    };
  }

  async listThreads(): Promise<CodexThreadDescriptor[]> {
    return [...this.threads.values()];
  }

  async readThread(threadId: string): Promise<CodexThreadDescriptor | null> {
    return this.threads.get(threadId) ?? null;
  }

  async resumeThread(threadId: string): Promise<CodexThreadDescriptor> {
    const thread =
      this.threads.get(threadId) ??
      ({
        id: threadId,
        name: "Imported thread",
        cwd: this.config.workspaceRoot,
        updatedAt: new Date().toISOString(),
        status: { type: "idle" },
      } satisfies CodexThreadDescriptor);

    this.threads.set(threadId, thread);
    return thread;
  }

  async dispose(): Promise<void> {
    this.emitter.removeAllListeners();
  }

  onNotification(listener: (notification: CodexRuntimeNotification) => void): () => void {
    this.emitter.on("notification", listener);
    return () => {
      this.emitter.off("notification", listener);
    };
  }

  private emitNotification(method: string, params?: unknown): void {
    this.emitter.emit("notification", { method, params });
  }
}
