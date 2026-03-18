import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await delay(20);
  }

  throw new Error(`Timed out waiting for ${message}`);
}

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
  private requiresResumeBeforeStartTurn = false;
  private readonly resumedThreadIds = new Set<string>();

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
    this.resumedThreadIds.add(threadId);
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
    if (this.requiresResumeBeforeStartTurn && !this.resumedThreadIds.has(params.threadId)) {
      throw new Error(`thread not found: ${params.threadId}`);
    }
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

  requireResumeBeforeStartTurn(enabled: boolean): void {
    this.requiresResumeBeforeStartTurn = enabled;
  }

  hasResumedThread(threadId: string): boolean {
    return this.resumedThreadIds.has(threadId);
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

  it("imports recent unseen host threads on explicit request", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-recent-import-test");
    await prepareBridgeDirectories(config);

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-old",
        name: "Older host thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-17T00:05:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
      {
        id: "thread-new",
        name: "Newer host thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-17T00:25:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
      {
        id: "thread-active",
        name: "Already active",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-17T00:30:00.000Z",
        status: {
          type: "active",
          activeFlags: [],
        },
      },
    ]);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const imported = await service.importRecentRuntimeThreads(1);
    assert.equal(imported.length, 1);
    assert.equal(imported[0].taskId, "thread-new");
    assert.equal(service.getTask("thread-old"), null);
    assert.equal(service.getTask("thread-new")?.mode, "manual-import");
    assert.equal(service.getTask("thread-active")?.status, "running");

    await service.dispose();
    await runtime.dispose();
  });

  it("hydrates recent conversation from rollout files when importing host threads", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-import-history-test");
    await prepareBridgeDirectories(config);

    const rolloutRelativePath = "sessions/2026/03/19/rollout-import-history.jsonl";
    const rolloutDiskPath = path.join(config.codexHome, rolloutRelativePath);
    await mkdir(path.dirname(rolloutDiskPath), { recursive: true });
    await writeFile(
      rolloutDiskPath,
      [
        JSON.stringify({
          timestamp: "2026-03-19T00:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "ignored developer context" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "First imported question",
            local_images: [],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T00:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "First imported answer",
            phase: "commentary",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T00:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Second imported question",
            local_images: [],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T00:00:04.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Second imported answer",
            phase: "final",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const stateDb = new DatabaseSync(path.join(config.codexHome, "state_5.sqlite"));
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      )
    `);
    stateDb
      .prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)")
      .run("thread-history", `/codex-home/${rolloutRelativePath}`);
    stateDb.close();

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-history",
        name: "Imported with history",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T00:10:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ]);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const imported = await service.importRecentRuntimeThreads(1);
    assert.equal(imported.length, 1);
    assert.deepEqual(
      imported[0].conversation.map((entry) => ({
        author: entry.author,
        surface: entry.surface,
        content: entry.content,
      })),
      [
        { author: "user", surface: "runtime", content: "First imported question" },
        { author: "agent", surface: "runtime", content: "First imported answer" },
        { author: "user", surface: "runtime", content: "Second imported question" },
        { author: "agent", surface: "runtime", content: "Second imported answer" },
      ],
    );
    assert.equal(imported[0].latestSummary, "Second imported answer");

    await service.dispose();
    await runtime.dispose();
  });

  it("refreshes imported conversation when a host rollout grows after import", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-import-refresh-test");
    await prepareBridgeDirectories(config);

    const rolloutRelativePath = "sessions/2026/03/19/rollout-import-refresh.jsonl";
    const rolloutDiskPath = path.join(config.codexHome, rolloutRelativePath);
    await mkdir(path.dirname(rolloutDiskPath), { recursive: true });

    const writeRollout = async (lines: unknown[]): Promise<void> => {
      await writeFile(
        rolloutDiskPath,
        lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
        "utf8",
      );
    };

    await writeRollout([
      {
        timestamp: "2026-03-19T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "First imported question",
          local_images: [],
        },
      },
      {
        timestamp: "2026-03-19T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "First imported answer",
          phase: "commentary",
        },
      },
    ]);

    const stateDb = new DatabaseSync(path.join(config.codexHome, "state_5.sqlite"));
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      )
    `);
    stateDb
      .prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)")
      .run("thread-refresh", `/codex-home/${rolloutRelativePath}`);
    stateDb.close();

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-refresh",
        name: "Imported refresh thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T00:10:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ]);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const imported = await service.importRecentRuntimeThreads(1);
    assert.equal(imported.length, 1);
    assert.deepEqual(
      imported[0].conversation.map((entry) => entry.content),
      ["First imported question", "First imported answer"],
    );

    await writeRollout([
      {
        timestamp: "2026-03-19T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "First imported question",
          local_images: [],
        },
      },
      {
        timestamp: "2026-03-19T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "First imported answer",
          phase: "commentary",
        },
      },
      {
        timestamp: "2026-03-19T00:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Second imported question",
          local_images: [],
        },
      },
      {
        timestamp: "2026-03-19T00:00:04.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Second imported answer",
          phase: "final",
        },
      },
    ]);

    runtime.setThreads([
      {
        id: "thread-refresh",
        name: "Imported refresh thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T00:11:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ]);

    const refreshed = await service.syncRuntimeThreads();
    const refreshedTask = refreshed.find((task) => task.taskId === "thread-refresh");
    assert.deepEqual(
      refreshedTask?.conversation.map((entry) => entry.content),
      [
        "First imported question",
        "First imported answer",
        "Second imported question",
        "Second imported answer",
      ],
    );
    assert.equal(refreshedTask?.latestSummary, "Second imported answer");

    await service.dispose();
    await runtime.dispose();
  });

  it("emits imported conversation delta events when a host rollout grows during background sync", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-import-delta-event-test");
    await prepareBridgeDirectories(config);

    const rolloutRelativePath = "sessions/2026/03/19/rollout-import-delta-event.jsonl";
    const rolloutDiskPath = path.join(config.codexHome, rolloutRelativePath);
    await mkdir(path.dirname(rolloutDiskPath), { recursive: true });

    const writeRollout = async (lines: unknown[]): Promise<void> => {
      await writeFile(
        rolloutDiskPath,
        lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
        "utf8",
      );
    };

    await writeRollout([
      {
        timestamp: "2026-03-19T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "First imported question",
          local_images: [],
        },
      },
      {
        timestamp: "2026-03-19T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "First imported answer",
          phase: "commentary",
        },
      },
    ]);

    const stateDb = new DatabaseSync(path.join(config.codexHome, "state_5.sqlite"));
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      )
    `);
    stateDb
      .prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)")
      .run("thread-delta-event", `/codex-home/${rolloutRelativePath}`);
    stateDb.close();

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-delta-event",
        name: "Imported delta event thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T00:10:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ]);
    await runtime.start();

    const service = new BridgeService({
      config,
      logger,
      runtime,
      runtimeSyncIntervalMs: 20,
    });
    await service.initialize();
    await service.importRecentRuntimeThreads(1);

    const observedDeltas: Array<{ kind: string; delta: string[] }> = [];
    const unsubscribe = service.subscribe(({ event }) => {
      const payload = event.payload as { importedConversationDelta?: Array<{ content: string }> };
      observedDeltas.push({
        kind: event.kind,
        delta: Array.isArray(payload.importedConversationDelta)
          ? payload.importedConversationDelta.map((entry) => entry.content)
          : [],
      });
    });

    await writeRollout([
      {
        timestamp: "2026-03-19T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "First imported question",
          local_images: [],
        },
      },
      {
        timestamp: "2026-03-19T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "First imported answer",
          phase: "commentary",
        },
      },
      {
        timestamp: "2026-03-19T00:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Second imported question",
          local_images: [],
        },
      },
      {
        timestamp: "2026-03-19T00:00:04.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Second imported answer",
          phase: "final",
        },
      },
    ]);

    runtime.setThreads([
      {
        id: "thread-delta-event",
        name: "Imported delta event thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T00:11:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ]);

    await waitFor(
      () =>
        observedDeltas.some(
          (entry) =>
            entry.kind === "task.updated" &&
            entry.delta.join(" | ") === "Second imported question | Second imported answer",
        ),
      "background imported delta event",
    );

    unsubscribe();
    await service.dispose();
    await runtime.dispose();
  });

  it("resumes imported host threads before sending the first new message", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-import-resume-before-send-test");
    await prepareBridgeDirectories(config);

    const runtime = new FakeStatusRuntime();
    runtime.requireResumeBeforeStartTurn(true);
    runtime.setThreads([
      {
        id: "thread-needs-resume",
        name: "Imported needs resume",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T00:25:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ]);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const imported = await service.importRecentRuntimeThreads(1);
    assert.equal(imported.length, 1);
    assert.equal(runtime.hasResumedThread("thread-needs-resume"), false);

    await service.sendMessage("thread-needs-resume", {
      content: "Continue this imported task",
      source: "vscode",
    });

    assert.equal(runtime.hasResumedThread("thread-needs-resume"), true);

    await service.dispose();
    await runtime.dispose();
  });

  it("tolerates missing rollout files when importing host threads", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-import-missing-rollout-test");
    await prepareBridgeDirectories(config);

    const stateDb = new DatabaseSync(path.join(config.codexHome, "state_5.sqlite"));
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      )
    `);
    stateDb
      .prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)")
      .run("thread-missing-rollout", "/codex-home/sessions/2026/03/19/missing-rollout.jsonl");
    stateDb.close();

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-missing-rollout",
        name: "Missing rollout thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T00:20:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ]);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const imported = await service.importRecentRuntimeThreads(1);
    assert.equal(imported.length, 1);
    assert.deepEqual(imported[0].conversation, []);

    await service.dispose();
    await runtime.dispose();
  });
});
