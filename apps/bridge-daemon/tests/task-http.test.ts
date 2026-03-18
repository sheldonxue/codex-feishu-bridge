import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import { WebSocket } from "ws";

import { createBridgeTask } from "@codex-feishu-bridge/protocol";
import { createConsoleLogger, prepareBridgeDirectories, writeJsonFile } from "@codex-feishu-bridge/shared";

import { FeishuBridge } from "../src/feishu/bridge";
import { createCodexRuntime } from "../src/runtime";
import { createBridgeHttpServer } from "../src/server/http";
import { BridgeService } from "../src/service/bridge-service";
import { createTestBridgeConfig } from "./test-paths";

async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await delay(20);
  }

  throw new Error(`Timed out waiting for ${message}`);
}

function parseFeishuText(requestBody?: string): string {
  if (!requestBody) {
    return "";
  }

  const payload = JSON.parse(requestBody) as { content?: string };
  if (!payload.content) {
    return "";
  }

  return (JSON.parse(payload.content) as { text?: string }).text ?? "";
}

describe("bridge daemon task http server", () => {
  it("orchestrates tasks, uploads, approvals, and websocket snapshots", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace, {
      BRIDGE_PORT: "0",
      BRIDGE_WS_PATH: "/ws",
      CODEX_RUNTIME_BACKEND: "mock",
      MOCK_AUTO_COMPLETE_LOGIN: "true",
    });
    const logger = createConsoleLogger("bridge-daemon-task-test");

    await prepareBridgeDirectories(config);

    const runtime = createCodexRuntime(config, logger);
    const service = new BridgeService({ config, logger, runtime });
    const server = createBridgeHttpServer({ config, logger, runtime, service });
    let ws: WebSocket | undefined;

    try {
      await runtime.start();
      await service.initialize();

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });

      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const wsMessages: unknown[] = [];
      ws = new WebSocket(`ws://127.0.0.1:${address.port}${config.wsPath}`);

      await new Promise<void>((resolve, reject) => {
        ws!.once("open", () => resolve());
        ws!.once("error", reject);
      });

      ws.on("message", (payload) => {
        wsMessages.push(JSON.parse(payload.toString("utf8")));
      });

      const created = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Edit Task",
          prompt: "Please edit the file and patch it.",
        }),
      }).then((result) => result.json());

      const firstTaskId = created.task.taskId as string;
      assert.equal(created.task.mode, "bridge-managed");

      const secondTask = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Image Task",
        }),
      }).then((result) => result.json());

      const secondTaskId = secondTask.task.taskId as string;
      assert.notEqual(firstTaskId, secondTaskId);

      await waitFor(() => service.listTasks().length === 2, "task creation");

      const tasks = await fetch(`${baseUrl}/tasks`).then((result) => result.json());
      assert.equal(tasks.tasks.length, 2);

      const awaitingApproval = tasks.tasks.find((entry: { taskId: string }) => entry.taskId === firstTaskId);
      assert.equal(awaitingApproval.status, "awaiting-approval");
      assert.equal(awaitingApproval.pendingApprovals.length, 1);

      const approvalRequestId = awaitingApproval.pendingApprovals[0].requestId;
      const resolved = await fetch(`${baseUrl}/tasks/${firstTaskId}/approvals/${approvalRequestId}/resolve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          decision: "accept",
        }),
      }).then((result) => result.json());
      assert.equal(resolved.task.pendingApprovals[0].state, "accepted");

      const upload = await fetch(`${baseUrl}/tasks/${secondTaskId}/uploads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          fileName: "screen.txt",
          mimeType: "text/plain",
          contentBase64: Buffer.from("sample-image", "utf8").toString("base64"),
        }),
      }).then((result) => result.json());
      assert.equal(upload.asset.mimeType, "text/plain");

      const replied = await fetch(`${baseUrl}/tasks/${secondTaskId}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          content: "Please summarize the attachment",
          imageAssetIds: [upload.asset.assetId],
          source: "vscode",
          replyToFeishu: false,
        }),
      }).then((result) => result.json());
      assert.equal(replied.task.taskId, secondTaskId);

      const bound = await fetch(`${baseUrl}/tasks/${secondTaskId}/feishu/bind`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chatId: "oc_chat",
          threadKey: "omt_bound",
          rootMessageId: "om_root",
        }),
      }).then((result) => result.json());
      assert.equal(bound.task.desktopReplySyncToFeishu, true);

      const updatedSettings = await fetch(`${baseUrl}/tasks/${secondTaskId}/settings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          desktopReplySyncToFeishu: false,
        }),
      }).then((result) => result.json());
      assert.equal(updatedSettings.task.desktopReplySyncToFeishu, false);

      const unbound = await fetch(`${baseUrl}/tasks/${secondTaskId}/feishu/unbind`, {
        method: "POST",
      }).then((result) => result.json());
      assert.equal(unbound.task.feishuBinding, undefined);

      const forgotten = await fetch(`${baseUrl}/tasks/${secondTaskId}/forget`, {
        method: "POST",
      }).then((result) => result.json());
      assert.equal(forgotten.taskId, secondTaskId);
      assert.equal(service.getTask(secondTaskId), null);

      const imported = await fetch(`${baseUrl}/tasks/import/recent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          limit: 5,
        }),
      }).then((result) => result.json());
      assert.ok(Array.isArray(imported.tasks));

      const clearedImported = await fetch(`${baseUrl}/tasks/forget/imported`, {
        method: "POST",
      }).then((result) => result.json());
      assert.ok(Array.isArray(clearedImported.removedTaskIds));

      await waitFor(() => {
        const secondTaskSnapshot = service.getTask(firstTaskId);
        return Boolean(
          secondTaskSnapshot?.pendingApprovals.length === 1 &&
            secondTaskSnapshot.pendingApprovals[0]?.state === "accepted",
        );
      }, "task snapshots");

      const missingForgottenTask = await fetch(`${baseUrl}/tasks/${secondTaskId}`);
      assert.equal(missingForgottenTask.status, 404);

      assert.ok(
        wsMessages.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as { type?: string }).type === "event" &&
            ((entry as { event?: { kind?: string } }).event?.kind === "approval.requested" ||
              (entry as { event?: { kind?: string } }).event?.kind === "task.image.added"),
        ),
      );
    } finally {
      ws?.removeAllListeners();
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await service.dispose();
      await runtime.dispose();
    }
  });

  it("creates a new default Feishu topic and binds an existing task through HTTP", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace, {
      BRIDGE_PORT: "0",
      BRIDGE_WS_PATH: "/ws",
      CODEX_RUNTIME_BACKEND: "mock",
      MOCK_AUTO_COMPLETE_LOGIN: "true",
      FEISHU_BASE_URL: "https://open.feishu.cn",
      FEISHU_APP_ID: "cli-app-id",
      FEISHU_APP_SECRET: "cli-app-secret",
      FEISHU_DEFAULT_CHAT_ID: "oc_chat_id",
      FEISHU_VERIFICATION_TOKEN: "",
      FEISHU_ENCRYPT_KEY: "",
    });
    const logger = createConsoleLogger("bridge-daemon-feishu-topic-test");
    const requests: Array<{ method: string; url: string; body?: string }> = [];

    await prepareBridgeDirectories(config);

    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body =
        typeof init?.body === "string"
          ? init.body
          : init?.body === undefined || init?.body === null
            ? undefined
            : String(init.body);
      requests.push({
        method: init?.method ?? "GET",
        url,
        body,
      });

      if (!url.startsWith("https://open.feishu.cn")) {
        return originalFetch(input, init);
      }

      if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
        });
      }

      if (url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: "om_root_new_topic" } }), {
          status: 200,
        });
      }

      if (url.includes("/open-apis/im/v1/messages/")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_task_card" } }), {
          status: 200,
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const runtime = createCodexRuntime(config, logger);
    const service = new BridgeService({ config, logger, runtime });
    const feishu = new FeishuBridge({
      config,
      logger,
      service,
      longConnectionFactory: async () => ({
        stop: async () => {},
      }),
    });
    const server = createBridgeHttpServer({ config, feishu, logger, runtime, service });

    try {
      await runtime.start();
      await service.initialize();
      await feishu.initialize();

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });

      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const task = await service.createTask({
        title: "Desk handoff task",
      });

      const response = await fetch(`${baseUrl}/tasks/${task.taskId}/feishu/topic`, {
        method: "POST",
      }).then((result) => result.json());

      assert.equal(response.task.feishuBinding?.chatId, "oc_chat_id");
      assert.equal(response.task.feishuBinding?.threadKey, "om_root_new_topic");
      assert.equal(response.task.feishuBinding?.rootMessageId, "om_root_new_topic");
      assert.equal(response.task.desktopReplySyncToFeishu, true);

      await waitFor(
        () => requests.some((request) => request.url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")),
        "new Feishu root topic",
      );
      await waitFor(
        () => requests.some((request) => request.url.includes("/open-apis/im/v1/messages/om_root_new_topic/reply")),
        "task control card reply",
      );

      const rootMessage = requests.find((request) => request.url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id"));
      assert.match(parseFeishuText(rootMessage?.body), /Codex task linked from VSCode monitor/);
      assert.match(parseFeishuText(rootMessage?.body), /Task ID: /);
    } finally {
      global.fetch = originalFetch;
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      feishu.dispose();
      await service.dispose();
      await runtime.dispose();
    }
  });

  it("permanently deletes local imported tasks from bridge state and codex home", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace, {
      BRIDGE_PORT: "0",
      BRIDGE_WS_PATH: "/ws",
      CODEX_RUNTIME_BACKEND: "mock",
      MOCK_AUTO_COMPLETE_LOGIN: "true",
    });
    const logger = createConsoleLogger("bridge-daemon-delete-local-test");

    await prepareBridgeDirectories(config);

    const threadId = "thr-delete-local";
    const rolloutRelativePath = "sessions/2026/03/19/rollout-delete-local.jsonl";
    const rolloutDiskPath = path.join(config.codexHome, rolloutRelativePath);
    await mkdir(path.dirname(rolloutDiskPath), { recursive: true });
    await writeFile(rolloutDiskPath, "{}\n", "utf8");

    const stateDb = new DatabaseSync(path.join(config.codexHome, "state_5.sqlite"));
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        has_user_event INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        cli_version TEXT NOT NULL DEFAULT '',
        first_user_message TEXT NOT NULL DEFAULT '',
        agent_nickname TEXT,
        agent_role TEXT,
        memory_mode TEXT NOT NULL DEFAULT 'enabled'
      );
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        ts_nanos INTEGER NOT NULL,
        level TEXT NOT NULL,
        target TEXT NOT NULL,
        message TEXT,
        module_path TEXT,
        file TEXT,
        line INTEGER,
        thread_id TEXT,
        process_uuid TEXT,
        estimated_bytes INTEGER NOT NULL DEFAULT 0
      );
    `);
    stateDb
      .prepare(`
        INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
          sandbox_policy, approval_mode, tokens_used, has_user_event, archived, cli_version,
          first_user_message, memory_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '', '', 'enabled')
      `)
      .run(
        threadId,
        `/codex-home/${rolloutRelativePath}`,
        Date.now(),
        Date.now(),
        "test",
        "openai",
        config.workspaceRoot,
        "Delete local task",
        "workspace-write",
        "on-request",
      );
    stateDb.prepare("INSERT INTO logs (ts, ts_nanos, level, target, thread_id) VALUES (?, ?, ?, ?, ?)").run(
      Date.now(),
      0,
      "INFO",
      "test",
      threadId,
    );
    stateDb.close();

    const logsDb = new DatabaseSync(path.join(config.codexHome, "logs_1.sqlite"));
    logsDb.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        ts_nanos INTEGER NOT NULL,
        level TEXT NOT NULL,
        target TEXT NOT NULL,
        message TEXT,
        module_path TEXT,
        file TEXT,
        line INTEGER,
        thread_id TEXT,
        process_uuid TEXT,
        estimated_bytes INTEGER NOT NULL DEFAULT 0
      );
    `);
    logsDb.prepare("INSERT INTO logs (ts, ts_nanos, level, target, thread_id) VALUES (?, ?, ?, ?, ?)").run(
      Date.now(),
      0,
      "INFO",
      "test",
      threadId,
    );
    logsDb.close();

    const task = createBridgeTask({
      threadId,
      title: "Imported local task",
      workspaceRoot: config.workspaceRoot,
      mode: "manual-import",
    });
    await writeJsonFile(path.join(config.stateDir, "tasks.json"), {
      seq: 0,
      tasks: [task],
    });

    const runtime = createCodexRuntime(config, logger);
    const service = new BridgeService({ config, logger, runtime });
    const server = createBridgeHttpServer({ config, logger, runtime, service });

    try {
      await runtime.start();
      await service.initialize();

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });

      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const deleted = await fetch(`${baseUrl}/tasks/${threadId}/delete-local`, {
        method: "POST",
      }).then((result) => result.json());

      assert.equal(deleted.taskId, threadId);
      assert.equal(service.getTask(threadId), null);

      const stateDbAfter = new DatabaseSync(path.join(config.codexHome, "state_5.sqlite"));
      assert.equal(stateDbAfter.prepare("SELECT COUNT(*) AS count FROM threads WHERE id = ?").get(threadId).count, 0);
      assert.equal(stateDbAfter.prepare("SELECT COUNT(*) AS count FROM logs WHERE thread_id = ?").get(threadId).count, 0);
      stateDbAfter.close();

      const logsDbAfter = new DatabaseSync(path.join(config.codexHome, "logs_1.sqlite"));
      assert.equal(logsDbAfter.prepare("SELECT COUNT(*) AS count FROM logs WHERE thread_id = ?").get(threadId).count, 0);
      logsDbAfter.close();

      const remainingTasks = await fetch(`${baseUrl}/tasks`).then((result) => result.json());
      assert.equal(remainingTasks.tasks.length, 0);

      await assert.rejects(() => fetch(`${baseUrl}/tasks/${threadId}`).then((result) => {
        if (!result.ok) {
          throw new Error(`status=${result.status}`);
        }
      }));

      await assert.rejects(() => writeFile(rolloutDiskPath, "still here\n", { flag: "r+" }));
    } finally {
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await service.dispose();
      await runtime.dispose();
    }
  });
});
