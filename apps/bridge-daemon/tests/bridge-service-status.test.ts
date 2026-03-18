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

class FakeStatusRuntime implements CodexRuntime {
  readonly backend = "stdio";
  private listeners = new Set<(notification: CodexRuntimeNotification) => void>();
  private threads: CodexThreadDescriptor[] = [
    {
      id: "thread-not-loaded",
      name: "Imported thread",
      cwd: TEST_REPO_ROOT,
      updatedAt: "2026-03-17T00:10:00.000Z",
      status: {
        type: "notLoaded",
      },
    },
  ];

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

  async startThread(): Promise<CodexThreadDescriptor> {
    return {
      id: "thread-awaiting-approval",
      name: "Needs approval",
      cwd: TEST_REPO_ROOT,
      updatedAt: "2026-03-17T00:00:00.000Z",
      status: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
    };
  }

  async listThreads(): Promise<CodexThreadDescriptor[]> {
    return this.threads;
  }

  async readThread(): Promise<CodexThreadDescriptor | null> {
    return null;
  }

  async resumeThread(threadId: string): Promise<CodexThreadDescriptor> {
    return (
      this.threads.find((thread) => thread.id === threadId) ?? {
        id: threadId,
        name: "Imported thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-17T00:15:00.000Z",
        status: {
          type: "idle",
        },
      }
    );
  }

  async startTurn(params: { threadId: string }): Promise<CodexTurnDescriptor> {
    return {
      id: "turn-1",
      threadId: params.threadId,
      status: "inProgress",
      items: [],
    };
  }

  async steerTurn(): Promise<{ turnId: string }> {
    return {
      turnId: "turn-1",
    };
  }

  async interruptTurn(): Promise<void> {}

  async respondToRequest(_requestId: number | string, _result: unknown): Promise<void> {}

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

  setThreads(threads: CodexThreadDescriptor[]): void {
    this.threads = threads;
  }
}

describe("bridge service runtime status mapping", () => {
  it("maps real thread status objects into bridge task states and auto-imports active runtime threads", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-status-test");
    await prepareBridgeDirectories(config);

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-active",
        name: "Active runtime thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-17T00:05:00.000Z",
        status: {
          type: "active",
          activeFlags: ["waitingOnApproval"],
        },
      },
      {
        id: "thread-not-loaded",
        name: "Imported thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-17T00:10:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ]);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    assert.equal(service.getTask("thread-active")?.status, "awaiting-approval");
    assert.equal(service.getTask("thread-not-loaded"), null);

    const created = await service.createTask({
      title: "Approval Task",
    });
    assert.equal(created.status, "awaiting-approval");

    const imported = await service.importThreads("thread-not-loaded");
    assert.equal(imported.length, 1);
    assert.equal(imported[0].status, "idle");

    await service.dispose();
    await runtime.dispose();
  });

  it("discovers newly active host threads on demand without importing idle unseen threads", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-status-sync-test");
    await prepareBridgeDirectories(config);

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([]);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();
    assert.equal(service.listTasks().length, 0);

    runtime.setThreads([
      {
        id: "thread-running",
        name: "Host running thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-17T00:20:00.000Z",
        status: {
          type: "active",
          activeFlags: [],
        },
      },
      {
        id: "thread-idle-unseen",
        name: "Idle host thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-17T00:21:00.000Z",
        status: {
          type: "idle",
        },
      },
    ]);

    const synced = await service.syncRuntimeThreads();
    assert.equal(synced.some((task) => task.taskId === "thread-running"), true);
    assert.equal(synced.some((task) => task.taskId === "thread-idle-unseen"), false);
    assert.equal(service.getTask("thread-running")?.mode, "manual-import");

    await service.dispose();
    await runtime.dispose();
  });
});
