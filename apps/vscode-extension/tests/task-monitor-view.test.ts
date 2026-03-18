import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

describe("task monitor view source", () => {
  it("wires the import recent host threads button to a webview message", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(currentDir, "../src/panels/task-monitor-view.ts");
    const source = readFileSync(sourcePath, "utf8");

    assert.match(source, /<button data-action="import-recent-threads">Import Recent Host Threads<\/button>/);
    assert.match(source, /case "import-recent-threads":\s*vscode\.postMessage\(\{ type: "import-recent-threads" \}\);\s*return;/s);
  });
});
