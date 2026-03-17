import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { createConsoleLogger, prepareBridgeDirectories, writeJsonFile } from "@codex-feishu-bridge/shared";

import type {
  CodexAccountSnapshot,
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

class DiffExtractionRuntime implements CodexRuntime {
  readonly backend = "stdio";
  private readonly listeners = new Set<(notification: CodexRuntimeNotification) => void>();

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
      id: "thread-diff",
      name: params.title ?? "Diff task",
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
      name: "Diff task",
      cwd: TEST_REPO_ROOT,
      updatedAt: "2026-03-17T00:00:00.000Z",
      status: {
        type: "idle",
      },
    };
  }

  async startTurn(params: { threadId: string }): Promise<CodexTurnDescriptor> {
    return {
      id: "turn-diff",
      threadId: params.threadId,
      status: "inProgress",
      items: [],
    };
  }

  async steerTurn(): Promise<{ turnId: string }> {
    return {
      turnId: "turn-diff",
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

  emit(notification: CodexRuntimeNotification): void {
    for (const listener of this.listeners) {
      listener(notification);
    }
  }
}

function diffMessage(text: string) {
  return {
    id: "agent-diff-message",
    type: "agentMessage",
    text,
  };
}

describe("bridge service diff extraction compatibility", () => {
  it("extracts structured task diffs from agent diff fences when no fileChange item is present", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-diff-extraction-test");
    await prepareBridgeDirectories(config);

    const runtime = new DiffExtractionRuntime();
    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    try {
      const task = await service.createTask({ title: "Diff task" });
      runtime.emit({
        method: "item/completed",
        params: {
          threadId: task.taskId,
          turnId: "turn-diff",
          item: diffMessage(
            "[greeting.txt](/tmp/greeting.txt) now contains exactly `hello bridge`.\n\nDiff ready for review:\n```diff\n--- a/greeting.txt\n+++ b/greeting.txt\n@@ -0,0 +1 @@\n+hello bridge\n```",
          ),
        },
      });

      await delay(10);

      const snapshot = service.getTask(task.taskId);
      assert.equal(snapshot?.diffs.length, 1);
      assert.deepEqual(snapshot?.diffs[0], {
        path: "greeting.txt",
        summary: "Extracted from agent diff block",
        patch: "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -0,0 +1 @@\n+hello bridge",
      });
    } finally {
      await service.dispose();
      await runtime.dispose();
    }
  });

  it("does not overwrite existing structured fileChange diffs with extracted agent-message diffs", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-diff-extraction-test");
    await prepareBridgeDirectories(config);

    const runtime = new DiffExtractionRuntime();
    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    try {
      const task = await service.createTask({ title: "Diff task" });
      runtime.emit({
        method: "item/completed",
        params: {
          threadId: task.taskId,
          turnId: "turn-diff",
          item: {
            id: "file-change-1",
            type: "fileChange",
            changes: [
              {
                path: "src/example.ts",
                kind: "modified",
                diff: "--- a/src/example.ts\n+++ b/src/example.ts\n@@\n-console.log(\"before\");\n+console.log(\"after\");\n",
              },
            ],
          },
        },
      });

      runtime.emit({
        method: "item/completed",
        params: {
          threadId: task.taskId,
          turnId: "turn-diff",
          item: diffMessage(
            "Diff ready for review:\n```diff\n--- a/greeting.txt\n+++ b/greeting.txt\n@@ -0,0 +1 @@\n+hello bridge\n```",
          ),
        },
      });

      await delay(10);

      const snapshot = service.getTask(task.taskId);
      assert.equal(snapshot?.diffs.length, 1);
      assert.deepEqual(snapshot?.diffs[0], {
        path: "src/example.ts",
        summary: "modified",
        patch: "--- a/src/example.ts\n+++ b/src/example.ts\n@@\n-console.log(\"before\");\n+console.log(\"after\");\n",
      });
    } finally {
      await service.dispose();
      await runtime.dispose();
    }
  });

  it("hydrates structured diffs from persisted latestSummary blocks when stored diffs are empty", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-diff-extraction-test");
    await prepareBridgeDirectories(config);

    const persistedTask = {
      taskId: "thread-diff",
      threadId: "thread-diff",
      mode: "bridge-managed",
      title: "Persisted diff task",
      workspaceRoot: TEST_REPO_ROOT,
      status: "completed",
      pendingApprovals: [],
      diffs: [],
      imageAssets: [],
      conversation: [],
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
      executionProfile: {},
      latestSummary:
        "[greeting.txt](/tmp/greeting.txt) now contains exactly `hello bridge`.\n\nDiff ready for review:\n```diff\n--- a/greeting.txt\n+++ b/greeting.txt\n@@ -0,0 +1 @@\n+hello bridge\n```",
    };

    const stateFile = `${config.stateDir}/tasks.json`;
    await writeJsonFile(stateFile, {
      seq: 0,
      tasks: [persistedTask],
    });

    const runtime = new DiffExtractionRuntime();
    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    try {
      const snapshot = service.getTask("thread-diff");
      assert.equal(snapshot?.diffs.length, 1);
      assert.deepEqual(snapshot?.diffs[0], {
        path: "greeting.txt",
        summary: "Extracted from agent diff block",
        patch: "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -0,0 +1 @@\n+hello bridge",
      });
    } finally {
      await service.dispose();
      await runtime.dispose();
    }
  });
});
