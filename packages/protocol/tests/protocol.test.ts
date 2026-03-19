import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createBridgeEvent,
  createBridgeTask,
  isTerminalTaskStatus,
} from "../src/index";

describe("protocol helpers", () => {
  it("creates a bridge task with thread and task identity aligned", () => {
    const task = createBridgeTask({
      threadId: "thread-123",
      title: "Add Feishu bridge",
      workspaceRoot: "/workspace/codex-feishu-bridge",
      mode: "bridge-managed",
      createdAt: "2026-03-17T00:00:00.000Z",
    });

    assert.equal(task.taskId, "thread-123");
    assert.equal(task.threadId, "thread-123");
    assert.equal(task.status, "idle");
    assert.equal(task.taskOrigin, "runtime");
    assert.equal(task.desktopReplySyncToFeishu, false);
    assert.equal(task.feishuRunningMessageMode, "queue");
    assert.equal(task.queuedMessageCount, 0);
    assert.deepEqual(task.pendingApprovals, []);
    assert.deepEqual(task.diffs, []);
  });

  it("defaults imported tasks to the cli origin and preserves explicit origins", () => {
    const imported = createBridgeTask({
      threadId: "thread-imported",
      title: "Imported task",
      workspaceRoot: "/workspace/codex-feishu-bridge",
      mode: "manual-import",
      createdAt: "2026-03-17T00:00:00.000Z",
    });
    const vscode = createBridgeTask({
      threadId: "thread-vscode",
      title: "VSCode task",
      workspaceRoot: "/workspace/codex-feishu-bridge",
      mode: "bridge-managed",
      taskOrigin: "vscode",
      createdAt: "2026-03-17T00:00:00.000Z",
    });

    assert.equal(imported.taskOrigin, "cli");
    assert.equal(vscode.taskOrigin, "vscode");
  });

  it("creates sequenced bridge events", () => {
    const event = createBridgeEvent(
      7,
      "thread-123",
      "task.created",
      { source: "test" },
      "2026-03-17T00:00:01.000Z",
    );

    assert.equal(event.seq, 7);
    assert.equal(event.taskId, "thread-123");
    assert.equal(event.kind, "task.created");
    assert.deepEqual(event.payload, { source: "test" });
  });

  it("detects terminal task states", () => {
    assert.equal(isTerminalTaskStatus("completed"), true);
    assert.equal(isTerminalTaskStatus("failed"), true);
    assert.equal(isTerminalTaskStatus("interrupted"), true);
    assert.equal(isTerminalTaskStatus("running"), false);
  });
});
