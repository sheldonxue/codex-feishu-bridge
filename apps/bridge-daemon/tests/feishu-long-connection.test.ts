import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { createConsoleLogger, loadBridgeConfig, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import { FeishuBridge } from "../src/feishu/bridge";
import { createCodexRuntime } from "../src/runtime";
import { BridgeService } from "../src/service/bridge-service";

function textInputs(
  input: Array<{ type: string; text?: string }>,
): string[] {
  return input.filter((item): item is { type: "text"; text: string } => item.type === "text" && Boolean(item.text)).map((item) => item.text);
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await delay(20);
  }

  throw new Error(`Timed out waiting for ${message}`);
}

describe("feishu long connection ingress", () => {
  it("routes im.message.receive_v1 events from long connection with dedupe", async () => {
    const namespace = randomUUID();
    const workspaceRoot = process.cwd();
    const config = loadBridgeConfig(
      {
        WORKSPACE_PATH: workspaceRoot,
        BRIDGE_STATE_DIR: path.join(".tmp", namespace, "state"),
        CODEX_HOME: path.join(".tmp", namespace, "codex-home"),
        BRIDGE_UPLOADS_DIR: path.join(".tmp", namespace, "uploads"),
        CODEX_RUNTIME_BACKEND: "mock",
        FEISHU_BASE_URL: "https://open.feishu.cn",
        FEISHU_APP_ID: "cli-app-id",
        FEISHU_APP_SECRET: "cli-app-secret",
        FEISHU_DEFAULT_CHAT_ID: "oc_chat_id",
        FEISHU_VERIFICATION_TOKEN: "",
        FEISHU_ENCRYPT_KEY: "",
      },
      workspaceRoot,
    );
    const logger = createConsoleLogger("feishu-long-connection-test");

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
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
        });
      }

      if (url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: `om_root_${calls.length}` } }), {
          status: 200,
        });
      }

      if (url.includes("/open-apis/im/v1/messages/")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: `om_reply_${calls.length}` } }), {
          status: 200,
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const interruptCalls: Array<{ threadId: string; turnId?: string }> = [];

    let onMessage: ((message?: any, sender?: any) => Promise<void>) | null = null;

    const longConnectionFactory = async (params: { onMessage: (message?: any, sender?: any) => Promise<void> }) => {
      onMessage = params.onMessage;
      return {
        stop: async () => {},
      };
    };

    try {
      const runtime = createCodexRuntime(config, logger);
      const originalInterruptTurn = runtime.interruptTurn.bind(runtime);
      runtime.interruptTurn = async (params) => {
        interruptCalls.push(params);
        await originalInterruptTurn(params);
      };

      await runtime.start();
      const service = new BridgeService({ config, logger, runtime });
      await service.initialize();

      const feishu = new FeishuBridge({ config, logger, service, longConnectionFactory });
      await feishu.initialize();

      const task = await service.createTask({
        title: "Long connection task",
        prompt: "Please edit the file and patch it.",
      });

      await waitFor(() => Boolean(service.getTask(task.taskId)?.feishuBinding?.rootMessageId), "feishu binding");
      const rootId = service.getTask(task.taskId)?.feishuBinding?.rootMessageId ?? "";

      assert.ok(onMessage, "long connection handler should be registered");

      await onMessage?.(
        {
          message_id: "om_long_interrupt",
          root_id: rootId,
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "interrupt" }),
        },
        {
          sender_id: {
            open_id: "ou_long",
          },
        },
      );

      await waitFor(() => interruptCalls.length > 0, "interrupt via long connection");
      assert.equal(interruptCalls.at(-1)?.threadId, task.taskId);

      // dedupe same message id
      await onMessage?.(
        {
          message_id: "om_long_interrupt",
          root_id: rootId,
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "interrupt" }),
        },
        {
          sender_id: {
            open_id: "ou_long",
          },
        },
      );

      assert.equal(interruptCalls.length, 1);
      assert.ok(calls.some((entry) => entry.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")));

      await feishu.dispose();
      await service.dispose();
      await runtime.dispose();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
