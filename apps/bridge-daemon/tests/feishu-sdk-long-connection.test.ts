import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createConsoleLogger, loadBridgeConfig } from "@codex-feishu-bridge/shared";

import { createFeishuLongConnectionFactory } from "../src/feishu/long-connection";
import { TEST_REPO_ROOT } from "./test-paths";

describe("feishu sdk long connection factory", () => {
  it("builds the official sdk client, registers im.message.receive_v1, and closes cleanly", async () => {
    const clients: FakeWsClient[] = [];
    const dispatchers: FakeEventDispatcher[] = [];

    class FakeEventDispatcher {
      public handles: Record<string, (data: any) => Promise<void> | void> = {};

      constructor(public readonly options: Record<string, unknown>) {
        dispatchers.push(this);
      }

      register(handles: Record<string, (data: any) => Promise<void> | void>) {
        this.handles = handles;
        return this;
      }
    }

    class FakeWsClient {
      public startCalls: Array<{ eventDispatcher: unknown }> = [];
      public closeCalls: Array<{ force?: boolean } | undefined> = [];

      constructor(public readonly options: Record<string, unknown>) {
        clients.push(this);
      }

      async start(params: { eventDispatcher: unknown }) {
        this.startCalls.push(params);
      }

      close(params?: { force?: boolean }) {
        this.closeCalls.push(params);
      }
    }

    const received: Array<{ message?: unknown; sender?: unknown }> = [];
    const factory = createFeishuLongConnectionFactory({
      AppType: {
        SelfBuild: "self-build",
      },
      EventDispatcher: FakeEventDispatcher,
      LoggerLevel: {
        info: "info",
      },
      WSClient: FakeWsClient,
    });
    const config = loadBridgeConfig(
      {
        WORKSPACE_PATH: TEST_REPO_ROOT,
        FEISHU_BASE_URL: "https://open.feishu.cn",
        FEISHU_APP_ID: "cli-app-id",
        FEISHU_APP_SECRET: "cli-app-secret",
        FEISHU_DEFAULT_CHAT_ID: "oc_chat_id",
      },
      TEST_REPO_ROOT,
    );
    const logger = createConsoleLogger("feishu-sdk-long-connection-test");

    const handle = await factory({
      config,
      logger,
      onMessage: async (message, sender) => {
        received.push({ message, sender });
      },
    });

    assert.equal(clients.length, 1);
    assert.equal(dispatchers.length, 1);
    assert.equal(clients[0]?.options.appId, "cli-app-id");
    assert.equal(clients[0]?.options.appSecret, "cli-app-secret");
    assert.equal(clients[0]?.options.appType, "self-build");
    assert.equal(clients[0]?.options.domain, "https://open.feishu.cn");
    assert.equal(clients[0]?.options.autoReconnect, true);
    assert.equal(typeof clients[0]?.options.logger, "object");
    assert.equal(dispatchers[0]?.options.loggerLevel, "info");
    assert.equal(typeof dispatchers[0]?.handles["im.message.receive_v1"], "function");
    assert.equal(clients[0]?.startCalls.length, 1);
    assert.equal(clients[0]?.startCalls[0]?.eventDispatcher, dispatchers[0]);

    await dispatchers[0]?.handles["im.message.receive_v1"]({
      message: {
        message_id: "om_message_1",
        chat_id: "oc_chat_id",
      },
      sender: {
        sender_id: {
          open_id: "ou_sender",
        },
      },
    });
    assert.deepEqual(received, [
      {
        message: {
          message_id: "om_message_1",
          chat_id: "oc_chat_id",
        },
        sender: {
          sender_id: {
            open_id: "ou_sender",
          },
        },
      },
    ]);

    await handle.stop();
    assert.deepEqual(clients[0]?.closeCalls, [{ force: true }]);
  });
});
