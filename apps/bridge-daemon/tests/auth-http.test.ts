import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { createConsoleLogger, loadBridgeConfig, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import { createCodexRuntime } from "../src/runtime";
import { createBridgeHttpServer } from "../src/server/http";

describe("bridge daemon auth http server", () => {
  it("serves health and auth endpoints with the mock runtime", async () => {
    const config = loadBridgeConfig(
      {
        WORKSPACE_PATH: "/workspace/codex-feishu-bridge",
        BRIDGE_PORT: "0",
        CODEX_RUNTIME_BACKEND: "mock",
        MOCK_AUTO_COMPLETE_LOGIN: "true",
        CODEX_HOME: ".tmp/test-codex-home",
        BRIDGE_UPLOADS_DIR: ".tmp/test-uploads",
      },
      "/workspace/codex-feishu-bridge",
    );
    const logger = createConsoleLogger("bridge-daemon-test");

    await prepareBridgeDirectories(config);

    const runtime = createCodexRuntime(config, logger);
    await runtime.start();

    const server = createBridgeHttpServer({ config, logger, runtime });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${baseUrl}/health`).then((result) => result.json());
    assert.equal(health.status, "ok");
    assert.equal(health.runtime.backend, "mock");

    const login = await fetch(`${baseUrl}/auth/login/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "chatgpt" }),
    }).then((result) => result.json());
    assert.equal(login.type, "chatgpt");
    assert.equal(typeof login.authUrl, "string");

    const account = await fetch(`${baseUrl}/auth/account`).then((result) => result.json());
    assert.equal(account.account.type, "chatgpt");
    assert.equal(account.account.planType, "pro");

    const rateLimits = await fetch(`${baseUrl}/auth/rate-limits`).then((result) => result.json());
    assert.equal(rateLimits.rateLimits.limitId, "codex");

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await runtime.dispose();
  });
});
