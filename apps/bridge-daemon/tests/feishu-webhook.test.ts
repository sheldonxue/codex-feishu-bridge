import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { createConsoleLogger, loadBridgeConfig, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import { FeishuBridge } from "../src/feishu/bridge";
import { createBridgeHttpServer } from "../src/server/http";
import { createCodexRuntime } from "../src/runtime";
import { BridgeService } from "../src/service/bridge-service";

describe("feishu bridge", () => {
  it("binds new tasks to feishu root messages, routes webhook replies, and dedupes repeated events", async () => {
    const namespace = randomUUID();
    const config = loadBridgeConfig(
      {
        WORKSPACE_PATH: "/workspace/codex-feishu-bridge",
        BRIDGE_PORT: "0",
        CODEX_RUNTIME_BACKEND: "mock",
        BRIDGE_STATE_DIR: `.tmp/${namespace}/state`,
        CODEX_HOME: `.tmp/${namespace}/codex-home`,
        BRIDGE_UPLOADS_DIR: `.tmp/${namespace}/uploads`,
        FEISHU_BASE_URL: "https://open.feishu.cn",
        FEISHU_APP_ID: "cli-app-id",
        FEISHU_APP_SECRET: "cli-app-secret",
        FEISHU_VERIFICATION_TOKEN: "verify-token",
        FEISHU_ENCRYPT_KEY: "encrypt-key",
        FEISHU_DEFAULT_CHAT_ID: "oc_chat_id",
      },
      "/workspace/codex-feishu-bridge",
    );
    const logger = createConsoleLogger("feishu-bridge-test");

    await prepareBridgeDirectories(config);

    const calls: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(`${init?.method ?? "GET"} ${url}`);

      if (!url.startsWith("https://open.feishu.cn")) {
        return originalFetch(input, init);
      }

      if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
        return new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: "tenant-token",
            expire: 7200,
          }),
          { status: 200 },
        );
      }

      if (url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              message_id: "om_root_1",
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes("/open-apis/im/v1/messages/")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              message_id: `om_reply_${calls.length}`,
            },
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const runtime = createCodexRuntime(config, logger);
      await runtime.start();

      const service = new BridgeService({ config, logger, runtime });
      await service.initialize();

      const feishu = new FeishuBridge({ config, logger, service });
      await feishu.initialize();

      const server = createBridgeHttpServer({ config, feishu, logger, runtime, service });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });

      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const task = await service.createTask({
        title: "Feishu task",
        prompt: "Please edit the file and patch it.",
      });

      let boundTask = service.getTask(task.taskId);
      for (let attempt = 0; attempt < 10 && !boundTask?.feishuBinding?.rootMessageId; attempt += 1) {
        await delay(20);
        boundTask = service.getTask(task.taskId);
      }
      assert.equal(boundTask?.feishuBinding?.rootMessageId, "om_root_1");
      assert.ok(calls.some((entry) => entry.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")));

      const webhookBody = {
        header: {
          event_id: "evt_1",
          event_type: "im.message.receive_v1",
          token: "verify-token",
        },
        event: {
          sender: {
            sender_id: {
              open_id: "ou_sender",
            },
          },
          message: {
            message_id: "om_reply_request",
            root_id: "om_root_1",
            chat_id: "oc_chat_id",
            message_type: "text",
            content: JSON.stringify({ text: "approve" }),
          },
        },
      };
      const rawWebhookBody = JSON.stringify(webhookBody);
      const timestamp = `${Math.floor(Date.now() / 1000)}`;
      const nonce = "nonce-value";
      const signature = createHmac("sha256", "encrypt-key")
        .update(`${timestamp}${nonce}encrypt-key${rawWebhookBody}`)
        .digest("base64");

      const accepted = await fetch(`${baseUrl}/feishu/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lark-signature": signature,
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonce,
        },
        body: rawWebhookBody,
      }).then((result) => result.json());
      assert.equal(accepted.ok, true);

      let afterApproval = service.getTask(task.taskId);
      for (let attempt = 0; attempt < 10 && afterApproval?.pendingApprovals[0]?.state !== "accepted"; attempt += 1) {
        await delay(20);
        afterApproval = service.getTask(task.taskId);
      }
      assert.equal(afterApproval?.pendingApprovals[0]?.state, "accepted");
      assert.ok(calls.some((entry) => entry.includes("/open-apis/im/v1/messages/om_root_1/reply")));

      const deduped = await fetch(`${baseUrl}/feishu/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lark-signature": signature,
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonce,
        },
        body: rawWebhookBody,
      }).then((result) => result.json());
      assert.equal(deduped.deduped, true);

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
    } finally {
      global.fetch = originalFetch;
    }
  });
});
