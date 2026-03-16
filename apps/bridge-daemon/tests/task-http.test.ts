import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { WebSocket } from "ws";

import { createConsoleLogger, loadBridgeConfig, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import { createCodexRuntime } from "../src/runtime";
import { createBridgeHttpServer } from "../src/server/http";
import { BridgeService } from "../src/service/bridge-service";

describe("bridge daemon task http server", () => {
  it("orchestrates tasks, uploads, approvals, and websocket snapshots", async () => {
    const namespace = randomUUID();
    const config = loadBridgeConfig(
      {
        WORKSPACE_PATH: "/workspace/codex-feishu-bridge",
        BRIDGE_PORT: "0",
        BRIDGE_WS_PATH: "/ws",
        CODEX_RUNTIME_BACKEND: "mock",
        MOCK_AUTO_COMPLETE_LOGIN: "true",
        BRIDGE_STATE_DIR: `.tmp/${namespace}/state`,
        CODEX_HOME: `.tmp/${namespace}/codex-home`,
        BRIDGE_UPLOADS_DIR: `.tmp/${namespace}/uploads`,
      },
      "/workspace/codex-feishu-bridge",
    );
    const logger = createConsoleLogger("bridge-daemon-task-test");

    await prepareBridgeDirectories(config);

    const runtime = createCodexRuntime(config, logger);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const server = createBridgeHttpServer({ config, logger, runtime, service });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const wsMessages: unknown[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${config.wsPath}`);

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
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

    await delay(20);

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
      }),
    }).then((result) => result.json());
    assert.equal(replied.task.taskId, secondTaskId);

    await delay(20);

    const firstTask = await fetch(`${baseUrl}/tasks/${firstTaskId}`).then((result) => result.json());
    assert.ok(firstTask.task.conversation.some((entry: { author: string }) => entry.author === "agent"));

    const secondTaskSnapshot = await fetch(`${baseUrl}/tasks/${secondTaskId}`).then((result) => result.json());
    assert.equal(secondTaskSnapshot.task.imageAssets.length, 1);
    assert.ok(secondTaskSnapshot.task.conversation.some((entry: { author: string }) => entry.author === "user"));

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

    ws.close();
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
