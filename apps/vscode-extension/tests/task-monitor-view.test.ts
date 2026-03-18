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
    assert.match(source, /id="import-limit"/);
    assert.match(source, /vscode\.postMessage\(\{ type: "import-recent-threads", limit: importRecentLimit \}\);/);
  });

  it("routes destructive local-task actions through the extension host instead of webview confirm", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(currentDir, "../src/panels/task-monitor-view.ts");
    const source = readFileSync(sourcePath, "utf8");

    assert.match(source, /data-action="forget-local-task">Forget Local<\/button>/);
    assert.match(source, /data-action="delete-local-task">Delete Local<\/button>/);
    assert.match(source, /data-action="forget-local-tasks"[\s\S]*>Forget Selected<\/button>/);
    assert.match(source, /data-action="delete-local-tasks"[\s\S]*>Delete Selected<\/button>/);
    assert.doesNotMatch(source, /window\.confirm\(/);
    assert.match(source, /case "forget-imported-tasks":\s*vscode\.postMessage\(\{ type: "forget-imported-tasks" \}\);\s*return;/s);
    assert.match(source, /case "forget-local-task":[\s\S]*vscode\.postMessage\(\{ type: "forget-local-task", taskId \}\);\s*return;/s);
    assert.match(source, /case "forget-local-tasks":[\s\S]*vscode\.postMessage\(\{ type: "forget-local-tasks", taskIds \}\);\s*return;/s);
    assert.match(source, /case "delete-local-task":[\s\S]*vscode\.postMessage\(\{ type: "delete-local-task", taskId \}\);\s*return;/s);
    assert.match(source, /case "delete-local-tasks":[\s\S]*vscode\.postMessage\(\{ type: "delete-local-tasks", taskIds \}\);\s*return;/s);
    assert.match(source, /showWarningMessage\(\s*"Clear all imported local tasks from the bridge monitor\? Host Codex threads in ~\/\.codex will be kept\."/);
    assert.match(source, /showWarningMessage\(\s*"Forget this local task record from the bridge monitor\? The underlying host Codex thread will not be deleted\."/);
    assert.match(source, /showWarningMessage\(\s*`Forget \$\{tasks\.length\} local task record\(s\) from the bridge monitor\? The underlying host Codex threads will not be deleted\.`/);
    assert.match(source, /showWarningMessage\(\s*"Delete this local task from the bridge monitor and permanently remove the underlying host Codex thread from this computer\?"/);
    assert.match(source, /showWarningMessage\(\s*`Delete \$\{tasks\.length\} local task\(s\) from the bridge monitor and permanently remove the underlying host Codex threads from this computer\?`/);
  });

  it("renders approvals and diffs as collapsed foldouts and exposes richer composer controls", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(currentDir, "../src/panels/task-monitor-view.ts");
    const source = readFileSync(sourcePath, "utf8");

    assert.match(source, /foldout\("approvals"/);
    assert.match(source, /foldout\("diffs"/);
    assert.match(source, /data-action="pick-composer-images">Attach Images<\/button>/);
    assert.match(source, /data-action="clear-composer"/);
    assert.match(source, /Ctrl\/Cmd\+Enter/);
  });

  it("renders the monitor as an editor panel entry point instead of a sidebar view contribution", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const packagePath = path.resolve(currentDir, "../package.json");
    const sourcePath = path.resolve(currentDir, "../src/panels/task-monitor-view.ts");
    const pkg = readFileSync(packagePath, "utf8");
    const source = readFileSync(sourcePath, "utf8");

    assert.match(pkg, /"command": "codexFeishuBridge\.openMonitor"/);
    assert.doesNotMatch(pkg, /"id": "codexFeishuBridge\.monitor"/);
    assert.doesNotMatch(pkg, /"id": "codexFeishuBridge\.tasks"/);
    assert.match(source, /createWebviewPanel\(/);
    assert.match(source, /TaskMonitorPanel\.panelType/);
  });
});
