import type { BridgeTask } from "@codex-feishu-bridge/protocol";

import type { ExtensionSnapshot } from "./task-model";

export interface MonitorTaskBadge {
  label: string;
  tone: "feishu" | "vscode" | "cli" | "runtime";
}

export interface MonitorTaskListEntry {
  taskId: string;
  title: string;
  status: BridgeTask["status"];
  isSelected: boolean;
  isFeishuBound: boolean;
  badges: MonitorTaskBadge[];
  description: string;
  executionSummary: string;
}

export interface MonitorConversationEntry {
  messageId: string;
  author: string;
  surface: string;
  content: string;
  createdAt: string;
  assetIds?: string[];
}

export interface MonitorApprovalEntry {
  requestId: string;
  kind: string;
  reason: string;
  state: string;
}

export interface MonitorTaskState {
  taskId: string;
  title: string;
  status: BridgeTask["status"];
  mode: BridgeTask["mode"];
  taskOrigin: BridgeTask["taskOrigin"];
  isFeishuBound: boolean;
  badges: MonitorTaskBadge[];
  canForgetLocalTask: boolean;
  workspaceRoot: string;
  latestSummary?: string;
  threadId: string;
  activeTurnId?: string;
  desktopReplySyncToFeishu: boolean;
  feishuBinding?: BridgeTask["feishuBinding"];
  executionProfile: BridgeTask["executionProfile"];
  assets: Array<{
    assetId: string;
    kind: "image" | "file";
    displayName: string;
    mimeType: string;
  }>;
  conversation: MonitorConversationEntry[];
  approvals: MonitorApprovalEntry[];
  diffs: Array<{
    path: string;
    summary: string;
    patch?: string;
  }>;
}

export interface MonitorViewState {
  connection: ExtensionSnapshot["connection"];
  taskCount: number;
  totalTaskCount: number;
  hiddenTaskCount: number;
  showLocalImportedTasks: boolean;
  lastUpdatedAt?: string;
  account: unknown;
  rateLimits: unknown;
  selectedTaskId?: string;
  tasks: MonitorTaskListEntry[];
  selectedTask: MonitorTaskState | null;
}

interface BuildMonitorStateOptions {
  showLocalImportedTasks?: boolean;
  autoSelectFirstTask?: boolean;
}

function normalizedTaskOrigin(task: Pick<BridgeTask, "mode" | "taskOrigin">): BridgeTask["taskOrigin"] {
  return task.taskOrigin ?? (task.mode === "manual-import" ? "cli" : "runtime");
}

function taskOriginLabel(origin: BridgeTask["taskOrigin"]): string {
  return origin.toUpperCase();
}

function taskBadges(task: BridgeTask): MonitorTaskBadge[] {
  const badges: MonitorTaskBadge[] = [];
  const taskOrigin = normalizedTaskOrigin(task);

  if (task.feishuBinding) {
    badges.push({
      label: "FEISHU",
      tone: "feishu",
    });
  }

  if (!task.feishuBinding || taskOrigin !== "feishu") {
    badges.push({
      label: taskOriginLabel(taskOrigin),
      tone: taskOrigin,
    });
  }

  return badges;
}

function taskDescription(task: BridgeTask): string {
  const details: string[] = [];
  details.push(task.status);
  const pendingApprovals = task.pendingApprovals.filter((entry) => entry.state === "pending").length;
  if (pendingApprovals > 0) {
    details.push(`${pendingApprovals} approvals`);
  }
  details.push(`${task.conversation.length} msgs`);
  return details.join(" · ");
}

function executionValue(value: string | undefined, fallback: string): string {
  return value?.trim() ? value.trim() : fallback;
}

function taskExecutionSummary(task: Pick<BridgeTask, "executionProfile">): string {
  const profile = task.executionProfile ?? {};
  return [
    `Model: ${executionValue(profile.model, "runtime-default")}`,
    `Reasoning: ${executionValue(profile.effort, "model-default")}`,
    `Plan: ${profile.planMode ? "on" : "off"}`,
  ].join(" · ");
}

