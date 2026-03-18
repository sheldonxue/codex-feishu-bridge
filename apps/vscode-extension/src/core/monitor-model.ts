import type { BridgeTask } from "@codex-feishu-bridge/protocol";

import type { ExtensionSnapshot } from "./task-model";

export interface MonitorTaskListEntry {
  taskId: string;
  title: string;
  status: BridgeTask["status"];
  isSelected: boolean;
  isFeishuBound: boolean;
  description: string;
}

export interface MonitorConversationEntry {
  messageId: string;
  author: string;
  surface: string;
  content: string;
  createdAt: string;
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
  isFeishuBound: boolean;
  canForgetLocalTask: boolean;
  workspaceRoot: string;
  latestSummary?: string;
  threadId: string;
  activeTurnId?: string;
  desktopReplySyncToFeishu: boolean;
  feishuBinding?: BridgeTask["feishuBinding"];
  executionProfile: BridgeTask["executionProfile"];
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
}

function taskDescription(task: BridgeTask): string {
  const details: string[] = [];
  if (task.feishuBinding) {
    details.push("Feishu");
  }
  details.push(task.status);
  const pendingApprovals = task.pendingApprovals.filter((entry) => entry.state === "pending").length;
  if (pendingApprovals > 0) {
    details.push(`${pendingApprovals} approvals`);
  }
  details.push(`${task.conversation.length} msgs`);
  return details.join(" · ");
}

function filterMonitorTasks(tasks: BridgeTask[], showLocalImportedTasks: boolean): BridgeTask[] {
  return showLocalImportedTasks ? tasks : tasks.filter((task) => Boolean(task.feishuBinding));
}

export function pickMonitorTask(
  tasks: BridgeTask[],
  selectedTaskId?: string,
  showLocalImportedTasks = false,
): BridgeTask | null {
  const visibleTasks = filterMonitorTasks(tasks, showLocalImportedTasks);
  if (selectedTaskId) {
    const selected = visibleTasks.find((task) => task.taskId === selectedTaskId);
    if (selected) {
      return selected;
    }
  }

  return visibleTasks.find((task) => Boolean(task.feishuBinding)) ?? visibleTasks[0] ?? null;
}

export function buildMonitorState(
  snapshot: ExtensionSnapshot,
  selectedTaskId?: string,
  options?: BuildMonitorStateOptions,
): MonitorViewState {
  const showLocalImportedTasks = options?.showLocalImportedTasks ?? false;
  const visibleTasks = filterMonitorTasks(snapshot.tasks, showLocalImportedTasks);
  const selectedTask = pickMonitorTask(snapshot.tasks, selectedTaskId, showLocalImportedTasks);
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
      description: taskDescription(task),
    })),
    selectedTask: selectedTask
      ? {
          taskId: selectedTask.taskId,
          title: selectedTask.title,
          status: selectedTask.status,
          mode: selectedTask.mode,
          isFeishuBound: Boolean(selectedTask.feishuBinding),
          canForgetLocalTask: !selectedTask.feishuBinding,
          workspaceRoot: selectedTask.workspaceRoot,
          latestSummary: selectedTask.latestSummary,
          threadId: selectedTask.threadId,
          activeTurnId: selectedTask.activeTurnId,
          desktopReplySyncToFeishu: selectedTask.desktopReplySyncToFeishu,
          feishuBinding: selectedTask.feishuBinding,
          executionProfile: selectedTask.executionProfile,
          conversation: selectedTask.conversation.map((entry) => ({
            messageId: entry.messageId,
            author: entry.author,
            surface: entry.surface,
            content: entry.content,
            createdAt: entry.createdAt,
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
