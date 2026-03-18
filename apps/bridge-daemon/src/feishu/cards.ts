import type {
  ApprovalPolicy,
  BridgeTask,
  FeishuRunningMessageMode,
  FeishuThreadBinding,
  QueuedApproval,
  ReasoningEffort,
  SandboxMode,
  TaskExecutionProfile,
} from "@codex-feishu-bridge/protocol";

const DEFAULT_NEW_SANDBOX: SandboxMode = "workspace-write";
const DEFAULT_NEW_APPROVAL_POLICY: ApprovalPolicy = "on-request";
const CARD_NOTE_MAX_CHARS = 1400;

export interface FeishuInteractiveCard {
  config?: {
    enable_forward?: boolean;
    update_multi?: boolean;
    wide_screen_mode?: boolean;
  };
  header?: {
    title: {
      tag: "plain_text";
      content: string;
    };
    template?: "blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red" | "carmine" | "violet" | "purple" | "indigo" | "grey";
  };
  elements?: Array<Record<string, unknown>>;
}

export interface FeishuModelOption {
  id: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
}

export interface FeishuThreadDraftCardData {
  prompt?: string;
  model?: string;
  effort?: ReasoningEffort;
  planMode: boolean;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  attachmentSummary?: string;
  note?: string;
  binding: FeishuThreadBinding;
  revision: number;
  modelOptions: FeishuModelOption[];
}

export interface FeishuTaskControlCardData {
  task: BridgeTask;
  note?: string;
  binding: FeishuThreadBinding;
  revision: number;
  modelOptions: FeishuModelOption[];
}

export interface FeishuArchivedThreadCardData {
  binding: FeishuThreadBinding;
  taskId?: string;
  taskTitle?: string;
  archivedAt?: string;
  note?: string;
}

export type FeishuCardActionKind =
  | "test.ping"
  | "draft.select.model"
  | "draft.select.effort"
  | "draft.toggle.plan-mode"
  | "draft.select.sandbox"
  | "draft.select.approval"
  | "draft.use-defaults"
  | "draft.create"
  | "draft.cancel"
  | "task.select.model"
  | "task.select.effort"
  | "task.toggle.plan-mode"
  | "task.toggle.feishu-running-mode"
  | "task.status"
  | "task.interrupt"
  | "task.retry"
  | "task.approve"
  | "task.decline"
  | "task.cancel-approval"
  | "task.archive"
  | "task.unbind"
  | "task.inspect"
  | "task.inspect.global";

export interface FeishuCardActionValue {
  kind: FeishuCardActionKind;
  chatId: string;
  threadKey: string;
  rootMessageId?: string;
  taskId?: string;
  requestId?: string;
  revision?: number;
}

function plainText(content: string): { tag: "plain_text"; content: string } {
  return {
    tag: "plain_text",
    content,
  };
}

function markdown(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
  };
}

function divider(): Record<string, unknown> {
  return {
    tag: "hr",
  };
}

function action(actions: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    tag: "action",
    actions,
  };
}

function button(params: {
  text: string;
  value: FeishuCardActionValue;
  type?: "default" | "primary" | "danger";
}): Record<string, unknown> {
  return {
    tag: "button",
    type: params.type ?? "default",
    text: plainText(params.text),
    value: params.value,
  };
}

function selectStatic(params: {
  placeholder: string;
  initialOption?: string;
  options: Array<{ label: string; value: string }>;
  value: FeishuCardActionValue;
}): Record<string, unknown> {
  const serializedOptions = params.options.map((option) => ({
    text: plainText(option.label),
    value: option.value,
  }));

  return {
    tag: "select_static",
    placeholder: plainText(params.placeholder),
    ...(params.initialOption ? { initial_option: params.initialOption } : {}),
    // Some Feishu clients and SDK references disagree on whether the field is
    // `option` or `options`. Emit both so mobile clients always receive the
    // candidate list.
    option: serializedOptions,
    options: serializedOptions,
    value: params.value,
  };
}

function overflow(params: {
  text: string;
  options: Array<{ label: string; value: string }>;
  value: FeishuCardActionValue;
}): Record<string, unknown> {
  return {
    tag: "overflow",
    text: plainText(params.text),
    options: params.options.map((option) => ({
      text: plainText(option.label),
      value: option.value,
    })),
    value: params.value,
  };
}

