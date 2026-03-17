import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBridgeConfig } from "@codex-feishu-bridge/shared";

const testsDir = path.dirname(fileURLToPath(import.meta.url));

export const TEST_REPO_ROOT = path.resolve(testsDir, "../../..");

export function resolveTestRepoPath(...segments: string[]): string {
  return path.join(TEST_REPO_ROOT, ...segments);
}

export function createTestBridgeConfig(namespace: string, overrides: NodeJS.ProcessEnv = {}) {
  const tempRoot = resolveTestRepoPath(".tmp", "daemon-tests", namespace);
  return loadBridgeConfig(
    {
      WORKSPACE_PATH: TEST_REPO_ROOT,
      BRIDGE_STATE_DIR: path.join(tempRoot, "state"),
      CODEX_HOME: path.join(tempRoot, "codex-home"),
      BRIDGE_UPLOADS_DIR: path.join(tempRoot, "uploads"),
      ...overrides,
    },
    TEST_REPO_ROOT,
  );
}
