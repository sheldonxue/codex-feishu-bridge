import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { createConsoleLogger, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import { FeishuBridge } from "../src/feishu/bridge";
import { createCodexRuntime } from "../src/runtime";
import { BridgeService } from "../src/service/bridge-service";
import { createTestBridgeConfig } from "./test-paths";

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
  feishu: FeishuBridge;
  cleanup: () => Promise<void>;
  onMessage: (message?: unknown, sender?: unknown) => Promise<void>;
  onCardAction: (event?: unknown) => Promise<unknown>;
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

function parseInteractiveCard(request: RequestRecord): Record<string, unknown> | null {
  const payload = JSON.parse(request.body ?? "{}") as { content?: string; msg_type?: string };
  if (payload.msg_type !== "interactive" || !payload.content) {
    return null;
  }

  try {
    return JSON.parse(payload.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function requestContainsCardTitle(request: RequestRecord, title: string): boolean {
  const card = parseInteractiveCard(request);
  const header = card?.header as { title?: { content?: string } } | undefined;
  return header?.title?.content === title;
}

function requestContainsCardText(request: RequestRecord, needle: string): boolean {
  const card = parseInteractiveCard(request);
  if (!card) {
    return false;
  }

  return JSON.stringify(card).includes(needle);
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
  const config = createTestBridgeConfig(namespace, {
    CODEX_RUNTIME_BACKEND: "mock",
    FEISHU_BASE_URL: "https://open.feishu.cn",
    FEISHU_APP_ID: "cli-app-id",
    FEISHU_APP_SECRET: "cli-app-secret",
    FEISHU_DEFAULT_CHAT_ID: "oc_chat_id",
    FEISHU_VERIFICATION_TOKEN: "",
    FEISHU_ENCRYPT_KEY: "",
    ...envOverrides,
  });
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
  let onCardAction: ((event?: unknown) => Promise<unknown>) | null = null;
  const longConnectionFactory = async (params: {
    onMessage: (message?: unknown, sender?: unknown) => Promise<void>;
    onCardAction: (event?: unknown) => Promise<unknown>;
  }) => {
    onMessage = params.onMessage;
    onCardAction = params.onCardAction;
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
      feishu,
      onMessage: async (message?: unknown, sender?: unknown) => {
        assert.ok(onMessage, "long connection handler should be registered");
        await onMessage?.(message, sender);
      },
      onCardAction: async (event?: unknown) => {
        assert.ok(onCardAction, "long connection card handler should be registered");
        return onCardAction?.(event);
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
  it("turns the first unbound plain-text message into a draft card and creates a bound task from card actions", async () => {
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

      assert.equal(harness.service.listTasks().length, 0);
      await waitFor(
        () => harness.requests.some((request) => requestContainsCardTitle(request, "Create Codex Task")),
        "draft card reply",
      );
      assert.equal(
        harness.requests.some((request) => parseMessageText(request).includes("Current /new draft")),
        false,
      );
      assert.equal(
        harness.requests.some((request) => parseMessageText(request).includes("Mock response for: hello before binding")),
        false,
      );

      const firstCard = await harness.onCardAction({
        open_message_id: "om_card_new_task",
        open_id: "ou_plain",
        action: {
          tag: "select_static",
          option: "gpt-5.4-mini",
          value: {
            kind: "draft.select.model",
            chatId: "oc_chat_id",
            threadKey: "omt_new_task",
            rootMessageId: "om_root_new_task",
          },
        },
      });
      assert.ok(firstCard);
      assert.match(JSON.stringify(firstCard), /gpt-5\.4-mini/);

      const createdCard = await harness.onCardAction({
        open_message_id: "om_card_new_task",
        open_id: "ou_plain",
        action: {
          tag: "button",
          value: {
            kind: "draft.create",
            chatId: "oc_chat_id",
            threadKey: "omt_new_task",
            rootMessageId: "om_root_new_task",
          },
        },
      });

      await waitFor(() => harness.service.listTasks().length === 1, "task creation");
      const createdTask = harness.service.listTasks()[0];
      assert.ok(createdTask);
      assert.equal(createdTask?.feishuBinding?.threadKey, "omt_new_task");
      assert.equal(createdTask?.executionProfile.model, "gpt-5.4-mini");
      assert.equal(
        harness.calls.some((entry) => entry.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")),
        false,
      );
      assert.match(JSON.stringify(createdCard), /Task: hello before binding/);

      await waitFor(
        () => harness.requests.some((request) => parseMessageText(request).includes("Mock response for: hello before binding")),
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

  it("updates the draft card through long-connection card actions and falls back to the model default effort", async () => {
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
      await waitFor(
        () => harness.requests.some((request) => requestContainsCardTitle(request, "Create Codex Task")),
        "initial draft card",
      );

      const effortCard = await harness.onCardAction({
        open_message_id: "om_card_models",
        open_id: "ou_models",
        action: {
          tag: "select_static",
          option: "xhigh",
          value: {
            kind: "draft.select.effort",
            chatId: "oc_chat_id",
            threadKey: "omt_models",
            rootMessageId: "om_root_models",
          },
        },
      });
      assert.ok(effortCard);
      assert.match(JSON.stringify(effortCard), /Selected effort xhigh\./);

      const fallbackCard = await harness.onCardAction({
        open_message_id: "om_card_models",
        open_id: "ou_models",
        action: {
          tag: "select_static",
          option: "gpt-5.4-mini",
          value: {
            kind: "draft.select.model",
            chatId: "oc_chat_id",
            threadKey: "omt_models",
            rootMessageId: "om_root_models",
          },
        },
      });
      assert.ok(fallbackCard);
      assert.match(JSON.stringify(fallbackCard), /Selected model gpt-5\.4-mini; effort reverted to low\./);
      assert.equal(
        harness.requests.some((request) => parseMessageText(request).includes("Available models:")),
        false,
      );

      const createCard = await harness.onCardAction({
        open_message_id: "om_card_models",
        open_id: "ou_models",
        action: {
          tag: "button",
          value: {
            kind: "draft.create",
            chatId: "oc_chat_id",
            threadKey: "omt_models",
            rootMessageId: "om_root_models",
          },
        },
      });

      await waitFor(() => harness.service.listTasks().length === 1, "task creation from model draft");
      const task = harness.service.listTasks()[0];
      assert.equal(task?.executionProfile.model, "gpt-5.4-mini");
      assert.equal(task?.executionProfile.effort, "low");
      assert.match(JSON.stringify(createCard), /Created task/);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps mobile card actions working when Feishu omits open_message_id", async () => {
    const harness = await createHarness();

    try {
      await harness.onMessage(
        {
          message_id: "om_mobile_init",
          thread_id: "omt_mobile",
          root_id: "om_root_mobile",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "/new" }),
        },
        {
          sender_id: {
            open_id: "ou_mobile",
          },
        },
      );
      await waitFor(
        () => harness.requests.some((request) => requestContainsCardTitle(request, "Create Codex Task")),
        "initial mobile draft card",
      );

      const firstCancelCard = await harness.onCardAction({
        open_id: "ou_mobile",
        action: {
          tag: "button",
          value: {
            kind: "draft.cancel",
            chatId: "oc_chat_id",
            threadKey: "omt_mobile",
            rootMessageId: "om_root_mobile",
            revision: 1,
          },
        },
      });
      assert.ok(firstCancelCard);
      assert.match(JSON.stringify(firstCancelCard), /Draft cancelled/);

      const secondCancelCard = await harness.onCardAction({
        open_id: "ou_mobile",
        action: {
          tag: "button",
          value: {
            kind: "draft.cancel",
            chatId: "oc_chat_id",
            threadKey: "omt_mobile",
            rootMessageId: "om_root_mobile",
            revision: 2,
          },
        },
      });
      assert.ok(secondCancelCard);
      assert.match(JSON.stringify(secondCancelCard), /Draft cancelled/);

      const createCard = await harness.onCardAction({
        open_id: "ou_mobile",
        action: {
          tag: "button",
          value: {
            kind: "draft.create",
            chatId: "oc_chat_id",
            threadKey: "omt_mobile",
            rootMessageId: "om_root_mobile",
            revision: 3,
          },
        },
      });

      await waitFor(() => harness.service.listTasks().length === 1, "mobile task creation");
      assert.ok(createCard);
      assert.match(JSON.stringify(createCard), /Created task/);
      assert.match(JSON.stringify(createCard), /Next Step/);
      assert.match(JSON.stringify(createCard), /send the first plain-text message in this thread to start the first turn/i);
      assert.equal(
        harness.calls.some((entry) => entry.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")),
        false,
      );
      assert.ok(
        harness.requests.filter(
          (request) => request.method === "PATCH" && request.url.includes("/open-apis/im/v1/messages/"),
        ).length >= 3,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("recovers stale draft cards that no longer have a saved card message id", async () => {
    const harness = await createHarness();

    try {
      await harness.onMessage(
        {
          message_id: "om_stale_init",
          thread_id: "omt_stale",
          root_id: "om_root_stale",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "stale draft prompt" }),
        },
        {
          sender_id: {
            open_id: "ou_stale",
          },
        },
      );
      await waitFor(
        () => harness.requests.some((request) => requestContainsCardTitle(request, "Create Codex Task")),
        "stale draft card",
      );

      const staleKey = "oc_chat_id:omt_stale";
      const drafts = (harness.feishu as unknown as { threadDrafts: Map<string, { cardMessageId?: string }> }).threadDrafts;
      const staleDraft = drafts.get(staleKey);
      assert.ok(staleDraft);
      delete staleDraft?.cardMessageId;

      const previousInteractiveReplyCount = harness.requests.filter(
        (request) => request.method === "POST" && request.url.includes("/open-apis/im/v1/messages/") && requestContainsCardTitle(request, "Create Codex Task"),
      ).length;

      const cancelledCard = await harness.onCardAction({
        open_id: "ou_stale",
        action: {
          tag: "button",
          value: {
            kind: "draft.cancel",
            chatId: "oc_chat_id",
            threadKey: "omt_stale",
            rootMessageId: "om_root_stale",
            revision: 2,
          },
        },
      });

      assert.ok(cancelledCard);
      assert.match(JSON.stringify(cancelledCard), /Draft cancelled/);
      await waitFor(
        () =>
          harness.requests.filter(
            (request) => request.method === "POST" && request.url.includes("/open-apis/im/v1/messages/") && requestContainsCardTitle(request, "Create Codex Task"),
          ).length > previousInteractiveReplyCount,
        "replacement draft card reply",
      );
      assert.ok(drafts.get(staleKey)?.cardMessageId);
    } finally {
      await harness.cleanup();
    }
  });

  it("replies with a new interactive approval card instead of slash-command text when a bound task requests approval", async () => {
    const harness = await createHarness();

    try {
      const task = await harness.service.createTask({
        title: "Approval card task",
      });

      await harness.feishu.bindTaskToNewTopic(task.taskId);
      await waitFor(
        () =>
          harness.requests.some(
            (request) =>
              request.method === "POST" &&
              request.url.includes("/open-apis/im/v1/messages/") &&
              requestContainsCardTitle(request, `Task: ${task.title}`),
          ),
        "initial bound task card",
      );

      const previousApprovalCardReplyCount = harness.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.url.includes("/open-apis/im/v1/messages/") &&
          requestContainsCardTitle(request, `Task: ${task.title}`) &&
          requestContainsCardText(request, "Pending Approval"),
      ).length;

      await harness.service.sendMessage(task.taskId, {
        content: "Run a shell command for me.",
        source: "feishu",
        replyToFeishu: true,
      });

      await waitFor(
        () => (harness.service.getTask(task.taskId)?.pendingApprovals.length ?? 0) > 0,
        "approval after binding",
      );
      await waitFor(
        () =>
          harness.requests.filter(
            (request) =>
              request.method === "POST" &&
              request.url.includes("/open-apis/im/v1/messages/") &&
              requestContainsCardTitle(request, `Task: ${task.title}`) &&
              requestContainsCardText(request, "Pending Approval"),
          ).length > previousApprovalCardReplyCount,
        "approval card reply",
      );

      assert.equal(
        harness.requests.some((request) => parseMessageText(request).includes("Approval requested for")),
        false,
      );
      assert.equal(
        harness.requests.some((request) => parseMessageText(request).includes("Use /approve, /decline, or /cancel.")),
        false,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("replies with a new status snapshot card instead of patching the bound task card", async () => {
    const harness = await createHarness();

    try {
      const task = await harness.service.createTask({
        title: "Status card task",
      });

      await harness.feishu.bindTaskToNewTopic(task.taskId);
      await waitFor(
        () =>
          harness.requests.some(
            (request) =>
              request.method === "POST" &&
              request.url.includes("/open-apis/im/v1/messages/") &&
              requestContainsCardTitle(request, `Task: ${task.title}`),
          ),
        "initial bound task card",
      );

      const taskCards = (
        harness.feishu as unknown as { threadTaskCards: Map<string, { messageId: string }> }
      ).threadTaskCards;
      const currentCard = taskCards.get(`${task.feishuBinding?.chatId}:${task.feishuBinding?.threadKey}`);
      assert.ok(currentCard?.messageId);

      const previousSnapshotReplyCount = harness.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.url.includes("/open-apis/im/v1/messages/") &&
          requestContainsCardTitle(request, `Task Status Snapshot: ${task.title}`),
      ).length;
      const previousPatchCount = harness.requests.filter(
        (request) => request.method === "PATCH" && request.url.endsWith(`/open-apis/im/v1/messages/${currentCard?.messageId}`),
      ).length;

      const statusResult = await harness.onCardAction({
        open_message_id: currentCard?.messageId,
        open_id: "ou_status_card",
        action: {
          tag: "button",
          value: {
            kind: "task.status",
            chatId: task.feishuBinding?.chatId ?? "oc_chat_id",
            threadKey: task.feishuBinding?.threadKey ?? "omt_status_task",
            rootMessageId: task.feishuBinding?.rootMessageId,
            taskId: task.taskId,
            revision: 1,
          },
        },
      });

      assert.equal(statusResult, undefined);
      await waitFor(
        () =>
          harness.requests.filter(
            (request) =>
              request.method === "POST" &&
              request.url.includes("/open-apis/im/v1/messages/") &&
              requestContainsCardTitle(request, `Task Status Snapshot: ${task.title}`),
          ).length > previousSnapshotReplyCount,
        "status snapshot card reply",
      );
      assert.equal(
        harness.requests.filter(
          (request) => request.method === "PATCH" && request.url.endsWith(`/open-apis/im/v1/messages/${currentCard?.messageId}`),
        ).length,
        previousPatchCount,
      );
      assert.equal(taskCards.get(`${task.feishuBinding?.chatId}:${task.feishuBinding?.threadKey}`)?.messageId, currentCard?.messageId);
    } finally {
      await harness.cleanup();
    }
  });

  it("replies with new inspection snapshot cards for every More-menu query instead of patching the bound task card", async () => {
    const harness = await createHarness();

    try {
      const task = await harness.service.createTask({
        title: "Inspection card task",
      });

      await harness.feishu.bindTaskToNewTopic(task.taskId);
      await waitFor(
        () =>
          harness.requests.some(
            (request) =>
              request.method === "POST" &&
              request.url.includes("/open-apis/im/v1/messages/") &&
              requestContainsCardTitle(request, `Task: ${task.title}`),
          ),
        "initial bound task card",
      );

      const taskCards = (
        harness.feishu as unknown as { threadTaskCards: Map<string, { messageId: string }> }
      ).threadTaskCards;
      const currentCard = taskCards.get(`${task.feishuBinding?.chatId}:${task.feishuBinding?.threadKey}`);
      assert.ok(currentCard?.messageId);

      const queryCases = [
        { option: "task", title: `Current Task Snapshot: ${task.title}` },
        { option: "tasks", title: `All Tasks Snapshot: ${task.title}` },
        { option: "health", title: `Bridge Health Snapshot: ${task.title}` },
        { option: "account", title: `Account Snapshot: ${task.title}` },
        { option: "limits", title: `Rate Limits Snapshot: ${task.title}` },
      ] as const;

      for (const queryCase of queryCases) {
        const previousReplyCount = harness.requests.filter(
          (request) =>
            request.method === "POST" &&
            request.url.includes("/open-apis/im/v1/messages/") &&
            requestContainsCardTitle(request, queryCase.title),
        ).length;
        const previousPatchCount = harness.requests.filter(
          (request) => request.method === "PATCH" && request.url.endsWith(`/open-apis/im/v1/messages/${currentCard?.messageId}`),
        ).length;

        const result = await harness.onCardAction({
          open_message_id: currentCard?.messageId,
          open_id: "ou_inspection_card",
          action: {
            tag: "overflow",
            option: queryCase.option,
            value: {
              kind: "task.inspect.global",
              chatId: task.feishuBinding?.chatId ?? "oc_chat_id",
              threadKey: task.feishuBinding?.threadKey ?? "omt_inspection_task",
              rootMessageId: task.feishuBinding?.rootMessageId,
              taskId: task.taskId,
              revision: 1,
            },
          },
        });

        assert.equal(result, undefined);
        await waitFor(
          () =>
            harness.requests.filter(
              (request) =>
                request.method === "POST" &&
                request.url.includes("/open-apis/im/v1/messages/") &&
                requestContainsCardTitle(request, queryCase.title),
            ).length > previousReplyCount,
          `${queryCase.option} inspection snapshot reply`,
        );
        assert.equal(
          harness.requests.filter(
            (request) => request.method === "PATCH" && request.url.endsWith(`/open-apis/im/v1/messages/${currentCard?.messageId}`),
          ).length,
          previousPatchCount,
        );
      }

      assert.equal(taskCards.get(`${task.feishuBinding?.chatId}:${task.feishuBinding?.threadKey}`)?.messageId, currentCard?.messageId);
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
      await delay(50);
      assert.equal(
        harness.requests.some((request) => parseMessageText(request).includes("Approval resolved for")),
        false,
      );
      assert.equal(
        harness.requests.some((request) => parseMessageText(request).includes("approve applied to approval")),
        false,
      );

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

  it("archives a bound topic from the task card and blocks future messages in the same thread", async () => {
    const harness = await createHarness();

    try {
      const task = await harness.service.createTask({
        title: "Archive me",
        prompt: "Start archive flow",
      });

      await harness.onMessage(
        {
          message_id: "om_archive_bind",
          thread_id: "omt_archive",
          root_id: "om_root_archive",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: `/bind ${task.taskId}` }),
        },
        {
          sender_id: {
            open_id: "ou_archive",
          },
        },
      );

      await waitFor(
        () => harness.service.getTask(task.taskId)?.feishuBinding?.threadKey === "omt_archive",
        "archive bind",
      );

      const archivedCard = await harness.onCardAction({
        open_message_id: "om_card_archive",
        open_id: "ou_archive",
        action: {
          tag: "button",
          value: {
            kind: "task.archive",
            chatId: "oc_chat_id",
            threadKey: "omt_archive",
            rootMessageId: "om_root_archive",
            taskId: task.taskId,
            revision: 2,
          },
        },
      });

      assert.ok(archivedCard);
      assert.match(JSON.stringify(archivedCard), /Archived Codex Topic/);
      await waitFor(() => !harness.service.getTask(task.taskId)?.feishuBinding, "task unbound after archive");

      const archivedThreads = (
        harness.feishu as unknown as { archivedThreads: Map<string, { taskId?: string }> }
      ).archivedThreads;
      assert.equal(archivedThreads.get("oc_chat_id:omt_archive")?.taskId, task.taskId);

      const previousConversationLength = harness.service.getTask(task.taskId)?.conversation.length ?? 0;
      await harness.onMessage(
        {
          message_id: "om_archive_after",
          thread_id: "omt_archive",
          root_id: "om_root_archive",
          chat_id: "oc_chat_id",
          message_type: "text",
          content: JSON.stringify({ text: "please keep working" }),
        },
        {
          sender_id: {
            open_id: "ou_archive",
          },
        },
      );

      await waitFor(
        () => harness.requests.some((request) => parseMessageText(request).includes("This Feishu topic is archived")),
        "archived-thread reply",
      );
      await delay(50);
      assert.equal(harness.service.getTask(task.taskId)?.conversation.length ?? 0, previousConversationLength);
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
