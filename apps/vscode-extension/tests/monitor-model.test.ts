import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBridgeTask } from "@codex-feishu-bridge/protocol";

import { buildMonitorState, pickMonitorTask } from "../src/core/monitor-model";
import { createEmptySnapshot } from "../src/core/task-model";

describe("monitor model", () => {
  it("prefers the selected task and otherwise falls back to the first feishu-bound task", () => {
    const first = createBridgeTask({
      threadId: "thr-unbound",
      title: "Unbound task",
      workspaceRoot: "/tmp/workspace",
      mode: "bridge-managed",
      createdAt: "2026-03-18T00:00:00.000Z",
    });
    first.updatedAt = "2026-03-18T00:00:01.000Z";

    const second = createBridgeTask({
      threadId: "thr-feishu",
      title: "Feishu task",
      workspaceRoot: "/tmp/workspace",
      mode: "bridge-managed",
      createdAt: "2026-03-18T00:00:00.000Z",
    });
    second.updatedAt = "2026-03-18T00:00:02.000Z";
    second.feishuBinding = {
      chatId: "oc_chat",
      threadKey: "omt_thread",
      rootMessageId: "om_root",
    };
    second.desktopReplySyncToFeishu = true;

    assert.equal(pickMonitorTask([first, second])?.taskId, second.taskId);
    assert.equal(pickMonitorTask([first, second], first.taskId, true)?.taskId, first.taskId);
    assert.equal(pickMonitorTask([first, second], first.taskId)?.taskId, second.taskId);
  });

  it("serializes task source badges and feishu sync state for the monitor view", () => {
    const task = createBridgeTask({
      threadId: "thr-monitor",
      title: "Monitor me",
      workspaceRoot: "/tmp/workspace",
      mode: "bridge-managed",
      createdAt: "2026-03-18T00:00:00.000Z",
    });
    task.updatedAt = "2026-03-18T00:00:03.000Z";
    task.desktopReplySyncToFeishu = true;
    task.feishuBinding = {
      chatId: "oc_chat",
      threadKey: "omt_thread",
      rootMessageId: "om_root",
    };
    task.conversation = [
      {
        messageId: "msg-1",
        author: "user",
        surface: "feishu",
        content: "from phone",
        createdAt: "2026-03-18T00:00:01.000Z",
      },
      {
        messageId: "msg-2",
        author: "agent",
        surface: "feishu",
        content: "reply in thread",
        createdAt: "2026-03-18T00:00:02.000Z",
      },
    ];

    const snapshot = {
      ...createEmptySnapshot(),
      connection: "connected" as const,
      tasks: [task],
      lastUpdatedAt: "2026-03-18T00:00:03.000Z",
    };

    const state = buildMonitorState(snapshot, task.taskId);
    assert.equal(state.selectedTask?.taskId, task.taskId);
    assert.equal(state.tasks[0]?.isFeishuBound, true);
    assert.match(state.tasks[0]?.description ?? "", /Feishu/);
    assert.equal(state.selectedTask?.desktopReplySyncToFeishu, true);
    assert.equal(state.selectedTask?.conversation[0]?.surface, "feishu");
  });

  it("hides local-only tasks by default and exposes them when the filter is enabled", () => {
    const localTask = createBridgeTask({
      threadId: "thr-local",
      title: "Imported local task",
      workspaceRoot: "/tmp/local",
      mode: "manual-import",
      createdAt: "2026-03-18T00:00:00.000Z",
    });
    localTask.updatedAt = "2026-03-18T00:00:02.000Z";

    const feishuTask = createBridgeTask({
      threadId: "thr-feishu-visible",
      title: "Visible Feishu task",
      workspaceRoot: "/tmp/workspace",
      mode: "bridge-managed",
      createdAt: "2026-03-18T00:00:00.000Z",
    });
    feishuTask.updatedAt = "2026-03-18T00:00:03.000Z";
    feishuTask.feishuBinding = {
      chatId: "oc_chat",
      threadKey: "omt_visible",
    };

    const snapshot = {
      ...createEmptySnapshot(),
      connection: "connected" as const,
      tasks: [localTask, feishuTask],
      lastUpdatedAt: "2026-03-18T00:00:03.000Z",
    };

    const defaultState = buildMonitorState(snapshot);
    assert.equal(defaultState.taskCount, 1);
    assert.equal(defaultState.totalTaskCount, 2);
    assert.equal(defaultState.hiddenTaskCount, 1);
    assert.equal(defaultState.tasks[0]?.taskId, feishuTask.taskId);

    const expandedState = buildMonitorState(snapshot, undefined, {
      showLocalImportedTasks: true,
    });
    assert.equal(expandedState.taskCount, 2);
    assert.equal(expandedState.hiddenTaskCount, 0);
    assert.equal(expandedState.showLocalImportedTasks, true);
  });
});
