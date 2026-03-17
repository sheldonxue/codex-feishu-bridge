import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createConsoleLogger, loadBridgeConfig, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import type {
  CodexAccountSnapshot,
  CodexApprovalDecision,
  CodexInputItem,
  CodexModelDescriptor,
  CodexRateLimitSnapshot,
  CodexRuntime,
  CodexRuntimeHealth,
  CodexRuntimeNotification,
  CodexTurnDescriptor,
  CodexThreadDescriptor,
} from "../src/runtime";
import { BridgeService } from "../src/service/bridge-service";

class DelayedTurnStartRuntime implements CodexRuntime {
  readonly backend = "stdio";
  private readonly listeners = new Set<(notification: CodexRuntimeNotification) => void>();
  private turnStarted = false;
  readonly steerCalls: Array<{
    threadId: string;
    turnId: string;
    input: CodexInputItem[];
  }> = [];
  readonly interruptCalls: Array<{ threadId: string; turnId?: string }> = [];

  async start(): Promise<void> {}

  async health(): Promise<CodexRuntimeHealth> {
    return {
      backend: "stdio",
      connected: true,
      initialized: true,
    };
  }

  async loginStart(): Promise<never> {
    throw new Error("not used");
  }

  async readAccount(): Promise<CodexAccountSnapshot> {
    return {
      account: {
        type: "chatgpt",
        email: "bridge@example.com",
        planType: "plus",
      },
      requiresOpenaiAuth: true,
    };
  }

  async readRateLimits(): Promise<CodexRateLimitSnapshot> {
    return {
      rateLimits: null,
      rateLimitsByLimitId: {},
    };
  }

  async listModels(): Promise<CodexModelDescriptor[]> {
    return [];
  }

  async startThread(params: { cwd: string; title?: string }): Promise<CodexThreadDescriptor> {
    return {
      id: "thread-race",
      name: params.title ?? "Race task",
      cwd: params.cwd,
      updatedAt: "2026-03-17T00:00:00.000Z",
      status: {
        type: "idle",
      },
    };
  }

  async listThreads(): Promise<CodexThreadDescriptor[]> {
    return [];
  }

  async readThread(): Promise<CodexThreadDescriptor | null> {
    return null;
  }

  async resumeThread(threadId: string): Promise<CodexThreadDescriptor> {
    return {
      id: threadId,
      name: "Race task",
      cwd: "/workspace/codex-feishu-bridge",
      updatedAt: "2026-03-17T00:00:00.000Z",
      status: {
        type: "idle",
      },
    };
  }

  async startTurn(params: { threadId: string }): Promise<CodexTurnDescriptor> {
    const turn: CodexTurnDescriptor = {
      id: "turn-race",
      threadId: params.threadId,
      status: "inProgress",
      items: [],
    };

    this.turnStarted = false;
    setTimeout(() => {
      this.turnStarted = true;
      this.emit({
        method: "turn/started",
        params: {
          turn,
        },
      });
    }, 25);

    return turn;
  }

  async steerTurn(params: { threadId: string; turnId: string; input: CodexInputItem[] }): Promise<{ turnId: string }> {
    if (!this.turnStarted) {
      throw new Error("no active turn to steer");
    }

    this.steerCalls.push(params);
    return {
      turnId: params.turnId,
    };
  }

  async interruptTurn(params: { threadId: string; turnId?: string }): Promise<void> {
    if (!this.turnStarted) {
      throw new Error("no active turn to interrupt");
    }

    this.interruptCalls.push(params);
  }

  async respondToRequest(_requestId: number | string, _result: unknown): Promise<void> {}

  async dispose(): Promise<void> {}

  onNotification(listener: (notification: CodexRuntimeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(notification: CodexRuntimeNotification): void {
    for (const listener of this.listeners) {
      listener(notification);
    }
  }
}

describe("bridge service turn control", () => {
  it("waits for turn/started before steering an active turn", async () => {
    const namespace = randomUUID();
    const config = loadBridgeConfig(
      {
        WORKSPACE_PATH: process.cwd(),
        BRIDGE_STATE_DIR: `.tmp/${namespace}/state`,
        CODEX_HOME: `.tmp/${namespace}/codex-home`,
        BRIDGE_UPLOADS_DIR: `.tmp/${namespace}/uploads`,
      },
      process.cwd(),
    );
    const logger = createConsoleLogger("bridge-service-turn-control-test");
    await prepareBridgeDirectories(config);

    const runtime = new DelayedTurnStartRuntime();
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    try {
      const created = await service.createTask({
        title: "Race task",
        prompt: "Start a long response.",
      });
      assert.equal(created.activeTurnId, "turn-race");
      assert.equal(created.status, "running");

      const steered = await service.sendMessage(created.taskId, {
        content: "Switch to a short response.",
      });

      assert.equal(steered.activeTurnId, "turn-race");
      assert.equal(runtime.steerCalls.length, 1);
      assert.deepEqual(runtime.steerCalls[0], {
        threadId: created.threadId,
        turnId: "turn-race",
        input: [
          {
            type: "text",
            text: "Switch to a short response.",
          },
        ],
      });
    } finally {
      await service.dispose();
      await runtime.dispose();
    }
  });

  it("waits for turn/started before interrupting a starting turn", async () => {
    const namespace = randomUUID();
    const config = loadBridgeConfig(
      {
        WORKSPACE_PATH: process.cwd(),
        BRIDGE_STATE_DIR: `.tmp/${namespace}/state`,
        CODEX_HOME: `.tmp/${namespace}/codex-home`,
        BRIDGE_UPLOADS_DIR: `.tmp/${namespace}/uploads`,
      },
      process.cwd(),
    );
    const logger = createConsoleLogger("bridge-service-turn-control-test");
    await prepareBridgeDirectories(config);

    const runtime = new DelayedTurnStartRuntime();
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    try {
      const created = await service.createTask({
        title: "Race task",
        prompt: "Start a long response.",
      });
      assert.equal(created.activeTurnId, "turn-race");
      assert.equal(created.status, "running");

      const interrupted = await service.interruptTask(created.taskId);

      assert.equal(interrupted.activeTurnId, undefined);
      assert.equal(interrupted.status, "interrupted");
      assert.equal(runtime.interruptCalls.length, 1);
      assert.deepEqual(runtime.interruptCalls[0], {
        threadId: created.threadId,
        turnId: "turn-race",
      });
    } finally {
      await service.dispose();
      await runtime.dispose();
    }
  });
});
