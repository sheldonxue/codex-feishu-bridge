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
export const FEISHU_TASK_MODEL_DEFAULT_OPTION = "__runtime_default__";
export const FEISHU_TASK_EFFORT_DEFAULT_OPTION = "__model_default__";

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

export interface FeishuTaskActivityCardData {
  task: BridgeTask;
  note?: string;
  binding: FeishuThreadBinding;
  revision: number;
  runtimeConnected: boolean;
  runtimeInitialized: boolean;
  receiptState: "queued" | "started" | "steered" | "withdrawn" | "failed";
  queuedMessageId?: string;
  canWithdrawMessage: boolean;
  canForceTurn: boolean;
}

export interface FeishuTaskStatusSnapshotCardData {
  task: BridgeTask;
  note?: string;
}

export interface FeishuTaskRenameCardData {
  task: BridgeTask;
  binding: FeishuThreadBinding;
  revision: number;
  note?: string;
}

export interface FeishuTaskPermissionCardData {
  task: BridgeTask;
  binding: FeishuThreadBinding;
  revision: number;
  note?: string;
}

export interface FeishuTaskInspectionSnapshotCardData {
  task: BridgeTask;
  queryLabel: string;
  note?: string;
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
  | "task.select.sandbox"
  | "task.select.approval"
  | "task.toggle.plan-mode"
  | "task.toggle.feishu-running-mode"
  | "task.force-turn"
  | "task.withdraw-queued-message"
  | "task.rename.open"
  | "task.rename.submit"
  | "task.permissions.open"
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
  queuedMessageId?: string;
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

function form(elements: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    tag: "form",
    elements,
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

function formSubmitButton(params: {
  text: string;
  value: FeishuCardActionValue;
  type?: "default" | "primary" | "danger";
}): Record<string, unknown> {
  return {
    tag: "button",
    type: params.type ?? "primary",
    text: plainText(params.text),
    action_type: "form_submit",
    behaviors: [
      {
        type: "callback",
        value: params.value,
      },
    ],
  };
}

function inputField(params: {
  name: string;
  label: string;
  placeholder: string;
  defaultValue?: string;
}): Record<string, unknown> {
  return {
    tag: "input",
    name: params.name,
    label: plainText(params.label),
    placeholder: plainText(params.placeholder),
    ...(params.defaultValue !== undefined ? { default_value: params.defaultValue } : {}),
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
    ...(params.initialOption !== undefined ? { initial_option: params.initialOption } : {}),
    options: serializedOptions,
    value: JSON.stringify(params.value),
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

function resolveOptionLabel(
  options: Array<{ label: string; value: string }>,
  value: string | undefined,
  fallbackLabel: string,
): string {
  if (value === undefined) {
    return fallbackLabel;
  }

  return options.find((option) => option.value === value)?.label ?? value;
}

function formatFeishuRunningMessageMode(mode: FeishuRunningMessageMode): string {
  return mode === "queue" ? "queue next turn" : "steer current turn";
}

function formatTaskActivityReceiptState(state: FeishuTaskActivityCardData["receiptState"]): string {
  switch (state) {
    case "queued":
      return "queued for the next turn";
    case "started":
      return "started as its own turn";
    case "steered":
      return "sent into the current turn";
    case "withdrawn":
      return "withdrawn before it ran";
    case "failed":
      return "failed to deliver";
    default:
      return state;
  }
}

function formatTaskActivityState(
  task: BridgeTask,
  runtimeConnected: boolean,
  runtimeInitialized: boolean,
): {
  label: string;
  detail: string;
  template: NonNullable<FeishuInteractiveCard["header"]>["template"];
} {
  if (!runtimeConnected || !runtimeInitialized) {
    return {
      label: "offline",
      detail: "The host runtime is not connected right now.",
      template: "grey",
    };
  }

  if (task.status === "failed") {
    return {
      label: "failed",
      detail: "The last turn failed. Review the error or retry from the main task card.",
      template: "red",
    };
  }

  if (task.queuedMessageCount > 0) {
    return {
      label: "queued",
      detail:
        task.status === "awaiting-approval"
          ? "Your newest Feishu message is queued, but the current turn is waiting for approval before it can run."
          : task.status === "blocked"
            ? "Your newest Feishu message is queued, but the current turn is blocked on user input."
            : task.status === "running"
              ? "Codex is still thinking on the current turn. Your newest Feishu message is queued behind it."
              : "A queued Feishu message is waiting to start.",
      template: "orange",
    };
  }

  if (task.status === "awaiting-approval") {
    return {
      label: "waiting for approval",
      detail: "A pending approval must be resolved before the queued Feishu message can run.",
      template: "yellow",
    };
  }

  if (task.status === "blocked") {
    return {
      label: "blocked",
      detail: "The host task is waiting on user input before it can continue.",
      template: "orange",
    };
  }

  if (task.status === "running") {
    return {
      label: "thinking",
      detail: "Codex is actively working on the current turn.",
      template: "turquoise",
    };
  }

  if (task.status === "completed" || task.status === "interrupted" || task.status === "idle") {
    return {
      label: "idle",
      detail: "No busy turn is active right now.",
      template: "green",
    };
  }

  return {
    label: task.status,
    detail: `Current task status: ${task.status}.`,
    template: "blue",
  };
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
      markdown("Send text, photos, or files here to build the draft. Tap Create on Host when ready."),
      divider(),
      markdown(`**Prompt**\n${data.prompt?.trim() ? data.prompt : "_Send plain text in this thread to set the prompt._"}`),
      markdown(
        [
          "**Settings**",
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
      ...(note ? [divider(), markdown(`**Update**\n${note}`)] : []),
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
  const selectedSandbox = task.executionProfile.sandbox ?? DEFAULT_NEW_SANDBOX;
  const selectedApprovalPolicy = task.executionProfile.approvalPolicy ?? DEFAULT_NEW_APPROVAL_POLICY;
  const modelDescriptor = data.modelOptions.find((entry) => entry.id === selectedModel);
  const modelOptions = [
    { label: "runtime-default", value: FEISHU_TASK_MODEL_DEFAULT_OPTION },
    ...data.modelOptions.map((model) => ({
      label: model.isDefault ? `${model.id} (default)` : `${model.id} (${model.displayName})`,
      value: model.id,
    })),
  ];
  const effortOptions = [
    { label: "model-default", value: FEISHU_TASK_EFFORT_DEFAULT_OPTION },
    ...((modelDescriptor?.supportedReasoningEfforts ?? ["none", "minimal", "low", "medium", "high", "xhigh"]).map((effort) => ({
      label: modelDescriptor?.defaultReasoningEffort === effort ? `${effort} (default)` : effort,
      value: effort,
    }))),
  ];
  const currentModelLabel = resolveOptionLabel(
    modelOptions,
    selectedModel ?? FEISHU_TASK_MODEL_DEFAULT_OPTION,
    "runtime-default",
  );
  const currentEffortLabel = resolveOptionLabel(
    effortOptions,
    selectedEffort ?? FEISHU_TASK_EFFORT_DEFAULT_OPTION,
    "model-default",
  );
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
      markdown("This thread stays attached to the same host task."),
      divider(),
      ...(task.conversation.length === 0
        ? [
            markdown(taskStartGuidance(task).join("\n")),
            divider(),
          ]
        : []),
      markdown(
        [
          `**Task**`,
          `taskId: ${task.taskId}`,
          `status: ${task.status}`,
          ...formatExecutionProfile(task.executionProfile),
          `busy Feishu replies: ${formatFeishuRunningMessageMode(task.feishuRunningMessageMode)}`,
          `queued next-turn messages: ${task.queuedMessageCount}`,
          `attachments: ${task.assets.length}`,
          `messages: ${task.conversation.length}`,
          `pending approvals: ${task.pendingApprovals.filter((approval) => approval.state === "pending").length}`,
        ].join("\n"),
      ),
      divider(),
      markdown(
        [
          "**Run Settings**",
          `model: ${currentModelLabel}`,
          `reasoning: ${currentEffortLabel}`,
          `plan mode: ${task.executionProfile.planMode ? "on" : "off"}`,
        ].join("\n"),
      ),
      divider(),
      markdown(
        [
          "**Permissions**",
          `sandbox: ${selectedSandbox}`,
          `approval: ${selectedApprovalPolicy}`,
        ].join("\n"),
      ),
      ...(note ? [divider(), markdown(`**Update**\n${note}`)] : []),
      divider(),
      action([
        selectStatic({
          placeholder: `Model: ${currentModelLabel}`,
          initialOption: selectedModel,
          options: modelOptions,
          value: baseActionValue("task.select.model", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
        selectStatic({
          placeholder: `Reasoning: ${currentEffortLabel}`,
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
      ]),
      ...buildApprovalActionRows(task, binding, revision),
      divider(),
      action([
        button({
          text: "Rename Task",
          value: baseActionValue("task.rename.open", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
        button({
          text: "Task Permissions",
          value: baseActionValue("task.permissions.open", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
        button({
          text: "Unbind Thread",
          value: baseActionValue("task.unbind", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
      ]),
      action([
        button({
          text: "Archive Task",
          type: "danger",
          value: baseActionValue("task.archive", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
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

export function createTaskRenameCard(data: FeishuTaskRenameCardData): FeishuInteractiveCard {
  const note = truncateNote(data.note);
  const { task, binding, revision } = data;

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: plainText(`Rename Task: ${task.title}`),
      template: "blue",
    },
    elements: [
      markdown("Renames the shared bridge task in both VSCode and Feishu."),
      divider(),
      markdown(
        [
          "**Current Title**",
          task.title,
        ].join("\n"),
      ),
      ...(note ? [divider(), markdown(`**Update**\n${note}`)] : []),
      divider(),
      form([
        inputField({
          name: "task_title_input",
          label: "New title",
          placeholder: "Enter the new task title",
          defaultValue: task.title,
        }),
        action([
          formSubmitButton({
            text: "Apply New Title",
            type: "primary",
            value: baseActionValue("task.rename.submit", binding, {
              taskId: task.taskId,
              revision,
            }),
          }),
        ]),
      ]),
    ],
  };
}

export function createTaskPermissionCard(data: FeishuTaskPermissionCardData): FeishuInteractiveCard {
  const note = truncateNote(data.note);
  const { task, binding, revision } = data;
  const selectedSandbox = task.executionProfile.sandbox ?? DEFAULT_NEW_SANDBOX;
  const selectedApprovalPolicy = task.executionProfile.approvalPolicy ?? DEFAULT_NEW_APPROVAL_POLICY;

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: plainText(`Task Permissions: ${task.title}`),
      template: "blue",
    },
    elements: [
      markdown("Updates the sandbox and approval policy for future turns on this shared task."),
      divider(),
      markdown(
        [
          "**Current Permissions**",
          `sandbox: ${selectedSandbox}`,
          `approval: ${selectedApprovalPolicy}`,
        ].join("\n"),
      ),
      ...(note ? [divider(), markdown(`**Update**\n${note}`)] : []),
      divider(),
      action([
        selectStatic({
          placeholder: `Sandbox: ${selectedSandbox}`,
          initialOption: selectedSandbox,
          options: [
            { label: "read-only", value: "read-only" },
            { label: "workspace-write", value: "workspace-write" },
            { label: "danger-full-access", value: "danger-full-access" },
          ],
          value: baseActionValue("task.select.sandbox", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
        selectStatic({
          placeholder: `Approval: ${selectedApprovalPolicy}`,
          initialOption: selectedApprovalPolicy,
          options: [
            { label: "untrusted", value: "untrusted" },
            { label: "on-failure", value: "on-failure" },
            { label: "on-request", value: "on-request" },
            { label: "never", value: "never" },
          ],
          value: baseActionValue("task.select.approval", binding, {
            taskId: task.taskId,
            revision,
          }),
        }),
      ]),
    ],
  };
}

export function createTaskActivityCard(data: FeishuTaskActivityCardData): FeishuInteractiveCard {
  const note = truncateNote(data.note);
  const {
    task,
    binding,
    revision,
    runtimeConnected,
    runtimeInitialized,
    receiptState,
    queuedMessageId,
    canWithdrawMessage,
    canForceTurn,
  } = data;
  const activityState = formatTaskActivityState(task, runtimeConnected, runtimeInitialized);

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: plainText(`Activity: ${task.title}`),
      template: activityState.template,
    },
    elements: [
      markdown(
        [
          "**Receipt**",
          `receipt: ${formatTaskActivityReceiptState(receiptState)}`,
          queuedMessageId ? `queued message id: ${queuedMessageId}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      ),
      divider(),
      markdown(
        [
          "**Status**",
          `state: ${activityState.label}`,
          `detail: ${activityState.detail}`,
          `task status: ${task.status}`,
          `queued next-turn messages: ${task.queuedMessageCount}`,
        ].join("\n"),
      ),
      ...(note ? [divider(), markdown(`**Update**\n${note}`)] : []),
      ...(canWithdrawMessage || canForceTurn
        ? [
            divider(),
            action(
              [
                canWithdrawMessage
                  ? button({
                      text: "Withdraw This Message",
                      type: "danger",
                      value: baseActionValue("task.withdraw-queued-message", binding, {
                        taskId: task.taskId,
                        queuedMessageId,
                        revision,
                      }),
                    })
                  : null,
                canForceTurn
                  ? button({
                      text:
                        task.activeTurnId
                          ? "Interrupt + Run This Message Now"
                          : "Run This Message Now",
                      type: "primary",
                      value: baseActionValue("task.force-turn", binding, {
                        taskId: task.taskId,
                        queuedMessageId,
                        revision,
                      }),
                    })
                  : null,
              ].filter(Boolean) as Array<Record<string, unknown>>,
            ),
          ]
        : []),
    ],
  };
}

export function createTaskStatusSnapshotCard(data: FeishuTaskStatusSnapshotCardData): FeishuInteractiveCard {
  const note = truncateNote(data.note);
  const { task } = data;

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: plainText(`Task Status Snapshot: ${task.title}`),
      template: task.status === "failed" ? "red" : task.status === "awaiting-approval" ? "yellow" : "green",
    },
    elements: [
      markdown(
        [
          "**Current Task**",
          `taskId: ${task.taskId}`,
          `status: ${task.status}`,
          ...formatExecutionProfile(task.executionProfile),
          `busy Feishu replies: ${formatFeishuRunningMessageMode(task.feishuRunningMessageMode)}`,
          `queued next-turn messages: ${task.queuedMessageCount}`,
          `attachments: ${task.assets.length}`,
          `messages: ${task.conversation.length}`,
          `pending approvals: ${task.pendingApprovals.filter((approval) => approval.state === "pending").length}`,
        ].join("\n"),
      ),
      ...(note ? [divider(), markdown(`**Details**\n${note}`)] : []),
      divider(),
      markdown("Use the main task card for retry, interrupt, approvals, unbind, and archive."),
    ],
  };
}

export function createTaskInspectionSnapshotCard(data: FeishuTaskInspectionSnapshotCardData): FeishuInteractiveCard {
  const note = truncateNote(data.note);
  const { task, queryLabel } = data;

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: plainText(`${queryLabel} Snapshot: ${task.title}`),
      template: "blue",
    },
    elements: [
      markdown(
        [
          "**Snapshot Query**",
          `query: ${queryLabel}`,
          `taskId: ${task.taskId}`,
          `status: ${task.status}`,
        ].join("\n"),
      ),
      ...(note ? [divider(), markdown(`**Details**\n${note}`)] : []),
      divider(),
      markdown("Read-only snapshot. Use the main task card for controls."),
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
      markdown("This Feishu topic is archived. New messages here no longer reach the workstation."),
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
      ...(note ? [divider(), markdown(`**Update**\n${note}`)] : []),
      divider(),
      markdown("Start a new Feishu topic when you want to launch or bind another task."),
    ],
  };
}
