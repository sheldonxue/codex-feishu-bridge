import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, it } from "node:test";

import { createConsoleLogger, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import { startRuntimeSocketProxy } from "../src/runtime-socket-proxy";
import { SocketProxyCodexRuntime } from "../src/runtime/socket-proxy-codex-runtime";
import { TEST_REPO_ROOT, createTestBridgeConfig, resolveTestRepoPath } from "./test-paths";

describe("socket-proxy runtime compatibility", () => {
  it("speaks to a host-side codex app-server proxy over a unix socket", async () => {
    const namespace = randomUUID();
    const fixturePath = resolveTestRepoPath("apps/bridge-daemon/tests/fixtures/fake-codex-app-server.mjs");
    const socketPath = path.join(TEST_REPO_ROOT, ".tmp", `socket-proxy-${namespace}.sock`);
    const config = createTestBridgeConfig(namespace, {
      CODEX_RUNTIME_BACKEND: "socket-proxy",
      CODEX_RUNTIME_PROXY_SOCKET: socketPath,
      CODEX_APP_SERVER_BIN: process.execPath,
      CODEX_APP_SERVER_ARGS: fixturePath,
    });
    const logger = createConsoleLogger("socket-proxy-runtime-test");

    await prepareBridgeDirectories(config);

    const originalEnv = {
      WORKSPACE_PATH: process.env.WORKSPACE_PATH,
      CODEX_HOME: process.env.CODEX_HOME,
      BRIDGE_CODEX_HOME: process.env.BRIDGE_CODEX_HOME,
      CODEX_APP_SERVER_BIN: process.env.CODEX_APP_SERVER_BIN,
      CODEX_APP_SERVER_ARGS: process.env.CODEX_APP_SERVER_ARGS,
      CODEX_RUNTIME_PROXY_SOCKET: process.env.CODEX_RUNTIME_PROXY_SOCKET,
    };

    process.env.WORKSPACE_PATH = config.workspaceRoot;
    process.env.CODEX_HOME = config.codexHome;
    process.env.BRIDGE_CODEX_HOME = config.codexHome;
    process.env.CODEX_APP_SERVER_BIN = process.execPath;
    process.env.CODEX_APP_SERVER_ARGS = fixturePath;
    process.env.CODEX_RUNTIME_PROXY_SOCKET = socketPath;

    const proxy = await startRuntimeSocketProxy();
    const runtime = new SocketProxyCodexRuntime(config, logger);

    try {
      await runtime.start();

      const account = await runtime.readAccount(false);
      assert.equal(account.account?.type, "chatgpt");

      const listed = await runtime.listThreads();
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, "thread-live-shape");

      const startedThread = await runtime.startThread({
        cwd: TEST_REPO_ROOT,
        title: "Proxy Runtime Task",
        model: "gpt-5.4",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      assert.equal(startedThread.id, "thread-created");

      const startedTurn = await runtime.startTurn({
        threadId: startedThread.id,
        input: [{ type: "text", text: "Say hello from the socket proxy" }],
        model: "gpt-5.4",
        effort: "high",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      assert.equal(startedTurn.threadId, startedThread.id);

      const steered = await runtime.steerTurn({
        threadId: startedThread.id,
        turnId: startedTurn.id,
        input: [{ type: "text", text: "Keep going from the socket proxy" }],
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
      const turnStartRequest = requestProbe.requests.find((entry) => entry.method === "turn/start");
      assert.equal(turnStartRequest?.params?.sandbox, "danger-full-access");
    } finally {
      await runtime.dispose();
      await proxy.close();
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
