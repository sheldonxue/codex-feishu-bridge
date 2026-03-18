import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createConsoleLogger, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

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
import { createTestBridgeConfig, TEST_REPO_ROOT } from "./test-paths";

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for ${message}`);
}

class DelayedTurnStartRuntime implements CodexRuntime {
  readonly backend = "stdio";
  private readonly listeners = new Set<(notification: CodexRuntimeNotification) => void>();
  private activeTurnId?: string;
  private turnCounter = 0;
  private turnStarted = false;
  readonly startTurnCalls: Array<{
    threadId: string;
    input?: CodexInputItem[];
  }> = [];
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
      cwd: TEST_REPO_ROOT,
      updatedAt: "2026-03-17T00:00:00.000Z",
      status: {
        type: "idle",
      },
    };
  }

  async startTurn(params: { threadId: string }): Promise<CodexTurnDescriptor> {
    this.turnCounter += 1;
    const turnId = this.turnCounter === 1 ? "turn-race" : `turn-race-${this.turnCounter}`;
    const turn: CodexTurnDescriptor = {
      id: turnId,
      threadId: params.threadId,
      status: "inProgress",
      items: [],
    };

    this.activeTurnId = turnId;
    this.turnStarted = false;
    this.startTurnCalls.push({
      threadId: params.threadId,
      input: "input" in params ? params.input : undefined,
    });
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

  completeActiveTurn(threadId = "thread-race"): void {
    if (!this.activeTurnId) {
      throw new Error("no active turn to complete");
    }

    const turn: CodexTurnDescriptor = {
      id: this.activeTurnId,
      threadId,
      status: "completed",
      items: [],
    };
    this.activeTurnId = undefined;
    this.turnStarted = false;
    this.emit({
      method: "turn/completed",
      params: {
        turn,
      },
    });
  }
}

describe("bridge service turn control", () => {
  it("waits for turn/started before steering an active turn", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
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
    const config = createTestBridgeConfig(namespace);
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

  it("can queue feishu messages for the next turn instead of steering the active turn", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-turn-control-test");
    await prepareBridgeDirectories(config);

    const runtime = new DelayedTurnStartRuntime();
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    try {
      const created = await service.createTask({
        title: "Queue task",
        prompt: "Start the first turn.",
      });
      assert.equal(created.activeTurnId, "turn-race");
      assert.equal(created.status, "running");

      const updated = await service.updateTaskSettings(created.taskId, {
        feishuRunningMessageMode: "queue",
      });
      assert.equal(updated.feishuRunningMessageMode, "queue");

      const queued = await service.sendMessage(created.taskId, {
        content: "Follow up after the current turn.",
        source: "feishu",
        replyToFeishu: true,
      });

      assert.equal(queued.activeTurnId, "turn-race");
      assert.equal(queued.queuedMessageCount, 1);
      assert.equal(runtime.steerCalls.length, 0);
      assert.equal(runtime.startTurnCalls.length, 1);

      runtime.completeActiveTurn(created.threadId);

      await waitFor(() => (service.getTask(created.taskId)?.queuedMessageCount ?? -1) === 0, "queued message drain");
      await waitFor(() => (service.getTask(created.taskId)?.activeTurnId ?? "") === "turn-race-2", "second turn start");

      assert.equal(runtime.startTurnCalls.length, 2);
      assert.deepEqual(runtime.startTurnCalls[1], {
        threadId: created.threadId,
        input: [
          {
            type: "text",
            text: "Follow up after the current turn.",
          },
        ],
      });
    } finally {
      await service.dispose();
      await runtime.dispose();
    }
  });
});
