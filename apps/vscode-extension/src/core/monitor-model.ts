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
  lastUpdatedAt?: string;
  account: unknown;
  rateLimits: unknown;
  selectedTaskId?: string;
  tasks: MonitorTaskListEntry[];
  selectedTask: MonitorTaskState | null;
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

export function pickMonitorTask(tasks: BridgeTask[], selectedTaskId?: string): BridgeTask | null {
  if (selectedTaskId) {
    const selected = tasks.find((task) => task.taskId === selectedTaskId);
    if (selected) {
      return selected;
    }
  }

  return tasks.find((task) => Boolean(task.feishuBinding)) ?? tasks[0] ?? null;
}

export function buildMonitorState(snapshot: ExtensionSnapshot, selectedTaskId?: string): MonitorViewState {
  const selectedTask = pickMonitorTask(snapshot.tasks, selectedTaskId);
  return {
    connection: snapshot.connection,
    taskCount: snapshot.tasks.length,
    lastUpdatedAt: snapshot.lastUpdatedAt,
    account: snapshot.account,
    rateLimits: snapshot.rateLimits,
    selectedTaskId: selectedTask?.taskId,
    tasks: snapshot.tasks.map((task) => ({
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
