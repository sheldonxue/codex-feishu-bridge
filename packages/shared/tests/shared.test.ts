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
});
