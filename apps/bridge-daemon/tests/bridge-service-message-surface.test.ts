import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { createConsoleLogger, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import type {
  CodexAccountSnapshot,
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await delay(20);
  }

  throw new Error(`Timed out waiting for ${message}`);
}

class SurfaceAwareRuntime implements CodexRuntime {
  readonly backend = "stdio";
  private readonly listeners = new Set<(notification: CodexRuntimeNotification) => void>();
  private turnCounter = 0;
  private lastThreadId = "thread-surface";

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
    this.lastThreadId = "thread-surface";
    return {
      id: this.lastThreadId,
      name: params.title ?? "Surface task",
      cwd: params.cwd,
      updatedAt: "2026-03-18T00:00:00.000Z",
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
    throw new Error(`resumeThread should not be called for bridge-managed task ${threadId}`);
  }

  async startTurn(params: { threadId: string; input: CodexInputItem[] }): Promise<CodexTurnDescriptor> {
    this.turnCounter += 1;
    const turnId = `turn-${this.turnCounter}`;
    const textInput = params.input.find((entry): entry is Extract<CodexInputItem, { type: "text" }> => entry.type === "text");
    const prompt = textInput?.text ?? "no prompt";
    queueMicrotask(() => {
      this.emit({
        method: "turn/started",
        params: {
          turn: {
            id: turnId,
            threadId: params.threadId,
            status: "inProgress",
            items: [],
          },
        },
      });
      this.emit({
        method: "item/started",
        params: {
          threadId: params.threadId,
          turnId,
          item: {
            id: `user-${turnId}`,
            type: "userMessage",
            content: params.input,
          },
        },
      });
      this.emit({
        method: "item/completed",
        params: {
          threadId: params.threadId,
          turnId,
          item: {
            id: `user-${turnId}`,
            type: "userMessage",
            content: params.input,
          },
        },
      });
      this.emit({
        method: "item/started",
        params: {
          threadId: params.threadId,
          turnId,
          item: {
            id: `agent-${turnId}`,
            type: "agentMessage",
            text: `Runtime reply for ${prompt}`,
          },
        },
      });
      this.emit({
        method: "item/completed",
        params: {
          threadId: params.threadId,
          turnId,
          item: {
            id: `agent-${turnId}`,
            type: "agentMessage",
            text: `Runtime reply for ${prompt}`,
          },
        },
      });
      this.emit({
        method: "turn/completed",
        params: {
          turn: {
            id: turnId,
            threadId: params.threadId,
            status: "completed",
            items: [],
          },
        },
      });
    });

    return {
      id: turnId,
      threadId: params.threadId,
      status: "inProgress",
      items: [],
    };
  }

  async steerTurn(params: { threadId: string; turnId: string; input: CodexInputItem[] }): Promise<{ turnId: string }> {
    const textInput = params.input.find((entry): entry is Extract<CodexInputItem, { type: "text" }> => entry.type === "text");
    const prompt = textInput?.text ?? "no prompt";
    queueMicrotask(() => {
      this.emit({
        method: "item/started",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          item: {
            id: `user-${params.turnId}-${this.turnCounter}`,
            type: "userMessage",
            content: params.input,
          },
        },
      });
      this.emit({
        method: "item/completed",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          item: {
            id: `user-${params.turnId}-${this.turnCounter}`,
            type: "userMessage",
            content: params.input,
          },
        },
      });
      this.emit({
        method: "item/started",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          item: {
            id: `agent-${params.turnId}-${this.turnCounter}`,
            type: "agentMessage",
            text: `Runtime reply for ${prompt}`,
          },
        },
      });
      this.emit({
        method: "item/completed",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          item: {
            id: `agent-${params.turnId}-${this.turnCounter}`,
            type: "agentMessage",
            text: `Runtime reply for ${prompt}`,
          },
        },
      });
      this.emit({
        method: "turn/completed",
        params: {
          turn: {
            id: params.turnId,
            threadId: params.threadId,
            status: "completed",
            items: [],
          },
        },
      });
    });

    return {
      turnId: params.turnId,
    };
  }

  async interruptTurn(): Promise<void> {}

  async respondToRequest(): Promise<void> {}

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

describe("bridge service message surfaces", () => {
  it("tracks conversation origin and desktop reply-to-feishu behavior per task", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-message-surface-test");
    await prepareBridgeDirectories(config);

    const runtime = new SurfaceAwareRuntime();
    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    try {
      const created = await service.createTask({
        title: "Surface task",
        source: "vscode",
      });
      assert.equal(created.taskOrigin, "vscode");
      await service.bindFeishuThread(created.taskId, {
        chatId: "oc_chat",
        threadKey: "omt_surface",
        rootMessageId: "om_root_surface",
      });

      const bound = service.getTask(created.taskId);
      assert.equal(bound?.taskOrigin, "vscode");
      assert.equal(bound?.desktopReplySyncToFeishu, true);

      await service.sendMessage(created.taskId, {
        content: "hello from feishu",
        source: "feishu",
        replyToFeishu: true,
      });

      await waitFor(() => (service.getTask(created.taskId)?.conversation.length ?? 0) >= 2, "feishu-origin conversation");
      const afterFeishu = service.getTask(created.taskId);
      assert.equal(afterFeishu?.conversation.at(-2)?.surface, "feishu");
      assert.equal(afterFeishu?.conversation.at(-1)?.surface, "feishu");

      await service.updateTaskSettings(created.taskId, {
        desktopReplySyncToFeishu: false,
      });
      await service.sendMessage(created.taskId, {
        content: "hello from vscode",
        source: "vscode",
      });

      await waitFor(() => (service.getTask(created.taskId)?.conversation.length ?? 0) >= 4, "vscode-origin conversation");
      const afterVscodeNoSync = service.getTask(created.taskId);
      assert.equal(afterVscodeNoSync?.desktopReplySyncToFeishu, false);
      assert.equal(afterVscodeNoSync?.conversation.at(-2)?.surface, "vscode");
      assert.equal(afterVscodeNoSync?.conversation.at(-1)?.surface, "vscode");

      await service.updateTaskSettings(created.taskId, {
        desktopReplySyncToFeishu: true,
      });
      await service.sendMessage(created.taskId, {
        content: "desktop sync on",
        source: "vscode",
      });

      await waitFor(() => (service.getTask(created.taskId)?.conversation.length ?? 0) >= 6, "vscode synced conversation");
      const afterVscodeSync = service.getTask(created.taskId);
      assert.equal(afterVscodeSync?.taskOrigin, "vscode");
      assert.equal(afterVscodeSync?.desktopReplySyncToFeishu, true);
      assert.equal(afterVscodeSync?.conversation.at(-2)?.surface, "vscode");
      assert.equal(afterVscodeSync?.conversation.at(-1)?.surface, "feishu");
    } finally {
      await service.dispose();
      await runtime.dispose();
    }
  });
});
