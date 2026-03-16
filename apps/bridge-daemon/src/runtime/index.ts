import type { BridgeConfig, Logger } from "@codex-feishu-bridge/shared";

import { MockCodexRuntime } from "./mock-codex-runtime";
import { StdioCodexRuntime } from "./stdio-codex-runtime";
import type { CodexRuntime } from "./types";

export * from "./types";

export function createCodexRuntime(config: BridgeConfig, logger: Logger): CodexRuntime {
  if (config.codexBackend === "stdio") {
    return new StdioCodexRuntime(config, logger);
  }

  return new MockCodexRuntime(config, logger);
}
