import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { createConsoleLogger, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import { createBridgeHttpServer } from "../src/server/http";
import { MockCodexRuntime } from "../src/runtime/mock-codex-runtime";
import { BridgeService } from "../src/service/bridge-service";
import { createTestBridgeConfig, TEST_REPO_ROOT } from "./test-paths";

describe("manual thread import", () => {
  it("imports an externally seeded thread, resumes it, and continues the conversation", async () => {
    const namespace = randomUUID();
    const config = createTestBridgeConfig(namespace, {
      BRIDGE_PORT: "0",
      CODEX_RUNTIME_BACKEND: "mock",
    });
    const logger = createConsoleLogger("manual-import-test");

    await prepareBridgeDirectories(config);

    const runtime = new MockCodexRuntime(config, logger);
    await runtime.start();
    const externalThread = runtime.seedExternalThread({
      name: "External CLI thread",
      cwd: TEST_REPO_ROOT,
    });

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const server = createBridgeHttpServer({ config, logger, runtime, service });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const beforeImport = await fetch(`${baseUrl}/tasks`).then((result) => result.json());
    assert.equal(beforeImport.tasks.length, 0);

    const imported = await fetch(`${baseUrl}/tasks/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        threadId: externalThread.id,
      }),
    }).then((result) => result.json());
    assert.equal(imported.tasks.length, 1);
    assert.equal(imported.tasks[0].mode, "manual-import");

    const resumed = await fetch(`${baseUrl}/tasks/${externalThread.id}/resume`, {
      method: "POST",
    }).then((result) => result.json());
    assert.equal(resumed.task.taskId, externalThread.id);

    await fetch(`${baseUrl}/tasks/${externalThread.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: "Pick up where you left off",
      }),
    }).then((result) => result.json());

    const task = await fetch(`${baseUrl}/tasks/${externalThread.id}`).then((result) => result.json());
    assert.ok(task.task.conversation.some((entry: { author: string }) => entry.author === "user"));
    assert.ok(task.task.conversation.some((entry: { author: string }) => entry.author === "agent"));

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await service.dispose();
    await runtime.dispose();
  });
});