function filterMonitorTasks(tasks: BridgeTask[], showLocalImportedTasks: boolean): BridgeTask[] {
  return showLocalImportedTasks ? tasks : tasks.filter((task) => Boolean(task.feishuBinding));
}

export function pickMonitorTask(
  tasks: BridgeTask[],
  selectedTaskId?: string,
  showLocalImportedTasks = false,
  autoSelectFirstTask = true,
): BridgeTask | null {
  const visibleTasks = filterMonitorTasks(tasks, showLocalImportedTasks);
  if (selectedTaskId) {
    const selected = visibleTasks.find((task) => task.taskId === selectedTaskId);
    if (selected) {
      return selected;
    }

    return autoSelectFirstTask ? (visibleTasks.find((task) => Boolean(task.feishuBinding)) ?? visibleTasks[0] ?? null) : null;
  }

  if (!autoSelectFirstTask) {
    return null;
  }

  return visibleTasks.find((task) => Boolean(task.feishuBinding)) ?? visibleTasks[0] ?? null;
}

export function buildMonitorState(
  snapshot: ExtensionSnapshot,
  selectedTaskId?: string,
  options?: BuildMonitorStateOptions,
): MonitorViewState {
  const showLocalImportedTasks = options?.showLocalImportedTasks ?? false;
  const autoSelectFirstTask = options?.autoSelectFirstTask ?? true;
  const visibleTasks = filterMonitorTasks(snapshot.tasks, showLocalImportedTasks);
  const selectedTask = pickMonitorTask(snapshot.tasks, selectedTaskId, showLocalImportedTasks, autoSelectFirstTask);
  return {
    connection: snapshot.connection,
    taskCount: visibleTasks.length,
    totalTaskCount: snapshot.tasks.length,
    hiddenTaskCount: Math.max(0, snapshot.tasks.length - visibleTasks.length),
    showLocalImportedTasks,
    lastUpdatedAt: snapshot.lastUpdatedAt,
    account: snapshot.account,
    rateLimits: snapshot.rateLimits,
    selectedTaskId: selectedTask?.taskId,
    tasks: visibleTasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      isSelected: task.taskId === selectedTask?.taskId,
      isFeishuBound: Boolean(task.feishuBinding),
      badges: taskBadges(task),
      description: taskDescription(task),
      executionSummary: taskExecutionSummary(task),
    })),
    selectedTask: selectedTask
      ? {
          taskId: selectedTask.taskId,
          title: selectedTask.title,
          status: selectedTask.status,
          mode: selectedTask.mode,
          taskOrigin: normalizedTaskOrigin(selectedTask),
          isFeishuBound: Boolean(selectedTask.feishuBinding),
          badges: taskBadges(selectedTask),
          canForgetLocalTask: !selectedTask.feishuBinding,
          workspaceRoot: selectedTask.workspaceRoot,
          latestSummary: selectedTask.latestSummary,
          threadId: selectedTask.threadId,
          activeTurnId: selectedTask.activeTurnId,
          desktopReplySyncToFeishu: selectedTask.desktopReplySyncToFeishu,
          feishuBinding: selectedTask.feishuBinding,
          executionProfile: selectedTask.executionProfile,
          assets: (selectedTask.assets ?? []).map((asset) => ({
            assetId: asset.assetId,
            kind: asset.kind,
            displayName: asset.displayName,
            mimeType: asset.mimeType,
          })),
          conversation: selectedTask.conversation.map((entry) => ({
            messageId: entry.messageId,
            author: entry.author,
            surface: entry.surface,
            content: entry.content,
            createdAt: entry.createdAt,
            assetIds: entry.assetIds,
          })),
          approvals: selectedTask.pendingApprovals.map((entry) => ({
            requestId: entry.requestId,
            kind: entry.kind,
            reason: entry.reason,
            state: entry.state,
          })),
          diffs: selectedTask.diffs.map((entry) => ({
            path: entry.path,
            summary: entry.summary,
            ...(entry.patch ? { patch: entry.patch } : {}),
          })),
        }
      : null,
  };
}
