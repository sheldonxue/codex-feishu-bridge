import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { createConsoleLogger, loadBridgeConfig, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import { FeishuBridge } from "../src/feishu/bridge";
import { createBridgeHttpServer } from "../src/server/http";
import { createCodexRuntime } from "../src/runtime";
import { BridgeService } from "../src/service/bridge-service";

interface FeishuTestHarness {
  baseUrl: string;
  calls: string[];
  requests: Array<{ method: string; url: string; body?: string }>;
  cleanup: () => Promise<void>;
  runtime: ReturnType<typeof createCodexRuntime>;
  service: BridgeService;
}

function textInputs(
  input: Array<{ type: string; text?: string }>,
): string[] {
  return input.filter((item): item is { type: "text"; text: string } => item.type === "text" && Boolean(item.text)).map((item) => item.text);
}

function approvalDecisionValue(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result;
  }

  if (result && typeof result === "object" && "decision" in result) {
    const decision = (result as { decision?: unknown }).decision;
    return typeof decision === "string" ? decision : undefined;
  }

  return undefined;
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
  const signature =
    options?.signature ?? signWebhook(rawBody, "encrypt-key", timestamp, nonce);

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

async function createHarness(
  envOverrides: Record<string, string> = {},
): Promise<FeishuTestHarness> {
  const namespace = randomUUID();
  const workspaceRoot = process.cwd();
  const config = loadBridgeConfig(
    {
      WORKSPACE_PATH: workspaceRoot,
      BRIDGE_PORT: "0",
      CODEX_RUNTIME_BACKEND: "mock",
      BRIDGE_STATE_DIR: path.join(".tmp", namespace, "state"),
      CODEX_HOME: path.join(".tmp", namespace, "codex-home"),
      BRIDGE_UPLOADS_DIR: path.join(".tmp", namespace, "uploads"),
      FEISHU_BASE_URL: "https://open.feishu.cn",
      FEISHU_APP_ID: "cli-app-id",
      FEISHU_APP_SECRET: "cli-app-secret",
      FEISHU_VERIFICATION_TOKEN: "verify-token",
      FEISHU_ENCRYPT_KEY: "encrypt-key",
      FEISHU_DEFAULT_CHAT_ID: "oc_chat_id",
      ...envOverrides,
    },
    workspaceRoot,
  );
  const logger = createConsoleLogger("feishu-bridge-test");

  await prepareBridgeDirectories(config);

  const calls: string[] = [];
  const requests: Array<{ method: string; url: string; body?: string }> = [];
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
            message_id: `om_root_${calls.length}`,
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

async function waitForRootMessageId(service: BridgeService, taskId: string): Promise<string> {
  await waitFor(() => Boolean(service.getTask(taskId)?.feishuBinding?.rootMessageId), `task ${taskId} Feishu binding`);
  return service.getTask(taskId)?.feishuBinding?.rootMessageId ?? "";
}

async function waitForPendingApproval(service: BridgeService, taskId: string): Promise<string> {
  await waitFor(
    () => service.getTask(taskId)?.pendingApprovals.some((approval) => approval.state === "pending") ?? false,
    `task ${taskId} pending approval`,
  );
  return (
    service
      .getTask(taskId)
      ?.pendingApprovals.find((approval) => approval.state === "pending")
      ?.requestId ?? ""
  );
}

describe("feishu bridge", { concurrency: 1 }, () => {
  it("requires full live webhook configuration before enabling the bridge", async () => {
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

  it("binds new tasks to feishu root messages, routes webhook replies, and dedupes repeated events", async () => {
    const harness = await createHarness();
    const approvalDecisions: Array<{ requestId: number | string; result: unknown }> = [];
    const originalRespondToRequest = harness.runtime.respondToRequest.bind(harness.runtime);
    harness.runtime.respondToRequest = async (requestId, result) => {
      approvalDecisions.push({ requestId, result });
      await originalRespondToRequest(requestId, result);
    };

    try {
      const task = await harness.service.createTask({
        title: "Feishu task",
        prompt: "Please edit the file and patch it.",
      });

      const rootMessageId = await waitForRootMessageId(harness.service, task.taskId);
      await waitForPendingApproval(harness.service, task.taskId);
      assert.match(rootMessageId, /^om_root_/);
      assert.ok(harness.calls.some((entry) => entry.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")));

      const accepted = await postWebhook(harness, {
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
            root_id: rootMessageId,
            chat_id: "oc_chat_id",
            message_type: "text",
            content: JSON.stringify({ text: "approve" }),
          },
        },
      });
      assert.equal(accepted.body.ok, true);

      await waitFor(
        () => approvalDecisions.some((entry) => approvalDecisionValue(entry.result) === "accept"),
        `task ${task.taskId} approval routing`,
      );
      assert.equal(approvalDecisionValue(approvalDecisions.at(-1)?.result), "accept");
      assert.ok(harness.calls.some((entry) => entry.includes(`/open-apis/im/v1/messages/${rootMessageId}/reply`)));

      const deduped = await postWebhook(
        harness,
        {
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
              root_id: rootMessageId,
              chat_id: "oc_chat_id",
              message_type: "text",
              content: JSON.stringify({ text: "approve" }),
            },
          },
        },
        {
          nonce: "nonce-value",
          timestamp: "1700000000",
        },
      );
      assert.equal(deduped.body.deduped, true);
    } finally {
      await harness.cleanup();
    }
  });

  it("creates one root thread and keeps startup follow-ups in the same feishu thread", async () => {
    const harness = await createHarness();

    try {
      const task = await harness.service.createTask({
        title: "Feishu thread stability task",
        prompt: "Reply with a short acknowledgement.",
      });

      const rootMessageId = await waitForRootMessageId(harness.service, task.taskId);
      await waitFor(
        () =>
          harness.requests.some((request) =>
            request.url.includes(`/open-apis/im/v1/messages/${rootMessageId}/reply`),
          ),
        `task ${task.taskId} in-thread reply`,
      );

      const rootRequests = harness.requests.filter((request) =>
        request.url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id"),
      );
      assert.equal(rootRequests.length, 1);

      const replyRequests = harness.requests.filter((request) =>
        request.url.includes(`/open-apis/im/v1/messages/${rootMessageId}/reply`),
      );
      assert.ok(replyRequests.length >= 1);
      for (const request of replyRequests) {
        const body = JSON.parse(request.body ?? "{}") as { reply_in_thread?: boolean };
        assert.equal(body.reply_in_thread, true);
      }
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
            content: JSON.stringify({ text: "approve" }),
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
            content: JSON.stringify({ text: "approve" }),
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

  it("routes decline, cancel, interrupt, and retry webhook commands to the bound task", async () => {
    const harness = await createHarness();
    const approvalDecisions: Array<{ requestId: number | string; result: unknown }> = [];
    const interruptCalls: Array<{ threadId: string; turnId?: string }> = [];
    const messageCalls: Array<{ kind: "start" | "steer"; texts: string[] }> = [];

    const originalRespondToRequest = harness.runtime.respondToRequest.bind(harness.runtime);
    harness.runtime.respondToRequest = async (requestId, result) => {
      approvalDecisions.push({ requestId, result });
      await originalRespondToRequest(requestId, result);
    };

    const originalInterruptTurn = harness.runtime.interruptTurn.bind(harness.runtime);
    harness.runtime.interruptTurn = async (params) => {
      interruptCalls.push(params);
      await originalInterruptTurn(params);
    };

    const originalStartTurn = harness.runtime.startTurn.bind(harness.runtime);
    harness.runtime.startTurn = async (params) => {
      messageCalls.push({
        kind: "start",
        texts: textInputs(params.input),
      });
      return originalStartTurn(params);
    };

    const originalSteerTurn = harness.runtime.steerTurn.bind(harness.runtime);
    harness.runtime.steerTurn = async (params) => {
      messageCalls.push({
        kind: "steer",
        texts: textInputs(params.input),
      });
      return originalSteerTurn(params);
    };

    try {
      const declineTask = await harness.service.createTask({
        title: "Decline task",
        prompt: "Please edit the file and patch it.",
      });
      const declineRootId = await waitForRootMessageId(harness.service, declineTask.taskId);
      await waitForPendingApproval(harness.service, declineTask.taskId);
      const decisionCountBeforeDecline = approvalDecisions.length;
      await postWebhook(harness, {
        header: {
          event_id: "evt_decline",
          event_type: "im.message.receive_v1",
          token: "verify-token",
        },
        event: {
          sender: {
            sender_id: {
              open_id: "ou_decline",
            },
          },
          message: {
            message_id: "om_decline",
            root_id: declineRootId,
            chat_id: "oc_chat_id",
            message_type: "text",
            content: JSON.stringify({ text: "decline" }),
          },
        },
      });
      await waitFor(() => approvalDecisions.length > decisionCountBeforeDecline, "decline approval decision");
      assert.equal(approvalDecisionValue(approvalDecisions.at(-1)?.result), "decline");
      await waitFor(
        () => harness.service.getTask(declineTask.taskId)?.pendingApprovals[0]?.state === "declined",
        `task ${declineTask.taskId} decline state`,
      );

      const cancelTask = await harness.service.createTask({
        title: "Cancel task",
        prompt: "Please edit the file and patch it.",
      });
      const cancelRootId = await waitForRootMessageId(harness.service, cancelTask.taskId);
      await waitForPendingApproval(harness.service, cancelTask.taskId);
      const decisionCountBeforeCancel = approvalDecisions.length;
      await postWebhook(harness, {
        header: {
          event_id: "evt_cancel",
          event_type: "im.message.receive_v1",
          token: "verify-token",
        },
        event: {
          sender: {
            sender_id: {
              open_id: "ou_cancel",
            },
          },
          message: {
            message_id: "om_cancel",
            root_id: cancelRootId,
            chat_id: "oc_chat_id",
            message_type: "text",
            content: JSON.stringify({ text: "cancel" }),
          },
        },
      });
      await waitFor(() => approvalDecisions.length > decisionCountBeforeCancel, "cancel approval decision");
      assert.equal(approvalDecisionValue(approvalDecisions.at(-1)?.result), "cancel");
      await waitFor(
        () => harness.service.getTask(cancelTask.taskId)?.pendingApprovals[0]?.state === "cancelled",
        `task ${cancelTask.taskId} cancel state`,
      );

      const interruptTask = await harness.service.createTask({
        title: "Interrupt task",
        prompt: "Please edit the file and patch it.",
      });
      const interruptRootId = await waitForRootMessageId(harness.service, interruptTask.taskId);
      await waitForPendingApproval(harness.service, interruptTask.taskId);
      const interruptCountBefore = interruptCalls.length;
      await postWebhook(harness, {
        header: {
          event_id: "evt_interrupt",
          event_type: "im.message.receive_v1",
          token: "verify-token",
        },
        event: {
          sender: {
            sender_id: {
              open_id: "ou_interrupt",
            },
          },
          message: {
            message_id: "om_interrupt",
            root_id: interruptRootId,
            chat_id: "oc_chat_id",
            message_type: "text",
            content: JSON.stringify({ text: "interrupt" }),
          },
        },
      });
      await waitFor(() => interruptCalls.length > interruptCountBefore, "interrupt routing");
      assert.equal(interruptCalls.at(-1)?.threadId, interruptTask.taskId);
      await waitFor(
        () => harness.service.getTask(interruptTask.taskId)?.activeTurnId === undefined,
        `task ${interruptTask.taskId} interrupt completion`,
      );

      const retryTask = await harness.service.createTask({
        title: "Retry task",
        prompt: "Summarize the current task state.",
      });
      const retryRootId = await waitForRootMessageId(harness.service, retryTask.taskId);
      await waitFor(
        () => (harness.service.getTask(retryTask.taskId)?.conversation.length ?? 0) >= 2,
        `task ${retryTask.taskId} initial response`,
      );
      const messageCountBeforeRetry = messageCalls.length;
      await postWebhook(harness, {
        header: {
          event_id: "evt_retry",
          event_type: "im.message.receive_v1",
          token: "verify-token",
        },
        event: {
          sender: {
            sender_id: {
              open_id: "ou_retry",
            },
          },
          message: {
            message_id: "om_retry",
            root_id: retryRootId,
            chat_id: "oc_chat_id",
            message_type: "text",
            content: JSON.stringify({ text: "retry continue from mobile" }),
          },
        },
      });
      await waitFor(() => messageCalls.length > messageCountBeforeRetry, "retry message routing");
      assert.equal(messageCalls.at(-1)?.texts[0], "continue from mobile");
      assert.ok(["start", "steer"].includes(messageCalls.at(-1)?.kind ?? ""));
    } finally {
      await harness.cleanup();
    }
  });
});