function truncateNote(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length <= CARD_NOTE_MAX_CHARS) {
    return trimmed;
  }

  return `${trimmed.slice(0, CARD_NOTE_MAX_CHARS - 16)}\n\n[truncated]`;
}

function formatExecutionProfile(profile: TaskExecutionProfile | undefined): string[] {
  return [
    `model: ${profile?.model ?? "runtime-default"}`,
    `effort: ${profile?.effort ?? "model-default"}`,
    `planMode: ${profile?.planMode ? "on" : "off"}`,
    `sandbox: ${profile?.sandbox ?? DEFAULT_NEW_SANDBOX}`,
    `approvalPolicy: ${profile?.approvalPolicy ?? DEFAULT_NEW_APPROVAL_POLICY}`,
  ];
}

function formatFeishuRunningMessageMode(mode: FeishuRunningMessageMode): string {
  return mode === "queue" ? "queue next turn" : "steer current turn";
}

function taskStartGuidance(task: BridgeTask): string[] {
  if (task.conversation.length > 0) {
    return [];
  }

  return [
    "**Next Step**",
    "- this task is already created on the workstation and bound to this Feishu thread",
    "- send the first plain-text message in this thread to start the first turn",
    "- Create on Host only appears on the draft card before the task exists",
  ];
}

function baseActionValue(
  kind: FeishuCardActionKind,
  binding: FeishuThreadBinding,
  extras: Partial<Omit<FeishuCardActionValue, "kind" | "chatId" | "threadKey" | "rootMessageId">> = {},
): FeishuCardActionValue {
  return {
    kind,
    chatId: binding.chatId,
    threadKey: binding.threadKey,
    ...(binding.rootMessageId ? { rootMessageId: binding.rootMessageId } : {}),
    ...extras,
  };
}

function buildApprovalActionRows(task: BridgeTask, binding: FeishuThreadBinding, revision: number): Array<Record<string, unknown>> {
  return task.pendingApprovals
    .filter((approval) => approval.state === "pending")
    .flatMap((approval) => {
      const value = {
        taskId: task.taskId,
        requestId: approval.requestId,
        revision,
      };

      return [
        markdown(
          [
            `**Pending Approval**`,
            `requestId: ${approval.requestId}`,
            `kind: ${approval.kind}`,
            `reason: ${approval.reason}`,
          ].join("\n"),
        ),
        action([
          button({
            text: "Approve",
            type: "primary",
            value: baseActionValue("task.approve", binding, { ...value }),
          }),
          button({
            text: "Decline",
            type: "danger",
            value: baseActionValue("task.decline", binding, { ...value }),
          }),
          button({
            text: "Cancel Approval",
            value: baseActionValue("task.cancel-approval", binding, { ...value }),
          }),
        ]),
      ];
    });
}

export function createCardActionValue(
  kind: FeishuCardActionKind,
  binding: FeishuThreadBinding,
  extras?: Partial<Omit<FeishuCardActionValue, "kind" | "chatId" | "threadKey" | "rootMessageId">>,
): FeishuCardActionValue {
  return baseActionValue(kind, binding, extras);
}

export function createCardTestCard(note?: string): FeishuInteractiveCard {
  const normalizedNote = truncateNote(note);
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: plainText("Codex Bridge Card Test"),
      template: "blue",
    },
    elements: [
      markdown("Use the button below to verify that `card.action.trigger` reaches the bridge over Feishu long connection."),
      ...(normalizedNote ? [divider(), markdown(`**Result**\n${normalizedNote}`)] : []),
    ],
  };
}

