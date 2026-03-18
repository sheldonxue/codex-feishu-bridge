import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBridgeTask, type FeishuThreadBinding } from "@codex-feishu-bridge/protocol";

import { createArchivedThreadCard, createDraftCard, createTaskControlCard } from "../src/feishu/cards";

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
    assert.match(taskJson, /Plan Mode: Off/);
    assert.match(taskJson, /Run Controls/);
    assert.match(taskJson, /Thread Controls/);
    assert.match(taskJson, /View Status/);
    assert.match(taskJson, /Stop Turn/);
    assert.match(taskJson, /Retry Last Turn/);
    assert.match(taskJson, /Archive Task/);
    assert.match(taskJson, /Unbind Thread/);
    assert.match(taskJson, /Pending Approval/);
    assert.match(taskJson, /Cancel Approval/);
    assert.match(taskJson, /Bridge Health/);
    assert.match(taskJson, /Rate Limits/);
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
