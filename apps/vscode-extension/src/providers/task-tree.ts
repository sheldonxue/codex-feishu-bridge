import * as vscode from "vscode";

import type { BridgeTask } from "@codex-feishu-bridge/protocol";

import { TaskStore } from "../core/task-store";

function taskIcon(status: BridgeTask["status"]): vscode.ThemeIcon {
  switch (status) {
    case "running":
      return new vscode.ThemeIcon("sync~spin");
    case "awaiting-approval":
      return new vscode.ThemeIcon("warning");
    case "failed":
      return new vscode.ThemeIcon("error");
    case "completed":
      return new vscode.ThemeIcon("check");
    case "interrupted":
      return new vscode.ThemeIcon("debug-pause");
    default:
      return new vscode.ThemeIcon("comment-discussion");
  }
}

function taskTooltip(task: BridgeTask): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`### ${task.title}\n`);
  markdown.appendMarkdown(`- Status: \`${task.status}\`\n`);
  markdown.appendMarkdown(`- Mode: \`${task.mode}\`\n`);
  markdown.appendMarkdown(`- Workspace: \`${task.workspaceRoot}\`\n`);
  markdown.appendMarkdown(`- Messages: \`${task.conversation.length}\`\n`);
  markdown.appendMarkdown(`- Pending approvals: \`${task.pendingApprovals.filter((item) => item.state === "pending").length}\`\n`);
  markdown.appendMarkdown(`- Desktop reply sync to Feishu: \`${task.desktopReplySyncToFeishu}\`\n`);
  if (task.feishuBinding) {
    markdown.appendMarkdown(`- Feishu chat: \`${task.feishuBinding.chatId}\`\n`);
    markdown.appendMarkdown(`- Feishu thread: \`${task.feishuBinding.threadKey}\`\n`);
  }
  if (task.latestSummary) {
    markdown.appendMarkdown(`\n${task.latestSummary}`);
  }
  markdown.isTrusted = false;
  return markdown;
}

export class TaskTreeItem extends vscode.TreeItem {
  constructor(readonly task: BridgeTask) {
    super(task.feishuBinding ? `◉ ${task.title}` : task.title, vscode.TreeItemCollapsibleState.None);
    this.id = task.taskId;
    const pendingApprovals = task.pendingApprovals.filter((item) => item.state === "pending").length;
    this.description = [
      task.feishuBinding ? "Feishu" : undefined,
      task.status,
      pendingApprovals ? `${pendingApprovals} approvals` : undefined,
      `${task.conversation.length} msgs`,
    ]
      .filter(Boolean)
      .join(" · ");
    this.contextValue = "bridgeTask";
    this.iconPath = taskIcon(task.status);
    this.tooltip = taskTooltip(task);
    this.command = {
      command: "codexFeishuBridge.focusTaskInMonitor",
      title: "Focus Task In Monitor",
      arguments: [task],
    };
  }
}

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
  private readonly emitter = new vscode.EventEmitter<TaskTreeItem | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposeStoreListener: () => void;
  private showLocalImportedTasks: boolean;

  constructor(
    private readonly store: TaskStore,
    options?: {
      showLocalImportedTasks?: boolean;
    },
  ) {
    this.showLocalImportedTasks = options?.showLocalImportedTasks ?? false;
    this.disposeStoreListener = store.onDidChange(() => {
      this.emitter.fire();
    });
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): TaskTreeItem[] {
    return this.visibleTasks().map((task) => new TaskTreeItem(task));
  }

  setShowLocalImportedTasks(enabled: boolean): void {
    if (this.showLocalImportedTasks === enabled) {
      return;
    }
    this.showLocalImportedTasks = enabled;
    this.emitter.fire();
  }

  private visibleTasks(): BridgeTask[] {
    const tasks = this.store.listTasks();
    return this.showLocalImportedTasks ? tasks : tasks.filter((task) => Boolean(task.feishuBinding));
  }

  dispose(): void {
    this.disposeStoreListener();
    this.emitter.dispose();
  }
}
