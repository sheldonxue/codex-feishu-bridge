import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadBridgeConfig, resolveWorkspacePath } from "../src/index";

describe("shared config helpers", () => {
  it("resolves relative bridge paths inside the workspace", () => {
    const config = loadBridgeConfig(
      {
        WORKSPACE_PATH: "/workspace/codex-feishu-bridge",
        BRIDGE_STATE_DIR: ".tmp",
        BRIDGE_CODEX_HOME: ".tmp/codex-home",
        BRIDGE_UPLOADS_DIR: ".tmp/uploads",
      },
      "/workspace/codex-feishu-bridge",
    );

    assert.equal(config.stateDir, "/workspace/codex-feishu-bridge/.tmp");
    assert.equal(config.bridgeCodexHome, "/workspace/codex-feishu-bridge/.tmp/codex-home");
    assert.equal(config.codexHome, "/workspace/codex-feishu-bridge/.tmp/codex-home");
    assert.equal(config.uploadsDir, "/workspace/codex-feishu-bridge/.tmp/uploads");
  });

  it("keeps absolute workspace paths unchanged", () => {
    assert.equal(
      resolveWorkspacePath("/workspace/codex-feishu-bridge", "/data/codex-home"),
      "/data/codex-home",
    );
  });

  it("loads feishu bridge settings when present", () => {
    const config = loadBridgeConfig(
      {
        WORKSPACE_PATH: "/workspace/codex-feishu-bridge",
        FEISHU_BASE_URL: "https://open.feishu.cn",
        FEISHU_APP_ID: "cli-app-id",
        FEISHU_APP_SECRET: "cli-app-secret",
        FEISHU_VERIFICATION_TOKEN: "verify-token",
        FEISHU_ENCRYPT_KEY: "encrypt-key",
        FEISHU_DEFAULT_CHAT_ID: "oc_xxx",
      },
      "/workspace/codex-feishu-bridge",
    );

    assert.equal(config.feishuBaseUrl, "https://open.feishu.cn");
    assert.equal(config.feishuAppId, "cli-app-id");
    assert.equal(config.feishuAppSecret, "cli-app-secret");
    assert.equal(config.feishuVerificationToken, "verify-token");
    assert.equal(config.feishuEncryptKey, "encrypt-key");
    assert.equal(config.feishuDefaultChatId, "oc_xxx");
  });
});
