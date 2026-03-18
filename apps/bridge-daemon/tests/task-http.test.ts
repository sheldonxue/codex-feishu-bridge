import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { WebSocket } from "ws";

import { createConsoleLogger, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

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
});
