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

class FakeStatusRuntime implements CodexRuntime {
  readonly backend = "stdio";
  private listeners = new Set<(notification: CodexRuntimeNotification) => void>();

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
      cwd: "/workspace/codex-feishu-bridge",
      updatedAt: "2026-03-17T00:00:00.000Z",
      status: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
    };
  }

  async listThreads(): Promise<CodexThreadDescriptor[]> {
    return [
      {
        id: "thread-not-loaded",
        name: "Imported thread",
        cwd: "/workspace/codex-feishu-bridge",
        updatedAt: "2026-03-17T00:10:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ];
  }

  async readThread(): Promise<CodexThreadDescriptor | null> {
    return null;
  }

  async resumeThread(threadId: string): Promise<CodexThreadDescriptor> {
    return {
      id: threadId,
      name: "Imported thread",
      cwd: "/workspace/codex-feishu-bridge",
      updatedAt: "2026-03-17T00:15:00.000Z",
      status: {
        type: "idle",
      },
    };
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
}

describe("bridge service runtime status mapping", () => {
  it("maps real thread status objects into bridge task states", async () => {
    const namespace = randomUUID();
    const workspaceRoot = process.cwd();
    const config = loadBridgeConfig(
      {
        WORKSPACE_PATH: workspaceRoot,
        BRIDGE_STATE_DIR: `.tmp/${namespace}/state`,
        CODEX_HOME: `.tmp/${namespace}/codex-home`,
        BRIDGE_UPLOADS_DIR: `.tmp/${namespace}/uploads`,
      },
      workspaceRoot,
    );
    const logger = createConsoleLogger("bridge-service-status-test");
    await prepareBridgeDirectories(config);

    const runtime = new FakeStatusRuntime();
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const created = await service.createTask({
      title: "Approval Task",
    });
    assert.equal(created.status, "awaiting-approval");

    const imported = await service.importThreads();
    assert.equal(imported.length, 1);
    assert.equal(imported[0].status, "idle");

    await service.dispose();
    await runtime.dispose();
  });
});
