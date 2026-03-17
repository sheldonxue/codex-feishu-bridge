import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createConsoleLogger, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import { StdioCodexRuntime } from "../src/runtime/stdio-codex-runtime";
import { createTestBridgeConfig, TEST_REPO_ROOT, resolveTestRepoPath } from "./test-paths";

describe("stdio runtime compatibility", () => {
  it("normalizes live-shaped responses and sends expectedTurnId for steer", async () => {
    const namespace = randomUUID();
    const workspaceRoot = TEST_REPO_ROOT;
    const fixturePath = resolveTestRepoPath("apps/bridge-daemon/tests/fixtures/fake-codex-app-server.mjs");
    const config = createTestBridgeConfig(namespace, {
      CODEX_RUNTIME_BACKEND: "stdio",
      CODEX_APP_SERVER_BIN: process.execPath,
      CODEX_APP_SERVER_ARGS: fixturePath,
    });
    const logger = createConsoleLogger("stdio-runtime-test");

    await prepareBridgeDirectories(config);

    const runtime = new StdioCodexRuntime(config, logger);
    await runtime.start();

    const notifications: { method: string; params?: unknown; requestId?: number | string }[] = [];
    const unsubscribe = runtime.onNotification((notification) => {
      notifications.push(notification);
    });

    try {
      const account = await runtime.readAccount(false);
      assert.equal(account.account?.type, "chatgpt");

      const rateLimits = await runtime.readRateLimits();
      assert.equal(rateLimits.rateLimits?.limitId, "codex");

      const models = await runtime.listModels();
      assert.equal(models.length, 1);
      assert.equal(models[0]?.id, "gpt-5.4");
      assert.deepEqual(models[0]?.supportedReasoningEfforts, ["low", "medium", "high"]);

      const listed = await runtime.listThreads();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].id, "thread-live-shape");
      assert.equal(listed[0].updatedAt, "2026-03-16T22:36:40.000Z");

      const read = await runtime.readThread("thread-live-shape");
      assert.equal(read?.createdAt, "2026-03-16T22:26:40.000Z");

      const resumed = await runtime.resumeThread("thread-live-shape");
      assert.equal(resumed.updatedAt, "2026-03-16T22:46:40.000Z");

      const startedThread = await runtime.startThread({
        cwd: workspaceRoot,
        title: "Bridge Runtime Task",
        model: "gpt-5.4",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      assert.equal(startedThread.id, "thread-created");

      const startedTurn = await runtime.startTurn({
        threadId: startedThread.id,
        input: [{ type: "text", text: "Say hello" }],
        model: "gpt-5.4",
        effort: "high",
        approvalPolicy: "never",
      });
      assert.equal(startedTurn.threadId, startedThread.id);

      const steered = await runtime.steerTurn({
        threadId: startedThread.id,
        turnId: startedTurn.id,
        input: [{ type: "text", text: "Keep going" }],
      });
      assert.equal(steered.turnId, startedTurn.id);

      const requestProbe = await (runtime as unknown as {
        client: {
          request<T>(method: string, params?: unknown): Promise<T>;
        };
      }).client.request<{ requests: Array<{ method: string; params: Record<string, unknown> | null }> }>(
        "bridge/test/requests",
        {},
      );
      const steerRequest = requestProbe.requests.find((entry) => entry.method === "turn/steer");
      const threadStartRequest = requestProbe.requests.find((entry) => entry.method === "thread/start");
      const turnStartRequest = requestProbe.requests.find((entry) => entry.method === "turn/start");
      assert.equal(threadStartRequest?.params?.model, "gpt-5.4");
      assert.equal(threadStartRequest?.params?.approvalPolicy, "on-request");
      assert.equal(threadStartRequest?.params?.sandbox, "workspace-write");
      assert.equal(turnStartRequest?.params?.model, "gpt-5.4");
      assert.equal(turnStartRequest?.params?.effort, "high");
      assert.equal(turnStartRequest?.params?.approvalPolicy, "never");
      assert.equal(steerRequest?.params?.expectedTurnId, startedTurn.id);
      assert.equal(steerRequest?.params?.turnId, undefined);

      const startedNotification = notifications.find((entry) => entry.method === "turn/started");
      assert.equal(startedNotification?.requestId, undefined);
      assert.deepEqual(startedNotification?.params, {
        threadId: "thread-created",
        turn: {
          id: "turn-created",
          threadId: "thread-created",
          status: "inProgress",
          items: [],
          error: undefined,
        },
      });
    } finally {
      unsubscribe();
      await runtime.dispose();
    }
  });
});