export function createDraftCard(data: FeishuThreadDraftCardData): FeishuInteractiveCard {
  const note = truncateNote(data.note);
  const selectedEffort = data.effort;
  const selectedModel = data.model;
  const modelOptions = data.modelOptions.map((model) => ({
    label: model.isDefault ? `${model.id} (default)` : `${model.id} (${model.displayName})`,
    value: model.id,
  }));
  const modelDescriptor = data.modelOptions.find((entry) => entry.id === selectedModel);
  const effortOptions = (modelDescriptor?.supportedReasoningEfforts ?? ["none", "minimal", "low", "medium", "high", "xhigh"]).map(
    (effort) => ({
      label: modelDescriptor?.defaultReasoningEffort === effort ? `${effort} (default)` : effort,
      value: effort,
    }),
  );

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: plainText("Create Codex Task"),
      template: "blue",
    },
    elements: [
      markdown(
        [
          "**How this thread works**",
          "- plain text updates the draft prompt",
          "- photos and files are queued as draft attachments",
          "- press Create on Host to create the real Codex task on the workstation",
          "- after binding, later plain text, photos, and files continue the same host task",
        ].join("\n"),
      ),
      divider(),
      markdown(`**Draft Prompt**\n${data.prompt?.trim() ? data.prompt : "_Send plain text in this thread to set the prompt._"}`),
      markdown(
        [
          "**Current Settings**",
          ...formatExecutionProfile({
            model: data.model,
            effort: data.effort,
            planMode: data.planMode,
            sandbox: data.sandbox,
            approvalPolicy: data.approvalPolicy,
          }),
          `attachments: ${data.attachmentSummary ?? "none"}`,
        ].join("\n"),
      ),
      ...(note ? [divider(), markdown(`**Latest Update**\n${note}`)] : []),
      divider(),
      ...(modelOptions.length
        ? [
            action([
              selectStatic({
                placeholder: "Choose model",
                initialOption: selectedModel,
                options: modelOptions,
                value: baseActionValue("draft.select.model", data.binding, {
                  revision: data.revision,
                }),
              }),
              selectStatic({
                placeholder: "Choose reasoning effort",
                initialOption: selectedEffort,
                options: effortOptions,
                value: baseActionValue("draft.select.effort", data.binding, {
                  revision: data.revision,
                }),
              }),
            ]),
          ]
        : []),
      action([
        selectStatic({
          placeholder: "Choose sandbox",
          initialOption: data.sandbox,
          options: [
            { label: "read-only", value: "read-only" },
            { label: "workspace-write", value: "workspace-write" },
            { label: "danger-full-access", value: "danger-full-access" },
          ],
          value: baseActionValue("draft.select.sandbox", data.binding, {
            revision: data.revision,
          }),
        }),
        selectStatic({
          placeholder: "Choose approval policy",
          initialOption: data.approvalPolicy,
          options: [
            { label: "untrusted", value: "untrusted" },
            { label: "on-failure", value: "on-failure" },
            { label: "on-request", value: "on-request" },
            { label: "never", value: "never" },
          ],
          value: baseActionValue("draft.select.approval", data.binding, {
            revision: data.revision,
          }),
        }),
      ]),
      action([
        button({
          text: `Plan Mode: ${data.planMode ? "On" : "Off"}`,
          value: baseActionValue("draft.toggle.plan-mode", data.binding, {
            revision: data.revision,
          }),
          type: data.planMode ? "primary" : "default",
        }),
      ]),
      action([
        button({
          text: "Reset to Defaults",
          value: baseActionValue("draft.use-defaults", data.binding, {
            revision: data.revision,
          }),
        }),
        button({
          text: "Create on Host",
          type: "primary",
          value: baseActionValue("draft.create", data.binding, {
            revision: data.revision,
          }),
        }),
        button({
          text: "Discard Draft",
          type: "danger",
          value: baseActionValue("draft.cancel", data.binding, {
            revision: data.revision,
          }),
        }),
      ]),
    ],
  };
}

