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

  it("routes destructive local-task actions through the extension host instead of webview confirm", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(currentDir, "../src/panels/task-monitor-view.ts");
    const source = readFileSync(sourcePath, "utf8");

    assert.match(source, /data-action="forget-local-task">Forget Local<\/button>/);
    assert.match(source, /data-action="delete-local-task">Delete Local<\/button>/);
    assert.doesNotMatch(source, /window\.confirm\(/);
    assert.match(source, /case "forget-imported-tasks":\s*vscode\.postMessage\(\{ type: "forget-imported-tasks" \}\);\s*return;/s);
    assert.match(source, /case "forget-local-task":[\s\S]*vscode\.postMessage\(\{ type: "forget-local-task", taskId \}\);\s*return;/s);
    assert.match(source, /case "delete-local-task":[\s\S]*vscode\.postMessage\(\{ type: "delete-local-task", taskId \}\);\s*return;/s);
    assert.match(source, /showWarningMessage\(\s*"Clear all imported local tasks from the bridge monitor\? Host Codex threads in ~\/\.codex will be kept\."/);
    assert.match(source, /showWarningMessage\(\s*"Forget this local task record from the bridge monitor\? The underlying host Codex thread will not be deleted\."/);
    assert.match(source, /showWarningMessage\(\s*"Delete this local task from the bridge monitor\? The underlying host Codex thread in ~\/\.codex will be kept\."/);
  });
});
