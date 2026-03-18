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

    assert.match(source, /<button data-action="import-recent-threads"[\s\S]*>Import Recent Host Threads<\/button>/);
    assert.match(source, /id="import-limit"/);
    assert.match(source, /postPendingButtonMessage\(target, \{ type: "import-recent-threads", limit: importRecentLimit \}\);/);
  });

  it("routes destructive local-task actions through the extension host instead of webview confirm", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(currentDir, "../src/panels/task-monitor-view.ts");
    const source = readFileSync(sourcePath, "utf8");

    assert.match(source, /data-action="forget-local-task"[\s\S]*>Remove From Monitor<\/button>/);
    assert.match(source, /data-action="delete-local-task"[\s\S]*>Delete Codex Thread<\/button>/);
    assert.match(source, /data-action="forget-local-tasks"[\s\S]*>Remove Selected<\/button>/);
    assert.match(source, /data-action="delete-local-tasks"[\s\S]*>Delete Selected Threads<\/button>/);
    assert.doesNotMatch(source, /window\.confirm\(/);
    assert.doesNotMatch(source, /showWarningMessage\(/);
    assert.match(source, /case "forget-imported-tasks":\s*postPendingButtonMessage\(target, \{ type: "forget-imported-tasks" \}\);\s*return;/s);
    assert.match(source, /case "forget-local-task":[\s\S]*postPendingButtonMessage\(target, \{ type: "forget-local-task", taskId \}\);\s*return;/s);
    assert.match(source, /case "forget-local-tasks":[\s\S]*postPendingButtonMessage\(target, \{ type: "forget-local-tasks", taskIds \}\);\s*return;/s);
    assert.match(source, /case "delete-local-task":[\s\S]*postPendingButtonMessage\(target, \{ type: "delete-local-task", taskId \}\);\s*return;/s);
    assert.match(source, /case "delete-local-tasks":[\s\S]*postPendingButtonMessage\(target, \{ type: "delete-local-tasks", taskIds \}\);\s*return;/s);
    assert.match(source, /private async confirmMonitorAction\(params:/);
    assert.match(source, /showQuickPick<MonitorConfirmOption>/);
    assert.match(source, /label: "Cancel"/);
    assert.match(source, /title: "Remove From Monitor"/);
    assert.match(source, /title: "Delete Codex Thread"/);
  });

  it("renders approvals and diffs as collapsed foldouts and exposes richer composer controls", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(currentDir, "../src/panels/task-monitor-view.ts");
    const source = readFileSync(sourcePath, "utf8");

    assert.match(source, /foldout\("approvals"/);
    assert.match(source, /foldout\("diffs"/);
    assert.match(source, /data-action="pick-composer-attachments"[\s\S]*>Add Photos \/ Files<\/button>/);
    assert.match(source, /data-action="clear-composer"/);
    assert.match(source, /id="composer-model"/);
    assert.match(source, /id="composer-effort"/);
    assert.match(source, /id="composer-plan-mode"/);
    assert.match(source, /type: "update-execution-profile"/);
    assert.match(source, /Enter<\/code> sends/);
    assert.match(source, /Shift\+Enter/);
    assert.match(source, /Ctrl\/Cmd\+Enter/);
    assert.match(source, /function sendCurrentComposerMessage\(button\)/);
    assert.match(source, /const sendButton = document\.querySelector\('button\[data-action="send-message"\]'\);/);
    assert.match(source, /event\.isComposing \|\| event\.key !== "Enter" \|\| event\.shiftKey/);
  });

  it("adds explicit task handoff, multi-select, and action tooltip affordances to the monitor", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(currentDir, "../src/panels/task-monitor-view.ts");
    const source = readFileSync(sourcePath, "utf8");

    assert.match(source, /let multiSelectMode = false;/);
    assert.match(source, /data-action="toggle-multi-select"/);
    assert.match(source, /case "toggle-multi-select":/);
    assert.match(source, /data-action="bind-new-feishu-topic"/);
    assert.match(source, /Created a new Feishu topic and bound this task\./);
    assert.match(source, /View Status<\/button>/);
    assert.match(source, /Stop Turn<\/button>/);
    assert.match(source, /Retry Last Turn<\/button>/);
    assert.match(source, /title="Create a new topic in the default Feishu group and bind this task to it for mobile follow-up\."/);
    assert.match(source, /title="Re-fetch the current daemon snapshot and any host-thread updates\."/);
    assert.match(source, /data-action="toggle-feishu-running-mode"/);
    assert.match(source, /Queue Feishu messages while Codex is already running/);
    assert.match(source, /button\.pending::before/);
    assert.match(source, /@keyframes monitor-spin/);
    assert.match(source, /function startPendingButton\(button\)/);
    assert.match(source, /function finishPendingAction\(requestId\)/);
    assert.match(source, /function postPendingButtonMessage\(button, message\)/);
    assert.match(source, /type: "action-finished"/);
  });

  it("renders task origin badges alongside feishu bindings in the monitor cards", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(currentDir, "../src/panels/task-monitor-view.ts");
    const source = readFileSync(sourcePath, "utf8");

    assert.match(source, /function renderBadges\(badges\)/);
    assert.equal(source.includes('<div class="task-badges">\\${renderBadges(task.badges)}</div>'), true);
    assert.equal(source.includes('<span class="task-profile" title="Current execution profile for this task.">\\${escapeHtml(task.executionSummary)}</span>'), true);
    assert.equal(source.includes('<div class="hero-badges">\\${renderBadges(task.badges)}</div>'), true);
    assert.match(source, /\.task-row-main/);
    assert.match(source, /\.task-profile/);
    assert.match(source, /\.badge\.cli/);
  });

  it("shows current execution settings in the selected task summary metrics", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(currentDir, "../src/panels/task-monitor-view.ts");
    const source = readFileSync(sourcePath, "utf8");

    assert.match(source, /<strong>Model<\/strong>/);
    assert.match(source, /<strong>Reasoning<\/strong>/);
    assert.match(source, /<strong>Plan Mode<\/strong>/);
    assert.match(source, /<strong>Sandbox<\/strong>/);
    assert.match(source, /<strong>Approval<\/strong>/);
    assert.match(source, /<strong>Feishu While Running<\/strong>/);
    assert.match(source, /<strong>Queued Next Turns<\/strong>/);
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

  it("keeps an explicitly selected task pinned instead of auto-switching on reopen or refresh", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(currentDir, "../src/panels/task-monitor-view.ts");
    const source = readFileSync(sourcePath, "utf8");

    assert.match(source, /private static readonly userSelectedTaskStorageKey = "codexFeishuBridge\.monitor\.userSelectedTask";/);
    assert.match(source, /if \(taskId\) {\s*await this\.setSelectedTask\(taskId\);\s*}/s);
    assert.match(source, /autoSelectFirstTask: !this\.hasUserSelectedTask,/);
    assert.match(source, /if \(state\.selectedTaskId && state\.selectedTaskId !== this\.selectedTaskId\) {/);
  });
});
