import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FeishuThreadBinding } from "@codex-feishu-bridge/protocol";

import { createDraftCard } from "../src/feishu/cards";

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
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      binding: BINDING,
      revision: 3,
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
});
