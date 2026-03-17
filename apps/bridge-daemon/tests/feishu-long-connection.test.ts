import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { createConsoleLogger, loadBridgeConfig, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import { FeishuBridge } from "../src/feishu/bridge";
import { createCodexRuntime } from "../src/runtime";
import { BridgeService } from "../src/service/bridge-service";

interface RequestRecord {
  method: string;
  url: string;
  body?: string;
}

interface LongConnectionHarness {
  calls: string[];
  requests: RequestRecord[];
  runtime: ReturnType<typeof createCodexRuntime>;
  service: BridgeService;
  cleanup: () => Promise<void>;
  onMessage: (message?: unknown, sender?: unknown) => Promise<void>;
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

async function createHarness(envOverrides: Record<string, string> = {}): Promise<LongConnectionHarness> {
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
      ...envOverrides,
    },
    workspaceRoot,
  );
  const logger = createConsoleLogger("feishu-long-connection-test");

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

  let onMessage: ((message?: unknown, sender?: unknown) => Promise<void>) | null = null;
  const longConnectionFactory = async (params: {
    onMessage: (message?: unknown, sender?: unknown) => Promise<void>;
  }) => {
    onMessage = params.onMessage;
    return {
      stop: async () => {},
    };
  };

  try {
    const runtime = createCodexRuntime(config, logger);
    await runtime.start();

    const service = new BridgeService({ config, logger, runtime });
    await service.initialize();

    const feishu = new FeishuBridge({ config, logger, service, longConnectionFactory });
    await feishu.initialize();

    return {
      calls,
      requests,
      runtime,
      service,
      onMessage: async (message?: unknown, sender?: unknown) => {
        assert.ok(onMessage, "long connection handler should be registered");
        await onMessage?.(message, sender);
      },
      cleanup: async () => {
        feishu.dispose();
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

describe("feishu long connection ingress", () => {
  it("keeps unbound threads quiet and creates a bound task through the /new wizard", async () => {
    const harness = await createHarness();

    try {
      await harness.onMessage(
        {
          message_id: "om_plain",
          thread_id: "omt_new_task",
          root_id: "om_root_new_task",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "hello before binding" }),
        },
        {
          sender_id: {
            open_id: "ou_plain",
          },
        },
      );

      await delay(50);
      assert.equal(harness.service.listTasks().length, 0);
      assert.equal(
        harness.requests.some((request) => request.url.includes("/open-apis/im/v1/messages/")),
        false,
      );

      await harness.onMessage(
        {
          message_id: "om_new",
          thread_id: "omt_new_task",
          root_id: "om_root_new_task",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/new" }),
        },
        {
          sender_id: {
            open_id: "ou_new",
          },
        },
      );
      await waitFor(
        () => harness.requests.some((request) => parseMessageText(request).includes("Current /new draft")),
        "/new draft response",
      );

      await harness.onMessage(
        {
          message_id: "om_new_prompt",
          thread_id: "omt_new_task",
          root_id: "om_root_new_task",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/new prompt hello from feishu" }),
        },
        {
          sender_id: {
            open_id: "ou_new",
          },
        },
      );

      await harness.onMessage(
        {
          message_id: "om_new_create",
          thread_id: "omt_new_task",
          root_id: "om_root_new_task",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/new create" }),
        },
        {
          sender_id: {
            open_id: "ou_new",
          },
        },
      );

      await waitFor(() => harness.service.listTasks().length === 1, "task creation");
      const createdTask = harness.service.listTasks()[0];
      assert.ok(createdTask);
      assert.equal(createdTask?.feishuBinding?.threadKey, "omt_new_task");
      assert.equal(createdTask?.executionProfile.sandbox, "workspace-write");
      assert.equal(createdTask?.executionProfile.approvalPolicy, "on-request");
      assert.equal(
        harness.calls.some((entry) => entry.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")),
        false,
      );

      await waitFor(
        () => harness.requests.some((request) => parseMessageText(request).includes("Created task")),
        "task creation reply",
      );
      await waitFor(
        () => harness.requests.some((request) => parseMessageText(request).includes("Mock response for: hello from feishu")),
        "first final agent reply",
      );

      const previousConversationLength = harness.service.getTask(createdTask!.taskId)?.conversation.length ?? 0;
      await harness.onMessage(
        {
          message_id: "om_follow_up",
          thread_id: "omt_new_task",
          root_id: "om_root_new_task",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "second prompt" }),
        },
        {
          sender_id: {
            open_id: "ou_new",
          },
        },
      );

      await waitFor(
        () => (harness.service.getTask(createdTask!.taskId)?.conversation.length ?? 0) > previousConversationLength,
        "follow-up routing",
      );
      await waitFor(
        () => harness.requests.some((request) => parseMessageText(request).includes("Mock response for: second prompt")),
        "follow-up final agent reply",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("lists models and falls back to the model default effort when the current one is unsupported", async () => {
    const harness = await createHarness();

    try {
      await harness.onMessage(
        {
          message_id: "om_models_init",
          thread_id: "omt_models",
          root_id: "om_root_models",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/new" }),
        },
        {
          sender_id: {
            open_id: "ou_models",
          },
        },
      );

      await harness.onMessage(
        {
          message_id: "om_models_list",
          thread_id: "omt_models",
          root_id: "om_root_models",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/new models" }),
        },
        {
          sender_id: {
            open_id: "ou_models",
          },
        },
      );
      await waitFor(
        () => harness.requests.some((request) => parseMessageText(request).includes("Available models:")),
        "model list reply",
      );

      await harness.onMessage(
        {
          message_id: "om_effort_xhigh",
          thread_id: "omt_models",
          root_id: "om_root_models",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/new effort xhigh" }),
        },
        {
          sender_id: {
            open_id: "ou_models",
          },
        },
      );

      await harness.onMessage(
        {
          message_id: "om_model_mini",
          thread_id: "omt_models",
          root_id: "om_root_models",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/new model gpt-5.4-mini" }),
        },
        {
          sender_id: {
            open_id: "ou_models",
          },
        },
      );

      await waitFor(
        () =>
          harness.requests.some((request) =>
            parseMessageText(request).includes("effort reverted to low because gpt-5.4-mini does not support the previous value."),
          ),
        "effort fallback reply",
      );

      await harness.onMessage(
        {
          message_id: "om_create_mini",
          thread_id: "omt_models",
          root_id: "om_root_models",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/new create" }),
        },
        {
          sender_id: {
            open_id: "ou_models",
          },
        },
      );

      await waitFor(() => harness.service.listTasks().length === 1, "task creation from model draft");
      const task = harness.service.listTasks()[0];
      assert.equal(task?.executionProfile.model, "gpt-5.4-mini");
      assert.equal(task?.executionProfile.effort, "low");
    } finally {
      await harness.cleanup();
    }
  });

  it("supports slash bind, status, unbind, and approve commands without implicit root-thread creation", async () => {
    const harness = await createHarness();
    const originalRespondToRequest = harness.runtime.respondToRequest.bind(harness.runtime);
    const approvalDecisions: Array<{ requestId: number | string; result: unknown }> = [];
    harness.runtime.respondToRequest = async (requestId, result) => {
      approvalDecisions.push({ requestId, result });
      await originalRespondToRequest(requestId, result);
    };

    try {
      const task = await harness.service.createTask({
        title: "Bound task",
        prompt: "Please edit the file and patch it.",
      });

      await waitFor(
        () => (harness.service.getTask(task.taskId)?.pendingApprovals.length ?? 0) > 0,
        "pending approval",
      );
      assert.equal(
        harness.calls.some((entry) => entry.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")),
        false,
      );

      await harness.onMessage(
        {
          message_id: "om_bind",
          thread_id: "omt_bind",
          root_id: "om_root_bind",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: `/bind ${task.taskId}` }),
        },
        {
          sender_id: {
            open_id: "ou_bind",
          },
        },
      );

      await waitFor(
        () => harness.service.getTask(task.taskId)?.feishuBinding?.threadKey === "omt_bind",
        "manual bind",
      );

      await harness.onMessage(
        {
          message_id: "om_status",
          thread_id: "omt_bind",
          root_id: "om_root_bind",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/status" }),
        },
        {
          sender_id: {
            open_id: "ou_bind",
          },
        },
      );
      await waitFor(
        () =>
          harness.requests.some((request) =>
            parseMessageText(request).includes(`taskId: ${task.taskId}`) &&
            parseMessageText(request).includes("Thread status: bound"),
          ),
        "status reply",
      );

      await harness.onMessage(
        {
          message_id: "om_approve",
          thread_id: "omt_bind",
          root_id: "om_root_bind",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/approve" }),
        },
        {
          sender_id: {
            open_id: "ou_bind",
          },
        },
      );

      await waitFor(() => approvalDecisions.length > 0, "approval decision");
      assert.deepEqual(approvalDecisions[0]?.result, { decision: "accept" });

      await harness.onMessage(
        {
          message_id: "om_unbind",
          thread_id: "omt_bind",
          root_id: "om_root_bind",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/unbind" }),
        },
        {
          sender_id: {
            open_id: "ou_bind",
          },
        },
      );

      await waitFor(() => !harness.service.getTask(task.taskId)?.feishuBinding, "unbind");
      const beforeConversationLength = harness.service.getTask(task.taskId)?.conversation.length ?? 0;
      await harness.onMessage(
        {
          message_id: "om_after_unbind",
          thread_id: "omt_bind",
          root_id: "om_root_bind",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "plain text after unbind" }),
        },
        {
          sender_id: {
            open_id: "ou_bind",
          },
        },
      );
      await delay(50);
      assert.equal(harness.service.getTask(task.taskId)?.conversation.length ?? 0, beforeConversationLength);
    } finally {
      await harness.cleanup();
    }
  });

  it("supports global slash commands without treating them as normal prompts", async () => {
    const harness = await createHarness();

    try {
      await harness.onMessage(
        {
          message_id: "om_help",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/help" }),
        },
        {
          sender_id: {
            open_id: "ou_global",
          },
        },
      );

      await harness.onMessage(
        {
          message_id: "om_health",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/health" }),
        },
        {
          sender_id: {
            open_id: "ou_global",
          },
        },
      );

      await harness.onMessage(
        {
          message_id: "om_unknown",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/unknown" }),
        },
        {
          sender_id: {
            open_id: "ou_global",
          },
        },
      );

      await waitFor(
        () => harness.requests.some((request) => parseMessageText(request).includes("Feishu bridge commands:")),
        "help reply",
      );
      await waitFor(
        () => harness.requests.some((request) => parseMessageText(request).includes("status: ok")),
        "health reply",
      );
      assert.equal(harness.service.listTasks().length, 0);
    } finally {
      await harness.cleanup();
    }
  });
});