export function createTaskControlCard(data: FeishuTaskControlCardData): FeishuInteractiveCard {
  const note = truncateNote(data.note);
  const { task, binding, revision } = data;
  const selectedModel = task.executionProfile.model;
  const selectedEffort = task.executionProfile.effort;
  const modelDescriptor = data.modelOptions.find((entry) => entry.id === selectedModel);
  const modelOptions = [
    { label: "runtime-default", value: "" },
    ...data.modelOptions.map((model) => ({
      label: model.isDefault ? `${model.id} (default)` : `${model.id} (${model.displayName})`,
      value: model.id,
    })),
  ];
  const effortOptions = [
    { label: "model-default", value: "" },
    ...((modelDescriptor?.supportedReasoningEfforts ?? ["none", "minimal", "low", "medium", "high", "xhigh"]).map((effort) => ({
      label: modelDescriptor?.defaultReasoningEffort === effort ? `${effort} (default)` : effort,
      value: effort,
    }))),
  ];

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: plainText(`Task: ${task.title}`),
      template: task.status === "failed" ? "red" : task.status === "awaiting-approval" ? "yellow" : "green",
    },
    elements: [
      markdown(
        [
          "**How this thread works**",
          "- plain text, photos, and files in this thread are forwarded into the same host Codex task",
          "- agent replies, approvals, and task notes are returned to this thread",
          "- use Unbind Thread if you want to detach Feishu without deleting the host task",
        ].join("\n"),
      ),
      divider(),
      ...(task.conversation.length === 0
        ? [
            markdown(taskStartGuidance(task).join("\n")),
            divider(),
          ]
        : []),
      markdown(
        [
          `**Current Task**`,
          `taskId: ${task.taskId}`,
          `status: ${task.status}`,
          ...formatExecutionProfile(task.executionProfile),
          `feishu while running: ${formatFeishuRunningMessageMode(task.feishuRunningMessageMode)}`,
          `queued next-turn messages: ${task.queuedMessageCount}`,
          `attachments: ${task.assets.length}`,
          `messages: ${task.conversation.length}`,
          `pending approvals: ${task.pendingApprovals.filter((approval) => approval.state === "pending").length}`,
        ].join("\n"),
      ),
      ...(note ? [divider(), markdown(`**Latest Update**\n${note}`)] : []),
      divider(),
      action([
        selectStatic({
          placeholder: "Choose model",
          initialOption: selectedModel,
          options: modelOptions,
          value: baseActionValue("task.select.model", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
        selectStatic({
          placeholder: "Choose reasoning effort",
          initialOption: selectedEffort,
          options: effortOptions,
          value: baseActionValue("task.select.effort", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
      ]),
      action([
        button({
          text: `Plan Mode: ${task.executionProfile.planMode ? "On" : "Off"}`,
          type: task.executionProfile.planMode ? "primary" : "default",
          value: baseActionValue("task.toggle.plan-mode", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
        button({
          text:
            task.feishuRunningMessageMode === "queue"
              ? "While Running: Queue Next Turn"
              : "While Running: Steer Current Turn",
          type: task.feishuRunningMessageMode === "queue" ? "primary" : "default",
          value: baseActionValue("task.toggle.feishu-running-mode", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
      ]),
      ...buildApprovalActionRows(task, binding, revision),
      divider(),
      markdown(
        [
          "**Run Controls**",
          "- refresh the current summary, retry the last turn, or stop a running turn",
        ].join("\n"),
      ),
      action([
        button({
          text: "View Status",
          value: baseActionValue("task.status", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
        button({
          text: "Stop Turn",
          type: "danger",
          value: baseActionValue("task.interrupt", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
        button({
          text: "Retry Last Turn",
          type: "primary",
          value: baseActionValue("task.retry", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
      ]),
      divider(),
      markdown(
        [
          "**Thread Controls**",
          "- Unbind keeps this topic reusable for another task later",
          "- Archive closes this topic for future work and blocks later plain text from reaching the workstation",
        ].join("\n"),
      ),
      action([
        button({
          text: "Unbind Thread",
          value: baseActionValue("task.unbind", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
        button({
          text: "Archive Task",
          type: "danger",
          value: baseActionValue("task.archive", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
      ]),
      divider(),
      action([
        overflow({
          text: "More",
          options: [
            { label: "Current Task", value: "task" },
            { label: "All Tasks", value: "tasks" },
            { label: "Bridge Health", value: "health" },
            { label: "Account", value: "account" },
            { label: "Rate Limits", value: "limits" },
          ],
          value: baseActionValue("task.inspect.global", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
      ]),
    ],
  };
}

export function createArchivedThreadCard(data: FeishuArchivedThreadCardData): FeishuInteractiveCard {
  const note = truncateNote(data.note);

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: plainText("Archived Codex Topic"),
      template: "grey",
    },
    elements: [
      markdown(
        [
          "**This Feishu topic is archived**",
          "- new plain text, photos, and files in this topic will no longer reach the workstation",
          "- start a new Feishu topic with the bot when you want to launch or bind another task",
          "- the original host task is detached but not deleted",
        ].join("\n"),
      ),
      divider(),
      markdown(
        [
          "**Archived Task**",
          `taskId: ${data.taskId ?? "unknown"}`,
          `title: ${data.taskTitle ?? "unknown"}`,
          data.archivedAt ? `archivedAt: ${data.archivedAt}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      ),
      ...(note ? [divider(), markdown(`**Latest Update**\n${note}`)] : []),
    ],
  };
}
