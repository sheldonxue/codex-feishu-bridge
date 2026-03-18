import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { createConsoleLogger, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import { FeishuBridge } from "../src/feishu/bridge";
import { createCodexRuntime } from "../src/runtime";
import { createBridgeHttpServer } from "../src/server/http";
import { BridgeService } from "../src/service/bridge-service";
import { createTestBridgeConfig } from "./test-paths";

interface RequestRecord {
  method: string;
  url: string;
  body?: string;
}

interface FeishuTestHarness {
  baseUrl: string;
  calls: string[];
  requests: RequestRecord[];
  cleanup: () => Promise<void>;
  runtime: ReturnType<typeof createCodexRuntime>;
  service: BridgeService;
}

function parseMessageText(request: RequestRecord): string {
  const payload = JSON.parse(request.body ?? "{}") as { content?: string };
  if (!payload.content) {
    return "";
  }

  try {
    return (JSON.parse(payload.content) as { text?: string }).text ?? "";
  } catch {
    return "";
  }
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

function signWebhook(rawBody: string, encryptKey: string, timestamp: string, nonce: string): string {
  return createHmac("sha256", encryptKey)
    .update(`${timestamp}${nonce}${encryptKey}${rawBody}`)
    .digest("base64");
}

async function postWebhook(
  harness: FeishuTestHarness,
  body: Record<string, unknown>,
  options?: {
    nonce?: string;
    signature?: string;
    timestamp?: string;
  },
): Promise<{ body: any; status: number }> {
  const rawBody = JSON.stringify(body);
  const timestamp = options?.timestamp ?? `${Math.floor(Date.now() / 1000)}`;
  const nonce = options?.nonce ?? `nonce-${randomUUID()}`;
  const signature = options?.signature ?? signWebhook(rawBody, "encrypt-key", timestamp, nonce);

  const response = await fetch(`${harness.baseUrl}/feishu/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lark-signature": signature,
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
    },
    body: rawBody,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function createHarness(envOverrides: Record<string, string> = {}): Promise<FeishuTestHarness> {
  const namespace = randomUUID();
  const config = createTestBridgeConfig(namespace, {
    BRIDGE_PORT: "0",
    CODEX_RUNTIME_BACKEND: "mock",
    FEISHU_BASE_URL: "https://open.feishu.cn",
    FEISHU_APP_ID: "cli-app-id",
    FEISHU_APP_SECRET: "cli-app-secret",
    FEISHU_VERIFICATION_TOKEN: "verify-token",
    FEISHU_ENCRYPT_KEY: "encrypt-key",
    FEISHU_DEFAULT_CHAT_ID: "oc_chat_id",
    ...envOverrides,
  });
  const logger = createConsoleLogger("feishu-webhook-test");

  await prepareBridgeDirectories(config);

  const calls: string[] = [];
  const requests: RequestRecord[] = [];
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body === undefined || init?.body === null
          ? undefined
          : String(init.body);
    calls.push(`${method} ${url}`);
    requests.push({ method, url, body });

    if (!url.startsWith("https://open.feishu.cn")) {
      return originalFetch(input, init);
    }

    if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
        status: 200,
      });
    }

    if (url.includes("/open-apis/im/v1/messages/")) {
      return new Response(JSON.stringify({ code: 0, data: { message_id: `om_reply_${requests.length}` } }), {
        status: 200,
      });
    }

    if (url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")) {
      return new Response(JSON.stringify({ code: 0, data: { message_id: `om_root_${requests.length}` } }), {
        status: 200,
      });
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

    return {
      baseUrl,
      calls,
      requests,
      runtime,
      service,
      cleanup: async () => {
        feishu.dispose();
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
        global.fetch = originalFetch;
      },
    };
  } catch (error) {
    global.fetch = originalFetch;
    throw error;
  }
}

describe("feishu bridge", { concurrency: 1 }, () => {
  it("requires full live webhook configuration before enabling the bridge and does not auto-bind local tasks", async () => {
    const harness = await createHarness({
      FEISHU_VERIFICATION_TOKEN: "",
      FEISHU_ENCRYPT_KEY: "",
    });

    try {
      const health = await fetch(`${harness.baseUrl}/health`).then((result) => result.json());
      assert.equal(health.feishuEnabled, false);

      const created = await harness.service.createTask({
        title: "Disabled Feishu task",
        prompt: "Please edit the file and patch it.",
      });
      await delay(100);

      assert.equal(harness.service.getTask(created.taskId)?.feishuBinding, undefined);
      assert.equal(
        harness.calls.some((entry) => entry.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")),
        false,
      );

      const response = await fetch(`${harness.baseUrl}/feishu/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 503);
    } finally {
      await harness.cleanup();
    }
  });

  it("creates tasks through /new over webhook, binds the current thread, and routes follow-up text back into the same task", async () => {
    const harness = await createHarness();

    try {
      await postWebhook(harness, {
        header: {
          event_id: "evt_new",
          event_type: "im.message.receive_v1",
          token: "verify-token",
        },
        event: {
          sender: {
            sender_id: {
              open_id: "ou_new",
            },
          },
          message: {
            message_id: "om_new",
            root_id: "om_root_webhook",
            thread_id: "omt_webhook",
            chat_id: "oc_chat_id",
            message_type: "text",
            content: JSON.stringify({ text: "/new" }),
          },
        },
      });

      await postWebhook(harness, {
        header: {
          event_id: "evt_prompt",
          event_type: "im.message.receive_v1",
          token: "verify-token",
        },
        event: {
          sender: {
            sender_id: {
              open_id: "ou_new",
            },
          },
          message: {
            message_id: "om_prompt",
            root_id: "om_root_webhook",
            thread_id: "omt_webhook",
            chat_id: "oc_chat_id",
            message_type: "text",
            content: JSON.stringify({ text: "/new prompt hello from webhook" }),
          },
        },
      });

      await postWebhook(harness, {
        header: {
          event_id: "evt_create",
          event_type: "im.message.receive_v1",
          token: "verify-token",
        },
        event: {
          sender: {
            sender_id: {
              open_id: "ou_new",
            },
          },
          message: {
            message_id: "om_create",
            root_id: "om_root_webhook",
            thread_id: "omt_webhook",
            chat_id: "oc_chat_id",
            message_type: "text",
            content: JSON.stringify({ text: "/new create" }),
          },
        },
      });

      await waitFor(() => harness.service.listTasks().length === 1, "webhook task creation");
      const createdTask = harness.service.listTasks()[0];
      assert.ok(createdTask);
      assert.equal(createdTask?.feishuBinding?.threadKey, "omt_webhook");
      assert.equal(
        harness.calls.some((entry) => entry.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")),
        false,
      );
      await waitFor(
        () => harness.requests.some((request) => parseMessageText(request).includes("Mock response for: hello from webhook")),
        "webhook final agent reply",
      );

      const previousConversationLength = harness.service.getTask(createdTask!.taskId)?.conversation.length ?? 0;
      await postWebhook(harness, {
        header: {
          event_id: "evt_follow_up",
          event_type: "im.message.receive_v1",
          token: "verify-token",
        },
        event: {
          sender: {
            sender_id: {
              open_id: "ou_new",
            },
          },
          message: {
            message_id: "om_follow_up",
            root_id: "om_root_webhook",
            thread_id: "omt_webhook",
            chat_id: "oc_chat_id",
            message_type: "text",
            content: JSON.stringify({ text: "second webhook prompt" }),
          },
        },
      });

      await waitFor(
        () => (harness.service.getTask(createdTask!.taskId)?.conversation.length ?? 0) > previousConversationLength,
        "follow-up routing",
      );
      await waitFor(
        () => harness.requests.some((request) => parseMessageText(request).includes("Mock response for: second webhook prompt")),
        "follow-up final reply",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects webhook events when the verification token or signature is invalid", async () => {
    const harness = await createHarness();

    try {
      const invalidToken = await postWebhook(harness, {
        header: {
          event_id: "evt_invalid_token",
          event_type: "im.message.receive_v1",
          token: "wrong-token",
        },
        event: {
          message: {
            message_id: "om_invalid",
            message_type: "text",
            content: JSON.stringify({ text: "/new" }),
          },
        },
      });
      assert.equal(invalidToken.status, 403);
      assert.equal(invalidToken.body.error, "invalid feishu signature or token");

      const rawBody = JSON.stringify({
        header: {
          event_id: "evt_invalid_signature",
          event_type: "im.message.receive_v1",
          token: "verify-token",
        },
        event: {
          message: {
            message_id: "om_invalid_signature",
            message_type: "text",
            content: JSON.stringify({ text: "/new" }),
          },
        },
      });
      const invalidSignature = await fetch(`${harness.baseUrl}/feishu/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lark-signature": "bad-signature",
          "x-lark-request-timestamp": "1700000001",
          "x-lark-request-nonce": "nonce-invalid",
        },
        body: rawBody,
      });
      assert.equal(invalidSignature.status, 403);
      assert.equal((await invalidSignature.json()).error, "invalid feishu signature or token");
    } finally {
      await harness.cleanup();
    }
  });

  it("routes slash approval commands to an explicitly bound task without creating new thread roots", async () => {
    const harness = await createHarness();
    const approvalDecisions: Array<{ requestId: number | string; result: unknown }> = [];
    const originalRespondToRequest = harness.runtime.respondToRequest.bind(harness.runtime);
    harness.runtime.respondToRequest = async (requestId, result) => {
      approvalDecisions.push({ requestId, result });
      await originalRespondToRequest(requestId, result);
    };

    try {
      const task = await harness.service.createTask({
        title: "Approval task",
        prompt: "Please edit the file and patch it.",
      });
      await waitFor(
        () => (harness.service.getTask(task.taskId)?.pendingApprovals.length ?? 0) > 0,
        "pending approval",
      );
      await harness.service.bindFeishuThread(task.taskId, {
        chatId: "oc_chat_id",
        threadKey: "omt_bound",
        rootMessageId: "om_root_bound",
      });

      await postWebhook(harness, {
        header: {
          event_id: "evt_approve",
          event_type: "im.message.receive_v1",
          token: "verify-token",
        },
        event: {
          sender: {
            sender_id: {
              open_id: "ou_approve",
            },
          },
          message: {
            message_id: "om_approve",
            root_id: "om_root_bound",
            thread_id: "omt_bound",
            chat_id: "oc_chat_id",
            message_type: "text",
            content: JSON.stringify({ text: "/approve" }),
          },
        },
      });

      await waitFor(() => approvalDecisions.length > 0, "approval routing");
      assert.deepEqual(approvalDecisions[0]?.result, { decision: "accept" });
      await delay(50);
      assert.equal(
        harness.requests.some((request) => parseMessageText(request).includes("Approval resolved for")),
        false,
      );
      assert.equal(
        harness.requests.some((request) => parseMessageText(request).includes("approve applied to approval")),
        false,
      );
      assert.equal(
        harness.calls.some((entry) => entry.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")),
        false,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("syncs imported conversation delta replies back into bound Feishu threads", async () => {
    const harness = await createHarness();

    try {
      const task = await harness.service.createTask({
        title: "Imported delta task",
      });
      await harness.service.bindFeishuThread(task.taskId, {
        chatId: "oc_chat_id",
        threadKey: "omt_imported_delta",
        rootMessageId: "om_root_imported_delta",
      });

      const boundTask = harness.service.getTask(task.taskId);
      assert.ok(boundTask);

      await (harness.service as any).emitEvent(task.taskId, "task.updated", {
        task: boundTask,
        importedConversationDelta: [
          {
            messageId: "thread-imported:imported:2",
            author: "user",
            surface: "runtime",
            content: "Second imported question",
            createdAt: "2026-03-19T00:00:03.000Z",
          },
          {
            messageId: "thread-imported:imported:3",
            author: "agent",
            surface: "runtime",
            content: "Second imported answer",
            createdAt: "2026-03-19T00:00:04.000Z",
          },
        ],
      });

      await waitFor(
        () => harness.requests.some((request) => parseMessageText(request).includes("Second imported answer")),
        "imported delta reply sync",
      );
    } finally {
      await harness.cleanup();
    }
  });
});
