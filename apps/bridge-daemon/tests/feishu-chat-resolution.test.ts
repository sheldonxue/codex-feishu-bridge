import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createConsoleLogger, loadBridgeConfig } from "@codex-feishu-bridge/shared";

import {
  listVisibleFeishuChats,
  resolveFeishuDefaultChatConfig,
} from "../src/feishu/chat-resolution";

describe("feishu chat resolution", () => {
  it("lists visible chats across pages", async () => {
    const requests: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);

      if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
        });
      }

      if (url.includes("/open-apis/im/v1/chats?page_size=100&page_token=page-2")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              has_more: false,
              items: [{ chat_id: "oc_2", name: "Beta" }],
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes("/open-apis/im/v1/chats?page_size=100")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              has_more: true,
              page_token: "page-2",
              items: [{ chat_id: "oc_1", name: "Alpha" }],
            },
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const config = loadBridgeConfig(
        {
          WORKSPACE_PATH: process.cwd(),
          FEISHU_BASE_URL: "https://open.feishu.cn",
          FEISHU_APP_ID: "cli-app-id",
          FEISHU_APP_SECRET: "cli-app-secret",
        },
        process.cwd(),
      );

      const chats = await listVisibleFeishuChats(config);
      assert.deepEqual(chats, [
        { chatId: "oc_1", description: undefined, name: "Alpha" },
        { chatId: "oc_2", description: undefined, name: "Beta" },
      ]);
      assert.ok(requests.some((request) => request.includes("page_token=page-2")));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("resolves FEISHU_DEFAULT_CHAT_NAME to an exact visible chat id", async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
        });
      }

      if (url.includes("/open-apis/im/v1/chats?page_size=100")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              has_more: false,
              items: [
                { chat_id: "oc_target", name: "Bridge Target" },
                { chat_id: "oc_other", name: "Other Group" },
              ],
            },
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const config = loadBridgeConfig(
        {
          WORKSPACE_PATH: process.cwd(),
          FEISHU_BASE_URL: "https://open.feishu.cn",
          FEISHU_APP_ID: "cli-app-id",
          FEISHU_APP_SECRET: "cli-app-secret",
          FEISHU_DEFAULT_CHAT_NAME: "Bridge Target",
        },
        process.cwd(),
      );

      const resolved = await resolveFeishuDefaultChatConfig(
        config,
        createConsoleLogger("feishu-chat-resolution-test"),
      );
      assert.equal(resolved.feishuDefaultChatId, "oc_target");
      assert.equal(resolved.feishuDefaultChatName, "Bridge Target");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("fails when FEISHU_DEFAULT_CHAT_NAME matches nothing", async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
        });
      }

      if (url.includes("/open-apis/im/v1/chats?page_size=100")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              has_more: false,
              items: [{ chat_id: "oc_other", name: "Other Group" }],
            },
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const config = loadBridgeConfig(
        {
          WORKSPACE_PATH: process.cwd(),
          FEISHU_BASE_URL: "https://open.feishu.cn",
          FEISHU_APP_ID: "cli-app-id",
          FEISHU_APP_SECRET: "cli-app-secret",
          FEISHU_DEFAULT_CHAT_NAME: "Missing Group",
        },
        process.cwd(),
      );

      await assert.rejects(
        () => resolveFeishuDefaultChatConfig(config, createConsoleLogger("feishu-chat-resolution-test")),
        /did not match any visible chat/,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("fails when FEISHU_DEFAULT_CHAT_NAME matches multiple chats", async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
        });
      }

      if (url.includes("/open-apis/im/v1/chats?page_size=100")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              has_more: false,
              items: [
                { chat_id: "oc_1", name: "Bridge Target" },
                { chat_id: "oc_2", name: "Bridge Target" },
              ],
            },
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const config = loadBridgeConfig(
        {
          WORKSPACE_PATH: process.cwd(),
          FEISHU_BASE_URL: "https://open.feishu.cn",
          FEISHU_APP_ID: "cli-app-id",
          FEISHU_APP_SECRET: "cli-app-secret",
          FEISHU_DEFAULT_CHAT_NAME: "Bridge Target",
        },
        process.cwd(),
      );

      await assert.rejects(
        () => resolveFeishuDefaultChatConfig(config, createConsoleLogger("feishu-chat-resolution-test")),
        /matched multiple chats/,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});
