import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBridgeTask, type FeishuThreadBinding } from "@codex-feishu-bridge/protocol";

import {
  createArchivedThreadCard,
  createDraftCard,
  createTaskActivityCard,
  createTaskControlCard,
  createTaskInspectionSnapshotCard,
  createTaskRenameCard,
  createTaskStatusSnapshotCard,
} from "../src/feishu/cards";

const BINDING: FeishuThreadBinding = {
  chatId: "oc_chat_id",
  threadKey: "omt_thread",
  rootMessageId: "om_root",
};

describe("feishu card builders", () => {
  it("serializes draft-card select menus with visible option lists", () => {
    const card = createDraftCard({
      prompt: "Inspect the current bridge task state.",
      model: "gpt-5.4",
      effort: "high",
      planMode: true,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      binding: BINDING,
      revision: 3,
      attachmentSummary: "1 photo",
      modelOptions: [
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          isDefault: true,
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "medium",
        },
        {
          id: "gpt-5.4-mini",
          displayName: "GPT-5.4 Mini",
          isDefault: false,
          supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
          defaultReasoningEffort: "low",
        },
      ],
    });

    const selectElements = (card.elements ?? [])
      .filter((element) => element.tag === "action")
      .flatMap((element) => {
        const actions = (element.actions ?? []) as Array<Record<string, unknown>>;
        return actions.filter((action) => action.tag === "select_static");
      });

    assert.ok(selectElements.length >= 4);

    for (const select of selectElements) {
      const legacyOptionList = select.option as Array<Record<string, unknown>> | undefined;
      const optionsList = select.options as Array<Record<string, unknown>> | undefined;
      assert.ok(Array.isArray(legacyOptionList));
      assert.ok(Array.isArray(optionsList));
      assert.ok((legacyOptionList?.length ?? 0) > 0);
      assert.ok((optionsList?.length ?? 0) > 0);
      assert.deepEqual(optionsList, legacyOptionList);
    }
  });

  it("renders clearer mobile guidance and button labels for draft and bound-task cards", () => {
    const draftCard = createDraftCard({
      prompt: "Inspect the current bridge task state.",
      model: "gpt-5.4",
      effort: "high",
      planMode: true,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      binding: BINDING,
      revision: 3,
      note: "Model updated from the card.",
      attachmentSummary: "1 photo",
      modelOptions: [
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          isDefault: true,
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "medium",
        },
      ],
    });

    const task = createBridgeTask({
      threadId: "thr-card-task",
      title: "Bound card task",
      workspaceRoot: "/tmp/workspace",
      mode: "bridge-managed",
    });
    task.status = "awaiting-approval";
    task.feishuRunningMessageMode = "queue";
    task.queuedMessageCount = 2;
    task.conversation = [
      {
        messageId: "msg-1",
        author: "user",
        surface: "feishu",
        content: "please continue",
        createdAt: "2026-03-19T00:00:00.000Z",
      },
    ];
    task.pendingApprovals = [
      {
        requestId: "req-1",
        taskId: task.taskId,
        kind: "command",
        reason: "Need approval",
        state: "pending",
        requestedAt: "2026-03-19T00:00:01.000Z",
      },
    ];

    const taskCard = createTaskControlCard({
      task,
      binding: BINDING,
      revision: 2,
      note: "Queued retry for task.",
      modelOptions: [
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          isDefault: true,
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "medium",
        },
      ],
    });

    const draftJson = JSON.stringify(draftCard);
    const taskJson = JSON.stringify(taskCard);

    assert.match(draftJson, /How this thread works/);
    assert.match(draftJson, /Create on Host/);
    assert.match(draftJson, /Reset to Defaults/);
    assert.match(draftJson, /Discard Draft/);
    assert.match(draftJson, /Plan Mode: On/);
    assert.match(draftJson, /Latest Update/);

    assert.match(taskJson, /How this thread works/);
    assert.match(taskJson, /Current Run Settings/);
    assert.match(taskJson, /model: runtime-default/);
    assert.match(taskJson, /reasoning: model-default/);
    assert.match(taskJson, /plan mode: off/);
    assert.match(taskJson, /Model: runtime-default/);
    assert.match(taskJson, /Reasoning: model-default/);
    assert.match(taskJson, /Plan Mode: Off/);
    assert.match(taskJson, /Run Controls/);
    assert.match(taskJson, /Thread Controls/);
    assert.match(taskJson, /Rename Task/);
    assert.match(taskJson, /View Status/);
    assert.match(taskJson, /Stop Turn/);
    assert.match(taskJson, /Retry Last Turn/);
    assert.match(taskJson, /Archive Task/);
    assert.match(taskJson, /Unbind Thread/);
    assert.match(taskJson, /Pending Approval/);
    assert.match(taskJson, /Cancel Approval/);
    assert.match(taskJson, /Bridge Health/);
    assert.match(taskJson, /Rate Limits/);
    assert.match(taskJson, /busy Feishu replies: queue next turn/);
    assert.match(taskJson, /queued next-turn messages: 2/);
  });

  it("renders a dedicated rename card with a text input that submits form values", () => {
    const task = createBridgeTask({
      threadId: "thr-rename-task",
      title: "Original title",
      workspaceRoot: "/tmp/workspace",
      mode: "bridge-managed",
    });

    const renameCard = createTaskRenameCard({
      task,
      binding: BINDING,
      revision: 4,
      note: "Rename submitted from VSCode.",
    });

    const json = JSON.stringify(renameCard);
    assert.match(json, /Rename Task: Original title/);
    assert.match(json, /Rename the shared task title/);
    assert.match(json, /task_title_input/);
    assert.match(json, /Apply New Title/);
    assert.match(json, /form_submit/);
    assert.match(json, /Rename submitted from VSCode\./);
  });

  it("explains the next step when a host task exists but the first turn has not started yet", () => {
    const task = createBridgeTask({
      threadId: "thr-empty-task",
      title: "Empty task",
      workspaceRoot: "/tmp/workspace",
      mode: "bridge-managed",
    });
    task.status = "idle";

    const taskCard = createTaskControlCard({
      task,
      binding: BINDING,
      revision: 1,
      note: "Created task thr-empty-task. Send the first plain-text message in this thread to start the first turn.",
      modelOptions: [
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          isDefault: true,
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "medium",
        },
      ],
    });

    const json = JSON.stringify(taskCard);
    assert.match(json, /Next Step/);
    assert.match(json, /already created on the workstation/);
    assert.match(json, /send the first plain-text message in this thread to start the first turn/i);
    assert.match(json, /Create on Host only appears on the draft card before the task exists/);
  });

  it("shows explicit model, reasoning, and plan mode details on the first bound task card", () => {
    const task = createBridgeTask({
      threadId: "thr-configured-task",
      title: "Configured task",
      workspaceRoot: "/tmp/workspace",
      mode: "bridge-managed",
      executionProfile: {
        model: "gpt-5.4",
        effort: "high",
        planMode: true,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      },
    });

    const taskCard = createTaskControlCard({
      task,
      binding: BINDING,
      revision: 1,
      modelOptions: [
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          isDefault: true,
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "medium",
        },
      ],
    });

    const json = JSON.stringify(taskCard);
    assert.match(json, /Current Run Settings/);
    assert.match(json, /model: gpt-5\.4 \(default\)/);
    assert.match(json, /reasoning: high/);
    assert.match(json, /plan mode: on/);
    assert.match(json, /Model: gpt-5\.4 \(default\)/);
    assert.match(json, /Reasoning: high/);
    assert.match(json, /Plan Mode: On/);
  });

  it("renders a read-only status snapshot card for mobile status checks", () => {
    const task = createBridgeTask({
      threadId: "thr-status-task",
      title: "Status snapshot task",
      workspaceRoot: "/tmp/workspace",
      mode: "bridge-managed",
    });
    task.status = "running";
    task.feishuRunningMessageMode = "queue";
    task.queuedMessageCount = 1;
    task.conversation = [
      {
        messageId: "msg-status-1",
        author: "agent",
        surface: "runtime",
        content: "Working",
        createdAt: "2026-03-19T00:00:00.000Z",
      },
    ];

    const statusCard = createTaskStatusSnapshotCard({
      task,
      note: "taskId: task-1\nstatus: running",
    });

    const json = JSON.stringify(statusCard);
    assert.match(json, /Task Status Snapshot: Status snapshot task/);
    assert.match(json, /Snapshot Details/);
    assert.match(json, /Use the main task card for controls/);
    assert.doesNotMatch(json, /Latest Update/);
    assert.doesNotMatch(json, /View Status/);
    assert.doesNotMatch(json, /Stop Turn/);
  });

  it("renders a task activity card with queue status and a force-turn action", () => {
    const task = createBridgeTask({
      threadId: "thr-activity-task",
      title: "Activity task",
      workspaceRoot: "/tmp/workspace",
      mode: "bridge-managed",
    });
    task.status = "running";
    task.activeTurnId = "turn-activity";
    task.queuedMessageCount = 2;

    const activityCard = createTaskActivityCard({
      task,
      binding: BINDING,
      revision: 5,
      note: "Queued the latest Feishu message for the next turn.",
      runtimeConnected: true,
      runtimeInitialized: true,
    });

    const json = JSON.stringify(activityCard);
    assert.match(json, /Task Activity: Activity task/);
    assert.match(json, /Current Agent Status/);
    assert.match(json, /state: queued/);
    assert.match(json, /Queued the latest Feishu message for the next turn\./);
    assert.match(json, /Interrupt \+ Run Next Now/);
  });

  it("renders a read-only inspection snapshot card for More-menu queries", () => {
    const task = createBridgeTask({
      threadId: "thr-inspection-task",
      title: "Inspection snapshot task",
      workspaceRoot: "/tmp/workspace",
      mode: "bridge-managed",
    });
    task.status = "idle";

    const inspectionCard = createTaskInspectionSnapshotCard({
      task,
      queryLabel: "Bridge Health",
      note: "status: ok\nfeishuEnabled: true",
    });

    const json = JSON.stringify(inspectionCard);
    assert.match(json, /Bridge Health Snapshot: Inspection snapshot task/);
    assert.match(json, /Snapshot Query/);
    assert.match(json, /query: Bridge Health/);
    assert.match(json, /Snapshot Details/);
    assert.match(json, /Use the main task card for controls/);
    assert.doesNotMatch(json, /Latest Update/);
    assert.doesNotMatch(json, /View Status/);
    assert.doesNotMatch(json, /Stop Turn/);
  });

  it("renders an archived-topic card that tells mobile users the thread is closed", () => {
    const card = createArchivedThreadCard({
      binding: BINDING,
      taskId: "task-archived",
      taskTitle: "Archived task",
      archivedAt: "2026-03-19T00:00:00.000Z",
      note: "Archived this topic from the card.",
    });

    const json = JSON.stringify(card);
    assert.match(json, /Archived Codex Topic/);
    assert.match(json, /This Feishu topic is archived/);
    assert.match(json, /taskId: task-archived/);
    assert.match(json, /start a new Feishu topic/i);
  });
});
