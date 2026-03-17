import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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

class ApprovalCompatRuntime implements CodexRuntime {
  readonly backend = "stdio";
  private readonly listeners = new Set<(notification: CodexRuntimeNotification) => void>();
  readonly respondCalls: Array<{ requestId: number | string; result: unknown }> = [];

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
      id: "thread-approval",
      name: params.title ?? "Approval task",
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
      name: "Approval task",
      cwd: "/workspace/codex-feishu-bridge",
      updatedAt: "2026-03-17T00:00:00.000Z",
      status: {
        type: "idle",
      },
    };
  }

  async startTurn(params: { threadId: string }): Promise<CodexTurnDescriptor> {
    return {
      id: "turn-approval",
      threadId: params.threadId,
      status: "inProgress",
      items: [],
    };
  }

  async steerTurn(): Promise<{ turnId: string }> {
    return {
      turnId: "turn-approval",
    };
  }

  async interruptTurn(): Promise<void> {}

  async respondToRequest(requestId: number | string, result: unknown): Promise<void> {
    this.respondCalls.push({ requestId, result });
  }

  async dispose(): Promise<void> {}

  onNotification(listener: (notification: CodexRuntimeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(notification: CodexRuntimeNotification): void {
    for (const listener of this.listeners) {
      listener(notification);
    }
  }
}

describe("bridge service approval compatibility", () => {
  it("captures approvals when the JSON-RPC request id is only on the notification envelope", async () => {
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
    const logger = createConsoleLogger("bridge-service-approval-test");
    await prepareBridgeDirectories(config);

    const runtime = new ApprovalCompatRuntime();
    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    try {
      const task = await service.createTask({ title: "Approval task" });
      runtime.emit({
        method: "item/commandExecution/requestApproval",
        requestId: 0,
        params: {
          threadId: task.taskId,
          turnId: "turn-approval",
          itemId: "call-approval",
          reason: "Allow curl outside the sandbox?",
        },
      });

      await delay(10);

      const snapshot = service.getTask(task.taskId);
      assert.equal(snapshot?.status, "awaiting-approval");
      assert.equal(snapshot?.pendingApprovals.length, 1);
      assert.equal(snapshot?.pendingApprovals[0]?.requestId, "0");
      assert.equal(snapshot?.pendingApprovals[0]?.kind, "command");

      runtime.emit({
        method: "serverRequest/resolved",
        requestId: 0,
        params: {
          threadId: task.taskId,
        },
      });

      await delay(10);

      const cancelled = service.getTask(task.taskId);
      assert.equal(cancelled?.pendingApprovals[0]?.state, "cancelled");
    } finally {
      await service.dispose();
      await runtime.dispose();
    }
  });

  it("responds to numeric approval ids with a numeric JSON-RPC response id", async () => {
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
    const logger = createConsoleLogger("bridge-service-approval-test");
    await prepareBridgeDirectories(config);

    const runtime = new ApprovalCompatRuntime();
    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    try {
      const task = await service.createTask({ title: "Approval task" });
      runtime.emit({
        method: "item/commandExecution/requestApproval",
        requestId: 0,
        params: {
          threadId: task.taskId,
          turnId: "turn-approval",
          itemId: "call-approval",
          reason: "Allow curl outside the sandbox?",
        },
      });

      await delay(10);

      const resolved = await service.resolveApproval(task.taskId, "0", "accept" satisfies CodexApprovalDecision);
      assert.equal(resolved.pendingApprovals[0]?.state, "accepted");
      assert.deepEqual(runtime.respondCalls, [
        {
          requestId: 0,
          result: {
            decision: "accept",
          },
        },
      ]);
    } finally {
      await service.dispose();
      await runtime.dispose();
    }
  });
});
