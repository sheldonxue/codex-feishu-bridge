import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { createConsoleLogger, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";
import type { ApprovalPolicy, SandboxMode } from "@codex-feishu-bridge/protocol";

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

function writeThreadStateRow(
  config: ReturnType<typeof createTestBridgeConfig>,
  params: {
    threadId: string;
    rolloutPath?: string;
    sandboxPolicy?: string;
    approvalMode?: string;
  },
): void {
  const stateDb = new DatabaseSync(path.join(config.codexHome, "state_5.sqlite"));
  stateDb.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      sandbox_policy TEXT,
      approval_mode TEXT
    )
  `);
  stateDb
    .prepare(`
      INSERT OR REPLACE INTO threads (id, rollout_path, sandbox_policy, approval_mode)
      VALUES (?, ?, ?, ?)
    `)
    .run(
      params.threadId,
      params.rolloutPath ?? null,
      params.sandboxPolicy ?? null,
      params.approvalMode ?? null,
    );
  stateDb.close();
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
  private lastStartTurnApprovalPolicy: ApprovalPolicy | undefined;
  private lastStartTurnSandbox: SandboxMode | undefined;
  private startTurnCallCount = 0;

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

  async startTurn(params: {
    threadId: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
  }): Promise<CodexTurnDescriptor> {
    if (this.requiresResumeBeforeStartTurn && !this.resumedThreadIds.has(params.threadId)) {
      throw new Error(`thread not found: ${params.threadId}`);
    }
    this.startTurnCallCount += 1;
    this.lastStartTurnApprovalPolicy = params.approvalPolicy;
    this.lastStartTurnSandbox = params.sandbox;
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

  getLastStartTurnApprovalPolicy(): ApprovalPolicy | undefined {
    return this.lastStartTurnApprovalPolicy;
  }

  getStartTurnCallCount(): number {
    return this.startTurnCallCount;
  }

  getLastStartTurnSandbox(): SandboxMode | undefined {
    return this.lastStartTurnSandbox;
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

  it("restores sandbox and approval policy for imported host threads from codex state metadata", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-import-profile-test");
    await prepareBridgeDirectories(config);

    writeThreadStateRow(config, {
      threadId: "thread-profile",
      sandboxPolicy: "danger-full-access",
      approvalMode: "never",
    });

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-profile",
        name: "Imported profile thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T03:00:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ]);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const imported = await service.importThreads("thread-profile");
    assert.equal(imported.length, 1);
    assert.equal(imported[0]?.executionProfile.sandbox, "danger-full-access");
    assert.equal(imported[0]?.executionProfile.approvalPolicy, "never");

    await service.dispose();
    await runtime.dispose();
  });

  it("uses the restored approval policy after binding an imported host thread to feishu", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-bind-profile-test");
    await prepareBridgeDirectories(config);

    writeThreadStateRow(config, {
      threadId: "thread-bound-profile",
      sandboxPolicy: "danger-full-access",
      approvalMode: "never",
    });

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-bound-profile",
        name: "Bound profile thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T03:10:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ]);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    await service.importThreads("thread-bound-profile");
    const bound = await service.bindFeishuThread("thread-bound-profile", {
      chatId: "oc_chat",
      threadKey: "omt_thread_bound_profile",
      rootMessageId: "om_thread_bound_profile",
    });
    assert.equal(bound.executionProfile.sandbox, "danger-full-access");
    assert.equal(bound.executionProfile.approvalPolicy, "never");

    await service.sendMessage("thread-bound-profile", {
      content: "Please inspect the local training data",
      source: "feishu",
      replyToFeishu: true,
    });
    assert.equal(runtime.getLastStartTurnApprovalPolicy(), "never");
    assert.equal(runtime.getLastStartTurnSandbox(), "danger-full-access");

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
    assert.equal(service.getTask("thread-running")?.taskOrigin, "cli");

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
    assert.equal(service.getTask("thread-new")?.taskOrigin, "cli");
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

  it("hydrates vscode-origin imported conversation from session metadata and response items", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-import-vscode-history-test");
    await prepareBridgeDirectories(config);

    const rolloutRelativePath = "sessions/2026/03/19/rollout-import-vscode-history.jsonl";
    const rolloutDiskPath = path.join(config.codexHome, rolloutRelativePath);
    await mkdir(path.dirname(rolloutDiskPath), { recursive: true });
    await writeFile(
      rolloutDiskPath,
      [
        JSON.stringify({
          timestamp: "2026-03-19T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "thread-vscode-history",
            source: "vscode",
            originator: "codex_vscode",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Imported from the Codex IDE" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Imported IDE answer" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    writeThreadStateRow(config, {
      threadId: "thread-vscode-history",
      rolloutPath: `/codex-home/${rolloutRelativePath}`,
    });

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-vscode-history",
        name: "Imported from VSCode",
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
    assert.equal(imported[0].taskOrigin, "vscode");
    assert.deepEqual(
      imported[0].conversation.map((entry) => ({
        author: entry.author,
        surface: entry.surface,
        content: entry.content,
      })),
      [
        { author: "user", surface: "vscode", content: "Imported from the Codex IDE" },
        { author: "agent", surface: "runtime", content: "Imported IDE answer" },
      ],
    );

    await service.dispose();
    await runtime.dispose();
  });

  it("deduplicates mirrored event and response message records in imported rollouts", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-import-dedupe-test");
    await prepareBridgeDirectories(config);

    const rolloutRelativePath = "sessions/2026/03/19/rollout-import-dedupe-history.jsonl";
    const rolloutDiskPath = path.join(config.codexHome, rolloutRelativePath);
    await mkdir(path.dirname(rolloutDiskPath), { recursive: true });
    await writeFile(
      rolloutDiskPath,
      [
        JSON.stringify({
          timestamp: "2026-03-19T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "thread-dedupe-history",
            source: "vscode",
            originator: "codex_vscode",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Imported from monitor" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T00:00:01.001Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Imported from monitor",
            local_images: [],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T00:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Imported answer",
            phase: "final",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T00:00:02.001Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Imported answer" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    writeThreadStateRow(config, {
      threadId: "thread-dedupe-history",
      rolloutPath: `/codex-home/${rolloutRelativePath}`,
    });

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-dedupe-history",
        name: "Imported with mirrored records",
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
        { author: "user", surface: "vscode", content: "Imported from monitor" },
        { author: "agent", surface: "runtime", content: "Imported answer" },
      ],
    );

    await service.dispose();
    await runtime.dispose();
  });

  it("imports the full rollout conversation instead of truncating to the latest 20 messages", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-import-full-history-test");
    await prepareBridgeDirectories(config);

    const rolloutRelativePath = "sessions/2026/03/19/rollout-import-full-history.jsonl";
    const rolloutDiskPath = path.join(config.codexHome, rolloutRelativePath);
    await mkdir(path.dirname(rolloutDiskPath), { recursive: true });

    const rolloutLines: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const userTimestamp = `2026-03-19T00:00:${String(index * 2).padStart(2, "0")}.000Z`;
      const agentTimestamp = `2026-03-19T00:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`;
      rolloutLines.push(
        JSON.stringify({
          timestamp: userTimestamp,
          type: "event_msg",
          payload: {
            type: "user_message",
            message: `Imported question ${index + 1}`,
            local_images: [],
          },
        }),
      );
      rolloutLines.push(
        JSON.stringify({
          timestamp: agentTimestamp,
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: `Imported answer ${index + 1}`,
            phase: "final",
          },
        }),
      );
    }
    await writeFile(rolloutDiskPath, `${rolloutLines.join("\n")}\n`, "utf8");

    const stateDb = new DatabaseSync(path.join(config.codexHome, "state_5.sqlite"));
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      )
    `);
    stateDb
      .prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)")
      .run("thread-full-history", `/codex-home/${rolloutRelativePath}`);
    stateDb.close();

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-full-history",
        name: "Imported with full history",
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
    assert.equal(imported[0].conversation.length, 60);
    assert.equal(imported[0].conversation[0]?.content, "Imported question 1");
    assert.equal(imported[0].conversation[1]?.content, "Imported answer 1");
    assert.equal(imported[0].conversation.at(-2)?.content, "Imported question 30");
    assert.equal(imported[0].conversation.at(-1)?.content, "Imported answer 30");

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

  it("refreshes a feishu-bound imported conversation even when the host thread updatedAt stays unchanged", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-bound-import-refresh-test");
    await prepareBridgeDirectories(config);

    const rolloutRelativePath = "sessions/2026/03/19/rollout-bound-import-refresh.jsonl";
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
      .run("thread-bound-refresh", `/codex-home/${rolloutRelativePath}`);
    stateDb.close();

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-bound-refresh",
        name: "Bound imported refresh thread",
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
    await service.bindFeishuThread("thread-bound-refresh", {
      chatId: "oc_bound_chat",
      threadKey: "omt_bound_refresh",
      rootMessageId: "om_bound_refresh",
    });

    await service.syncRuntimeThreads();

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
        id: "thread-bound-refresh",
        name: "Bound imported refresh thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T00:10:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ]);

    const refreshed = await service.syncRuntimeThreads();
    const refreshedTask = refreshed.find((task) => task.taskId === "thread-bound-refresh");
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
    assert.equal(refreshedTask?.updatedAt, "2026-03-19T00:00:04.000Z");

    await service.dispose();
    await runtime.dispose();
  });

  it("marks a feishu-bound imported task as running from rollout activity even after live conversation entries exist", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-bound-import-rollout-activity-test");
    await prepareBridgeDirectories(config);

    const rolloutRelativePath = "sessions/2026/03/19/rollout-bound-import-busy.jsonl";
    const rolloutDiskPath = path.join(config.codexHome, rolloutRelativePath);
    await mkdir(path.dirname(rolloutDiskPath), { recursive: true });
    await writeFile(
      rolloutDiskPath,
      [
        JSON.stringify({
          timestamp: "2026-03-19T01:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-rollout-busy-1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T01:00:00.001Z",
          type: "turn_context",
          payload: {
            turn_id: "turn-rollout-busy-1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T01:00:00.002Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Still thinking on the imported host thread",
            local_images: [],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    writeThreadStateRow(config, {
      threadId: "thread-bound-busy",
      rolloutPath: `/codex-home/${rolloutRelativePath}`,
    });

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-bound-busy",
        name: "Bound imported busy thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T01:00:00.000Z",
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
    await service.bindFeishuThread("thread-bound-busy", {
      chatId: "oc_busy_chat",
      threadKey: "omt_busy_thread",
      rootMessageId: "om_busy_root",
    });
    const internalTask = (
      service as unknown as {
        tasks: Map<
          string,
          {
            conversation: Array<{
              messageId: string;
              author: string;
              surface: string;
              content: string;
              createdAt: string;
            }>;
          }
        >;
      }
    ).tasks.get("thread-bound-busy");
    assert.ok(internalTask);
    internalTask.conversation.push({
      messageId: "live-feishu-message",
      author: "user",
      surface: "feishu",
      content: "Live follow-up from Feishu",
      createdAt: "2026-03-19T01:00:10.000Z",
    });

    const synced = await service.syncRuntimeThreads();
    const syncedTask = synced.find((task) => task.taskId === "thread-bound-busy");
    assert.equal(syncedTask?.status, "running");
    assert.equal(syncedTask?.activeTurnId, "turn-rollout-busy-1");
    assert.equal(service.getTask("thread-bound-busy")?.status, "running");

    await service.dispose();
    await runtime.dispose();
  });

  it("queues feishu messages when an imported host rollout shows an active external turn", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-imported-rollout-queue-test");
    await prepareBridgeDirectories(config);

    const rolloutRelativePath = "sessions/2026/03/19/rollout-import-queue-busy.jsonl";
    const rolloutDiskPath = path.join(config.codexHome, rolloutRelativePath);
    await mkdir(path.dirname(rolloutDiskPath), { recursive: true });
    await writeFile(
      rolloutDiskPath,
      [
        JSON.stringify({
          timestamp: "2026-03-19T01:05:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-rollout-queue-1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T01:05:00.001Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Host VSCode is still processing this turn",
            local_images: [],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    writeThreadStateRow(config, {
      threadId: "thread-rollout-queue",
      rolloutPath: `/codex-home/${rolloutRelativePath}`,
    });

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-rollout-queue",
        name: "Imported queue thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T01:05:00.000Z",
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
    await service.bindFeishuThread("thread-rollout-queue", {
      chatId: "oc_queue_chat",
      threadKey: "omt_queue_thread",
      rootMessageId: "om_queue_root",
    });

    const queued = await service.sendMessage("thread-rollout-queue", {
      content: "Check the latest training progress",
      source: "feishu",
      replyToFeishu: true,
      receiptId: "receipt-rollout-queue",
    });

    assert.equal(queued.queuedMessageCount, 1);
    assert.equal(queued.status, "running");
    assert.equal(queued.activeTurnId, "turn-rollout-queue-1");
    assert.equal(runtime.getStartTurnCallCount(), 0);

    await service.dispose();
    await runtime.dispose();
  });

  it("keeps a bound imported task running across repeated syncs while rollout activity still shows an active turn", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-imported-rollout-stable-running-test");
    await prepareBridgeDirectories(config);

    const rolloutRelativePath = "sessions/2026/03/19/rollout-import-stable-running.jsonl";
    const rolloutDiskPath = path.join(config.codexHome, rolloutRelativePath);
    await mkdir(path.dirname(rolloutDiskPath), { recursive: true });
    await writeFile(
      rolloutDiskPath,
      [
        JSON.stringify({
          timestamp: "2026-03-19T01:10:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-rollout-stable-1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T01:10:00.001Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "VSCode is still processing this imported turn",
            local_images: [],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    writeThreadStateRow(config, {
      threadId: "thread-rollout-stable",
      rolloutPath: `/codex-home/${rolloutRelativePath}`,
    });

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-rollout-stable",
        name: "Imported stable running thread",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T01:10:00.000Z",
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
    await service.bindFeishuThread("thread-rollout-stable", {
      chatId: "oc_stable_chat",
      threadKey: "omt_stable_thread",
      rootMessageId: "om_stable_root",
    });

    const firstSync = await service.syncRuntimeThreads();
    const firstTask = firstSync.find((task) => task.taskId === "thread-rollout-stable");
    assert.equal(firstTask?.status, "running");
    assert.equal(firstTask?.activeTurnId, "turn-rollout-stable-1");

    const secondSync = await service.syncRuntimeThreads();
    const secondTask = secondSync.find((task) => task.taskId === "thread-rollout-stable");
    assert.equal(secondTask?.status, "running");
    assert.equal(secondTask?.activeTurnId, "turn-rollout-stable-1");

    await service.dispose();
    await runtime.dispose();
  });

  it("backfills empty imported conversations from host absolute rollout paths during sync", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-host-rollout-path-backfill-test");
    await prepareBridgeDirectories(config);

    const rolloutRelativePath = "sessions/2026/03/19/rollout-host-absolute-backfill.jsonl";
    const rolloutDiskPath = path.join(config.codexHome, rolloutRelativePath);
    await mkdir(path.dirname(rolloutDiskPath), { recursive: true });
    await writeFile(
      rolloutDiskPath,
      [
        JSON.stringify({
          timestamp: "2026-03-19T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Backfilled question",
            local_images: [],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-19T00:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Backfilled answer",
            phase: "final",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const fakeHostCodexHome = "/virtual/host/.codex";
    writeThreadStateRow(config, {
      threadId: "thread-host-absolute-backfill",
      rolloutPath: `${fakeHostCodexHome}/${rolloutRelativePath}`,
    });

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-host-absolute-backfill",
        name: "Host absolute rollout path thread",
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

    const originalHostCodexHome = process.env.HOST_CODEX_HOME;

    try {
      delete process.env.HOST_CODEX_HOME;
      const imported = await service.importRecentRuntimeThreads(1);
      assert.equal(imported.length, 1);
      assert.deepEqual(imported[0].conversation, []);

      process.env.HOST_CODEX_HOME = fakeHostCodexHome;
      const refreshed = await service.syncRuntimeThreads();
      const refreshedTask = refreshed.find((task) => task.taskId === "thread-host-absolute-backfill");
      assert.deepEqual(
        refreshedTask?.conversation.map((entry) => entry.content),
        ["Backfilled question", "Backfilled answer"],
      );
      assert.equal(refreshedTask?.latestSummary, "Backfilled answer");
      assert.equal(refreshedTask?.updatedAt, "2026-03-19T00:00:02.000Z");
    } finally {
      if (originalHostCodexHome === undefined) {
        delete process.env.HOST_CODEX_HOME;
      } else {
        process.env.HOST_CODEX_HOME = originalHostCodexHome;
      }
      await service.dispose();
      await runtime.dispose();
    }
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

  it("resumes imported host threads before sending new messages even after live conversation entries exist", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-import-resume-after-live-message-test");
    await prepareBridgeDirectories(config);

    const runtime = new FakeStatusRuntime();
    runtime.requireResumeBeforeStartTurn(true);
    runtime.setThreads([
      {
        id: "thread-needs-resume-after-live",
        name: "Imported needs resume after live message",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T00:30:00.000Z",
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

    const internalTask = (
      service as unknown as {
        tasks: Map<
          string,
          {
            conversation: Array<{
              messageId: string;
              author: string;
              surface: string;
              content: string;
              createdAt: string;
            }>;
          }
        >;
      }
    ).tasks.get("thread-needs-resume-after-live");
    assert.ok(internalTask);
    internalTask.conversation.push({
      messageId: "live-user-message",
      author: "user",
      surface: "feishu",
      content: "Follow-up from Feishu",
      createdAt: "2026-03-19T00:31:00.000Z",
    });

    assert.equal(runtime.hasResumedThread("thread-needs-resume-after-live"), false);

    await service.sendMessage("thread-needs-resume-after-live", {
      content: "Continue after the earlier live reply",
      source: "feishu",
      replyToFeishu: true,
    });

    assert.equal(runtime.hasResumedThread("thread-needs-resume-after-live"), true);

    await service.dispose();
    await runtime.dispose();
  });

  it("preserves a manually renamed task title when later runtime syncs report the original thread name", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-title-rename-test");
    await prepareBridgeDirectories(config);

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-rename-preserve",
        name: "Imported runtime title",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T02:00:00.000Z",
        status: {
          type: "notLoaded",
        },
      },
    ]);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const [importedTask] = await service.importThreads("thread-rename-preserve");
    assert.equal(importedTask?.title, "Imported runtime title");
    assert.equal(importedTask?.titleLocked, false);

    const renamedTask = await service.renameTask("thread-rename-preserve", {
      title: "Pinned monitor title",
      source: "vscode",
    });
    assert.equal(renamedTask.title, "Pinned monitor title");
    assert.equal(renamedTask.titleLocked, true);

    runtime.setThreads([
      {
        id: "thread-rename-preserve",
        name: "Imported runtime title",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T02:05:00.000Z",
        status: {
          type: "idle",
        },
      },
    ]);

    const syncedTasks = await service.syncRuntimeThreads();
    const syncedTask = syncedTasks.find((task) => task.taskId === "thread-rename-preserve");
    assert.ok(syncedTask);
    assert.equal(syncedTask?.title, "Pinned monitor title");
    assert.equal(syncedTask?.titleLocked, true);

    await service.dispose();
    await runtime.dispose();
  });

  it("locks explicit task titles from Feishu-style creation so later binds and runtime syncs do not reset them", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-created-title-lock-test");
    await prepareBridgeDirectories(config);

    const runtime = new FakeStatusRuntime();
    runtime.setThreads([
      {
        id: "thread-awaiting-approval",
        name: "Needs approval",
        cwd: TEST_REPO_ROOT,
        updatedAt: "2026-03-19T02:10:00.000Z",
        status: {
          type: "active",
          activeFlags: ["waitingOnApproval"],
        },
      },
    ]);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const created = await service.createTask({
      title: "Pinned Feishu title",
      source: "feishu",
      replyToFeishu: true,
    });
    assert.equal(created.title, "Pinned Feishu title");
    assert.equal(created.titleLocked, true);

    const bound = await service.bindFeishuThread(created.taskId, {
      chatId: "oc_chat_id",
      threadKey: "omt_title_lock",
      rootMessageId: "om_title_lock",
    });
    assert.equal(bound.title, "Pinned Feishu title");
    assert.equal(bound.feishuRunningMessageMode, "queue");

    const syncedTasks = await service.syncRuntimeThreads();
    const syncedTask = syncedTasks.find((task) => task.taskId === created.taskId);
    assert.ok(syncedTask);
    assert.equal(syncedTask?.title, "Pinned Feishu title");
    assert.equal(syncedTask?.titleLocked, true);

    await service.dispose();
    await runtime.dispose();
  });

  it("queues Feishu messages by default while a task is awaiting approval", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace);
    const logger = createConsoleLogger("bridge-service-feishu-awaiting-approval-queue-test");
    await prepareBridgeDirectories(config);

    const runtime = new FakeStatusRuntime();
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const created = await service.createTask({
      title: "Approval queue task",
      source: "feishu",
      replyToFeishu: true,
    });
    assert.equal(created.status, "awaiting-approval");
    assert.equal(created.feishuRunningMessageMode, "queue");

    const queued = await service.sendMessage(created.taskId, {
      content: "Check again after approval.",
      source: "feishu",
      replyToFeishu: true,
    });

    assert.equal(queued.status, "awaiting-approval");
    assert.equal(queued.activeTurnId, undefined);
    assert.equal(queued.queuedMessageCount, 1);

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
