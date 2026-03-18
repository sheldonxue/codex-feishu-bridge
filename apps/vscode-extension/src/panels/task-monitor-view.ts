import * as vscode from "vscode";

import type { BridgeTask, MessageSurface, QueuedApproval, TaskExecutionProfile } from "@codex-feishu-bridge/protocol";

import { BridgeClient, type ModelDescriptor } from "../core/bridge-client";
import { buildMonitorState, type MonitorViewState } from "../core/monitor-model";
import { TaskStore } from "../core/task-store";

interface TaskMonitorPanelOptions {
  context: vscode.ExtensionContext;
  client: BridgeClient;
  store: TaskStore;
  sendMessage: (
    taskId: string,
    payload: {
      content: string;
      attachmentPaths?: string[];
      source?: MessageSurface;
      replyToFeishu?: boolean;
      executionProfile?: TaskExecutionProfile;
    },
  ) => Promise<BridgeTask>;
  openStatus: () => Promise<void>;
  openDiff: (task: BridgeTask, diffPath?: string) => Promise<void>;
  setShowLocalImportedTasks: (enabled: boolean) => Promise<void> | void;
  forgetLocalTask: (taskId: string) => Promise<void>;
  deleteLocalTask: (taskId: string) => Promise<void>;
}

function nonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export class TaskMonitorPanel implements vscode.Disposable {
  static readonly panelType = "codexFeishuBridge.monitorPanel";
  private static readonly panelTitle = "Codex Feishu Monitor";
  private static readonly selectedTaskStorageKey = "codexFeishuBridge.monitor.selectedTaskId";
  private static readonly userSelectedTaskStorageKey = "codexFeishuBridge.monitor.userSelectedTask";
  private static readonly showLocalImportedTasksStorageKey = "codexFeishuBridge.monitor.showLocalImportedTasks";

  private readonly disposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel | null = null;
  private selectedTaskId: string | undefined;
  private hasUserSelectedTask: boolean;
  private showLocalImportedTasks: boolean;
  private focusComposerOnNextState = false;

  constructor(private readonly options: TaskMonitorPanelOptions) {
    this.selectedTaskId = this.options.context.workspaceState.get<string>(TaskMonitorPanel.selectedTaskStorageKey);
    this.hasUserSelectedTask =
      this.options.context.workspaceState.get<boolean>(TaskMonitorPanel.userSelectedTaskStorageKey) ??
      Boolean(this.selectedTaskId);
    this.showLocalImportedTasks =
      this.options.context.workspaceState.get<boolean>(TaskMonitorPanel.showLocalImportedTasksStorageKey) ?? false;
    this.disposables.push({
      dispose: this.options.store.onDidChange(() => {
        void this.postState();
      }),
    });
  }

  async show(taskOrId?: BridgeTask | string, focusComposer = false): Promise<void> {
    const taskId = typeof taskOrId === "string" ? taskOrId : taskOrId?.taskId;
    if (taskId) {
      await this.setSelectedTask(taskId);
    }
    if (focusComposer) {
      this.focusComposerOnNextState = true;
    }
    const panel = this.ensurePanel();
    panel.reveal(vscode.ViewColumn.Active, false);
    await this.postState();
  }

  async focusTask(taskOrId?: BridgeTask | string, focusComposer = false): Promise<void> {
    await this.show(taskOrId, focusComposer);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    const payload = message as {
      type?: string;
      taskId?: string;
      content?: string;
      attachmentPaths?: string[];
      diffPath?: string;
      requestId?: string;
      decision?: "accept" | "decline" | "cancel";
      enabled?: boolean;
      limit?: number;
      taskIds?: string[];
      executionProfile?: TaskExecutionProfile;
    };

    try {
      switch (payload.type) {
        case "ready":
          await this.postState();
          return;
        case "select-task":
          await this.setSelectedTask(payload.taskId);
          await this.postState();
          return;
        case "refresh":
          await this.options.store.refresh();
          await this.postState();
          return;
        case "import-recent-threads": {
          const limit = Math.max(1, Math.min(50, Math.trunc(payload.limit ?? 8) || 8));
          const imported = await this.options.client.importRecentThreads(limit);
          await this.options.store.refresh();
          if (imported[0]) {
            await this.focusTask(imported[0].taskId);
          }
          return;
        }
        case "forget-imported-tasks": {
          const confirmed = await vscode.window.showWarningMessage(
            "Clear all imported local tasks from the bridge monitor? Host Codex threads in ~/.codex will be kept.",
            { modal: true },
            "Clear Imported Local Tasks",
          );
          if (!confirmed) {
            return;
          }
          await this.options.client.forgetImportedTasks();
          await this.options.store.refresh();
          await this.postState();
          return;
        }
        case "toggle-local-imported-tasks": {
          this.showLocalImportedTasks = Boolean(payload.enabled);
          await this.options.context.workspaceState.update(
            TaskMonitorPanel.showLocalImportedTasksStorageKey,
            this.showLocalImportedTasks,
          );
          await this.options.setShowLocalImportedTasks(this.showLocalImportedTasks);
          await this.postState();
          return;
        }
        case "open-status":
          await this.options.openStatus();
          return;
        case "send-message": {
          const task = this.getTask(payload.taskId);
          const content = payload.content?.trim();
          if (!task || (!content && !(payload.attachmentPaths?.length))) {
            return;
          }
          await this.options.sendMessage(task.taskId, {
            content: content ?? "",
            attachmentPaths: payload.attachmentPaths ?? [],
            source: "vscode",
            replyToFeishu: task.feishuBinding ? task.desktopReplySyncToFeishu : false,
            executionProfile: payload.executionProfile,
          });
          await this.postWebviewMessage({
            type: "composer-cleared",
            taskId: task.taskId,
          });
          return;
        }
        case "pick-composer-attachments": {
          const task = this.getTask(payload.taskId);
          if (!task) {
            return;
          }
          const files = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: "Attach photos or files",
          });
          if (!files?.length) {
            return;
          }
          await this.postWebviewMessage({
            type: "composer-attachments-selected",
            taskId: task.taskId,
            attachmentPaths: files.map((file) => file.fsPath),
          });
          return;
        }
        case "update-execution-profile": {
          const task = this.getTask(payload.taskId);
          if (!task || !payload.executionProfile) {
            return;
          }
          await this.options.client.updateTaskSettings(task.taskId, {
            executionProfile: payload.executionProfile,
          });
          await this.options.store.refresh();
          return;
        }
        case "interrupt": {
          const task = this.getTask(payload.taskId);
          if (!task) {
            return;
          }
          await this.options.client.interruptTask(task.taskId);
          await this.options.store.refresh();
          return;
        }
        case "retry": {
          const task = this.getTask(payload.taskId);
          if (!task) {
            return;
          }
          await this.options.sendMessage(task.taskId, {
            content: "Retry the last turn and continue.",
            source: "vscode",
            replyToFeishu: task.feishuBinding ? task.desktopReplySyncToFeishu : false,
          });
          return;
        }
        case "toggle-feishu-sync": {
          const task = this.getTask(payload.taskId);
          if (!task?.feishuBinding) {
            return;
          }
          await this.options.client.updateTaskSettings(task.taskId, {
            desktopReplySyncToFeishu: Boolean(payload.enabled),
          });
          await this.options.store.refresh();
          return;
        }
        case "bind-new-feishu-topic": {
          const task = this.getTask(payload.taskId);
          if (!task || task.feishuBinding) {
            return;
          }
          await this.options.client.bindTaskToNewFeishuTopic(task.taskId);
          await this.options.store.refresh();
          await vscode.window.showInformationMessage("Created a new Feishu topic and bound this task.");
          return;
        }
        case "resolve-approval": {
          const task = this.getTask(payload.taskId);
          if (!task || !payload.requestId || !payload.decision) {
            return;
          }
          const approval = task.pendingApprovals.find((entry) => entry.requestId === payload.requestId);
          if (!approval) {
            return;
          }
          await this.options.client.resolveApproval(task.taskId, approval, payload.decision);
          await this.options.store.refresh();
          return;
        }
        case "open-diff": {
          const task = this.getTask(payload.taskId);
          if (!task) {
            return;
          }
          await this.options.openDiff(task, payload.diffPath);
          return;
        }
        case "unbind": {
          const task = this.getTask(payload.taskId);
          if (!task?.feishuBinding) {
            return;
          }
          await this.options.client.unbindFeishuThread(task.taskId);
          await this.options.store.refresh();
          return;
        }
        case "forget-local-task": {
          const task = this.getTask(payload.taskId);
          if (!task || task.feishuBinding) {
            return;
          }
          const confirmed = await vscode.window.showWarningMessage(
            "Forget this local task record from the bridge monitor? The underlying host Codex thread will not be deleted.",
            { modal: true },
            "Forget Local Task",
          );
          if (!confirmed) {
            return;
          }
          await this.options.forgetLocalTask(task.taskId);
          if (this.selectedTaskId === task.taskId) {
            await this.setSelectedTask(undefined);
          }
          await this.options.store.refresh();
          return;
        }
        case "forget-local-tasks": {
          const tasks = this.getLocalTasks(payload.taskIds);
          if (tasks.length === 0) {
            return;
          }
          const confirmed = await vscode.window.showWarningMessage(
            `Forget ${tasks.length} local task record(s) from the bridge monitor? The underlying host Codex threads will not be deleted.`,
            { modal: true },
            "Forget Selected Local Tasks",
          );
          if (!confirmed) {
            return;
          }
          for (const task of tasks) {
            await this.options.forgetLocalTask(task.taskId);
          }
          if (this.selectedTaskId && tasks.some((task) => task.taskId === this.selectedTaskId)) {
            await this.setSelectedTask(undefined);
          }
          await this.options.store.refresh();
          return;
        }
        case "delete-local-task": {
          const task = this.getTask(payload.taskId);
          if (!task || task.feishuBinding) {
            return;
          }
          const confirmed = await vscode.window.showWarningMessage(
            "Delete this local task from the bridge monitor and permanently remove the underlying host Codex thread from this computer?",
            { modal: true },
            "Delete Local Task",
          );
          if (!confirmed) {
            return;
          }
          await this.options.deleteLocalTask(task.taskId);
          if (this.selectedTaskId === task.taskId) {
            await this.setSelectedTask(undefined);
          }
          await this.options.store.refresh();
          return;
        }
        case "delete-local-tasks": {
          const tasks = this.getLocalTasks(payload.taskIds);
          if (tasks.length === 0) {
            return;
          }
          const confirmed = await vscode.window.showWarningMessage(
            `Delete ${tasks.length} local task(s) from the bridge monitor and permanently remove the underlying host Codex threads from this computer?`,
            { modal: true },
            "Delete Selected Local Tasks",
          );
          if (!confirmed) {
            return;
          }
          for (const task of tasks) {
            await this.options.deleteLocalTask(task.taskId);
          }
          if (this.selectedTaskId && tasks.some((task) => task.taskId === this.selectedTaskId)) {
            await this.setSelectedTask(undefined);
          }
          await this.options.store.refresh();
          return;
        }
        default:
          return;
      }
    } catch (error) {
      await vscode.window.showErrorMessage(
        error instanceof Error ? `Codex monitor action failed: ${error.message}` : "Codex monitor action failed.",
      );
    }
  }

  private getTask(taskId?: string): BridgeTask | undefined {
    if (!taskId) {
      return undefined;
    }
    return this.options.store.getTask(taskId);
  }

  private async setSelectedTask(taskId?: string, markAsUserSelection = true): Promise<void> {
    this.selectedTaskId = taskId;
    if (markAsUserSelection) {
      this.hasUserSelectedTask = true;
      await this.options.context.workspaceState.update(TaskMonitorPanel.userSelectedTaskStorageKey, true);
    }
    await this.options.context.workspaceState.update(TaskMonitorPanel.selectedTaskStorageKey, taskId);
  }

  private getLocalTasks(taskIds?: string[]): BridgeTask[] {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return [];
    }

    return [...new Set(taskIds)]
      .map((taskId) => this.getTask(taskId))
      .filter((task): task is BridgeTask => Boolean(task && !task.feishuBinding));
  }

  private async postWebviewMessage(message: Record<string, unknown>): Promise<void> {
    if (!this.panel) {
      return;
    }
    await this.panel.webview.postMessage(message);
  }

  private async postState(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const state = buildMonitorState(this.options.store.getSnapshot(), this.selectedTaskId, {
      showLocalImportedTasks: this.showLocalImportedTasks,
      autoSelectFirstTask: !this.hasUserSelectedTask,
    });
    let models: ModelDescriptor[] = [];
    try {
      models = await this.options.client.listModels();
    } catch {
      models = [];
    }
    if (state.selectedTaskId && state.selectedTaskId !== this.selectedTaskId) {
      this.selectedTaskId = state.selectedTaskId;
      await this.options.context.workspaceState.update(TaskMonitorPanel.selectedTaskStorageKey, this.selectedTaskId);
    }
    this.panel.title = state.selectedTask ? `Codex: ${state.selectedTask.title}` : TaskMonitorPanel.panelTitle;
    await this.panel.webview.postMessage({
      type: "state",
      state: {
        ...state,
        models,
      },
      focusComposer: this.focusComposerOnNextState,
    });
    this.focusComposerOnNextState = false;
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      TaskMonitorPanel.panelType,
      TaskMonitorPanel.panelTitle,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableFindWidget: true,
      },
    );
    panel.webview.html = this.renderHtml(panel.webview);
    panel.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });
    panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel = panel;
    return panel;
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptNonce = nonce();
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f5efe6;
        --panel: rgba(255, 252, 246, 0.94);
        --muted: #6d6a63;
        --fg: #172333;
        --border: rgba(23, 35, 51, 0.14);
        --accent: #115e59;
        --accent-soft: rgba(17, 94, 89, 0.12);
        --danger: #b42318;
        --warning: #a15c07;
        --shadow: 0 10px 30px rgba(10, 16, 24, 0.08);
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0d1520;
          --panel: rgba(20, 29, 41, 0.94);
          --muted: #9ca9b8;
          --fg: #eef4ff;
          --border: rgba(238, 244, 255, 0.12);
          --accent: #6ee7d8;
          --accent-soft: rgba(110, 231, 216, 0.12);
          --danger: #ff8a8a;
          --warning: #f9c74f;
          --shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
        }
      }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(17, 94, 89, 0.16), transparent 30%),
          radial-gradient(circle at bottom right, rgba(213, 153, 51, 0.12), transparent 24%),
          var(--bg);
        color: var(--fg);
      }
      #app {
        display: grid;
        gap: 12px;
        padding: 12px;
      }
      .panel {
        border: 1px solid var(--border);
        background: var(--panel);
        border-radius: 18px;
        padding: 14px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(8px);
      }
      .hero {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
      }
      .hero h1, .hero h2, .hero h3, .hero p { margin: 0; }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 11px;
        color: var(--accent);
        margin-bottom: 6px;
      }
      .muted {
        color: var(--muted);
      }
      .chips, .actions, .approval-actions, .diff-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 5px 10px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.06);
        font-size: 12px;
      }
      .chip.feishu {
        background: var(--accent-soft);
        border-color: rgba(17, 94, 89, 0.25);
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .metric {
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 10px 12px;
      }
      .metric strong {
        display: block;
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 4px;
      }
      .metric span {
        display: block;
        white-space: pre-line;
        line-height: 1.45;
      }
      button, textarea, input[type="checkbox"] {
        font: inherit;
      }
      button {
        border: 1px solid var(--border);
        background: transparent;
        color: inherit;
        border-radius: 12px;
        padding: 8px 12px;
        cursor: pointer;
      }
      button.primary {
        background: var(--accent);
        color: white;
        border-color: transparent;
      }
      button.danger {
        color: var(--danger);
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .task-list {
        display: grid;
        gap: 8px;
      }
      .task-row-shell {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 10px;
        align-items: stretch;
      }
      .task-row-shell.multi-select-enabled {
        grid-template-columns: auto minmax(0, 1fr);
      }
      .task-row-selector {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
      }
      .task-row-selector-spacer {
        display: inline-block;
        width: 16px;
        height: 16px;
      }
      .task-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        align-items: center;
        gap: 10px;
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 10px 12px;
        width: 100%;
        text-align: left;
      }
      .task-row-main {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: start;
      }
      .task-row.selected {
        background: var(--accent-soft);
        border-color: rgba(17, 94, 89, 0.3);
      }
      .task-row .meta {
        display: grid;
        gap: 2px;
        min-width: 0;
      }
      .task-row .meta strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .task-row .meta span {
        text-align: left;
      }
      .task-profile {
        color: var(--muted);
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .task-badges, .hero-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .task-badges {
        justify-content: flex-end;
      }
      .hero-badges {
        justify-content: flex-end;
      }
      .conversation {
        display: grid;
        gap: 10px;
        max-height: 42vh;
        overflow: auto;
        padding-right: 4px;
        scroll-behavior: auto;
      }
      .message {
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 12px;
        display: grid;
        gap: 8px;
      }
      .message header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .badge {
        border-radius: 999px;
        padding: 4px 8px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        border: 1px solid var(--border);
      }
      .badge.cli { background: rgba(180, 83, 9, 0.14); }
      .badge.feishu { background: rgba(17, 94, 89, 0.15); }
      .badge.vscode { background: rgba(30, 64, 175, 0.12); }
      .badge.runtime { background: rgba(148, 163, 184, 0.16); }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: 12px;
      }
      textarea {
        width: 100%;
        min-height: 120px;
        max-height: 320px;
        resize: none;
        border-radius: 14px;
        border: 1px solid var(--border);
        padding: 12px;
        background: rgba(255,255,255,0.02);
        color: inherit;
        box-sizing: border-box;
      }
      .composer-shell {
        display: grid;
        gap: 12px;
      }
      .composer-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .composer-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .composer-attachments {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .composer-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 5px 10px;
        background: rgba(255,255,255,0.05);
        border: 1px solid var(--border);
        font-size: 12px;
      }
      .inline-input {
        width: 72px;
        border-radius: 12px;
        border: 1px solid var(--border);
        padding: 8px 10px;
        background: rgba(255,255,255,0.02);
        color: inherit;
      }
      .composer-footer, .sync-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .toggle {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .foldout {
        padding: 0;
        overflow: hidden;
      }
      .foldout summary {
        list-style: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px;
        cursor: pointer;
      }
      .foldout summary::-webkit-details-marker {
        display: none;
      }
      .foldout-body {
        padding: 0 14px 14px;
      }
      .foldout-title {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .approvals, .diffs {
        display: grid;
        gap: 10px;
      }
      .approval, .diff-item {
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 10px 12px;
        display: grid;
        gap: 8px;
      }
      .empty {
        padding: 18px 0 8px;
        text-align: center;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${scriptNonce}">
      const vscode = acquireVsCodeApi();
      let state = {
        connection: "disconnected",
        taskCount: 0,
        totalTaskCount: 0,
        hiddenTaskCount: 0,
        showLocalImportedTasks: false,
        lastUpdatedAt: undefined,
        tasks: [],
        selectedTask: null,
        selectedTaskId: undefined,
        account: null,
        rateLimits: null,
        models: [],
      };
      let composerDrafts = {};
      let composerAttachmentPaths = {};
      let composerExecutionProfiles = {};
      let importRecentLimit = 8;
      let sectionState = {
        approvals: false,
        diffs: false,
      };
      let conversationScrollByTask = {};
      let selectedLocalTaskIds = {};
      let multiSelectMode = false;

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function pre(value) {
        return \`<pre>\${escapeHtml(value)}</pre>\`;
      }

      function currentTaskId() {
        return state.selectedTask?.taskId ?? state.selectedTaskId;
      }

      function trimSelectedLocalTasks() {
        const visibleLocalTaskIds = new Set(
          state.tasks.filter((task) => !task.isFeishuBound).map((task) => task.taskId),
        );
        for (const taskId of Object.keys(selectedLocalTaskIds)) {
          if (!visibleLocalTaskIds.has(taskId)) {
            delete selectedLocalTaskIds[taskId];
          }
        }
      }

      function selectedVisibleLocalTaskIds() {
        trimSelectedLocalTasks();
        return state.tasks
          .filter((task) => !task.isFeishuBound && selectedLocalTaskIds[task.taskId])
          .map((task) => task.taskId);
      }

      function localTaskSelectionSummary() {
        const selectedCount = selectedVisibleLocalTaskIds().length;
        const availableCount = state.tasks.filter((task) => !task.isFeishuBound).length;
        return {
          selectedCount,
          availableCount,
        };
      }

      function currentComposerDraft() {
        const taskId = currentTaskId();
        return taskId ? (composerDrafts[taskId] ?? "") : "";
      }

      function setCurrentComposerDraft(value) {
        const taskId = currentTaskId();
        if (!taskId) {
          return;
        }
        composerDrafts[taskId] = value;
      }

      function defaultComposerExecutionProfile() {
        const selectedProfile = state.selectedTask?.executionProfile ?? {};
        return {
          model: selectedProfile.model ?? "",
          effort: selectedProfile.effort ?? "",
          planMode: Boolean(selectedProfile.planMode),
        };
      }

      function currentComposerExecutionProfile() {
        const taskId = currentTaskId();
        if (!taskId) {
          return defaultComposerExecutionProfile();
        }
        if (!composerExecutionProfiles[taskId]) {
          composerExecutionProfiles[taskId] = defaultComposerExecutionProfile();
        }
        return composerExecutionProfiles[taskId];
      }

      function setCurrentComposerExecutionProfile(nextProfile) {
        const taskId = currentTaskId();
        if (!taskId) {
          return;
        }
        composerExecutionProfiles[taskId] = {
          ...currentComposerExecutionProfile(),
          ...nextProfile,
        };
      }

      function currentComposerAttachmentPaths() {
        const taskId = currentTaskId();
        return taskId ? (composerAttachmentPaths[taskId] ?? []) : [];
      }

      function setComposerAttachmentPaths(taskId, attachmentPaths) {
        if (!taskId) {
          return;
        }
        composerAttachmentPaths[taskId] = [...new Set(attachmentPaths)];
      }

      function clearComposerState(taskId) {
        if (!taskId) {
          return;
        }
        composerDrafts[taskId] = "";
        composerAttachmentPaths[taskId] = [];
      }

      function fileNameFromPath(targetPath) {
        const segments = String(targetPath ?? "").split(/[\\\\/]/);
        return segments[segments.length - 1] || targetPath;
      }

      function selectedModelDescriptor() {
        const profile = currentComposerExecutionProfile();
        return (state.models ?? []).find((model) => model.id === profile.model || model.model === profile.model) ?? null;
      }

      function currentEffortOptions() {
        const model = selectedModelDescriptor();
        if (!model) {
          return ["none", "minimal", "low", "medium", "high", "xhigh"];
        }
        return model.supportedReasoningEfforts ?? [];
      }

      function countAttachmentKinds(paths) {
        let imageCount = 0;
        let fileCount = 0;
        for (const targetPath of paths) {
          const extension = fileNameFromPath(targetPath).toLowerCase();
          if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(extension)) {
            imageCount += 1;
          } else {
            fileCount += 1;
          }
        }
        return { imageCount, fileCount };
      }

      function formatLastUpdatedAt() {
        if (!state.lastUpdatedAt) {
          return "Waiting for first sync";
        }
        return new Date(state.lastUpdatedAt).toLocaleString();
      }

      function executionValue(value, fallback) {
        if (typeof value !== "string") {
          return fallback;
        }
        const normalized = value.trim();
        return normalized || fallback;
      }

      function captureConversationScroll() {
        const taskId = currentTaskId();
        const conversation = document.getElementById("conversation-list");
        if (!taskId || !(conversation instanceof HTMLElement)) {
          return;
        }
        conversationScrollByTask[taskId] = {
          scrollTop: conversation.scrollTop,
          pinnedToBottom: conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop < 24,
        };
      }

      function restoreConversationScroll() {
        const taskId = currentTaskId();
        const conversation = document.getElementById("conversation-list");
        if (!taskId || !(conversation instanceof HTMLElement)) {
          return;
        }
        const saved = conversationScrollByTask[taskId];
        if (!saved) {
          conversation.scrollTop = conversation.scrollHeight;
          return;
        }
        if (saved.pinnedToBottom) {
          conversation.scrollTop = conversation.scrollHeight;
          return;
        }
        conversation.scrollTop = Math.min(saved.scrollTop, Math.max(0, conversation.scrollHeight - conversation.clientHeight));
      }

      function resizeComposer() {
        const composer = document.getElementById("composer");
        if (!(composer instanceof HTMLTextAreaElement)) {
          return;
        }
        composer.style.height = "0px";
        composer.style.height = Math.min(composer.scrollHeight, 320) + "px";
      }

      function taskRows() {
        if (!state.tasks.length) {
          if (!state.showLocalImportedTasks && state.hiddenTaskCount > 0) {
            return \`<div class="empty">No Feishu-bound tasks are visible right now. Turn on <strong>Show local imported tasks</strong> to inspect \${escapeHtml(String(state.hiddenTaskCount))} local task(s).</div>\`;
          }
          return '<div class="empty">No bridge tasks are available yet. Use <strong>Import Recent Host Threads</strong> to pull the latest host-side Codex sessions into the monitor.</div>';
        }

        return state.tasks
          .map((task) => {
            const selector = multiSelectMode
              ? \`<div class="task-row-selector">\${
                  task.isFeishuBound
                    ? '<span class="task-row-selector-spacer"></span>'
                    : \`<input
                        type="checkbox"
                        data-action="toggle-local-task-selection"
                        data-task-id="\${escapeHtml(task.taskId)}"
                        title="Select this local-only task for bulk forget or delete actions."
                        \${selectedLocalTaskIds[task.taskId] ? "checked" : ""}
                      />\`
                }</div>\`
              : "";

            return \`
              <div class="task-row-shell \${multiSelectMode ? "multi-select-enabled" : ""}">
                \${selector}
                <button
                  class="task-row \${task.isSelected ? "selected" : ""}"
                  data-action="select-task"
                  data-task-id="\${escapeHtml(task.taskId)}"
                  title="Open this task in the monitor."
                >
                  <div class="task-row-main">
                    <div class="meta">
                      <strong>\${escapeHtml(task.title)}</strong>
                      <span class="muted">\${escapeHtml(task.description)}</span>
                      <span class="task-profile" title="Current execution profile for this task.">\${escapeHtml(task.executionSummary)}</span>
                    </div>
                    <div class="task-badges">\${renderBadges(task.badges)}</div>
                  </div>
                </button>
              </div>
            \`;
          })
          .join("");
      }

      function taskSelectionToolbar() {
        const selection = localTaskSelectionSummary();
        if (!multiSelectMode) {
          return \`
            <div class="sync-row" style="margin-bottom: 12px;">
              <span class="muted">\${
                selection.availableCount > 0
                  ? "Bulk actions stay hidden until you turn on multi-select. Only local, non-Feishu tasks can be batch forgotten or deleted."
                  : "No visible local-only tasks are available for bulk cleanup right now."
              }</span>
              <div class="actions">
                <button
                  data-action="toggle-multi-select"
                  title="Show selection checkboxes for visible local-only tasks so you can batch forget or delete them."
                  \${selection.availableCount > 0 ? "" : "disabled"}
                >Multi-select</button>
              </div>
            </div>
          \`;
        }

        return \`
          <div class="sync-row" style="margin-bottom: 12px;">
            <span class="muted">\${escapeHtml(String(selection.selectedCount))} local task(s) selected for bulk actions.</span>
            <div class="actions">
              <button data-action="toggle-multi-select" title="Leave multi-select mode and hide the task checkboxes.">Done</button>
              <button data-action="select-visible-local-tasks" title="Select every visible local-only task in the current list." \${selection.availableCount > 0 ? "" : "disabled"}>Select Visible Local</button>
              <button data-action="clear-local-task-selection" title="Clear the current multi-select choice without changing any tasks." \${selection.selectedCount > 0 ? "" : "disabled"}>Clear Selection</button>
              <button data-action="forget-local-tasks" title="Remove the selected local-only task records from the monitor while keeping the underlying Codex threads on disk." \${selection.selectedCount > 0 ? "" : "disabled"}>Forget Selected</button>
              <button class="danger" data-action="delete-local-tasks" title="Permanently delete the selected local-only tasks and their underlying Codex threads from this computer." \${selection.selectedCount > 0 ? "" : "disabled"}>Delete Selected</button>
            </div>
          </div>
        \`;
      }

      function messageList() {
        if (!state.selectedTask?.conversation?.length) {
          return '<div class="empty">No conversation has been captured for this task yet.</div>';
        }

        return state.selectedTask.conversation
          .map((message) => \`
            <article class="message">
              <header>
                <div class="chips">
                  <span class="badge \${escapeHtml(message.surface)}">\${escapeHtml(message.surface)}</span>
                  <span class="chip">\${escapeHtml(message.author)}</span>
                </div>
                <span class="muted">\${escapeHtml(new Date(message.createdAt).toLocaleString())}</span>
              </header>
              \${pre(message.content)}
              \${messageAttachmentList(message)}
            </article>
          \`)
          .join("");
      }

      function approvalsList() {
        const approvals = state.selectedTask?.approvals ?? [];
        if (!approvals.length) {
          return '<div class="empty">No approvals on this task.</div>';
        }

        return approvals
          .map((approval) => \`
            <article class="approval">
              <div class="chips">
                <span class="chip">\${escapeHtml(approval.kind)}</span>
                <span class="chip">\${escapeHtml(approval.state)}</span>
              </div>
              <strong>\${escapeHtml(approval.reason)}</strong>
              <code>\${escapeHtml(approval.requestId)}</code>
              \${approval.state === "pending"
                ? \`<div class="approval-actions">
                    <button class="primary" data-action="resolve-approval" data-decision="accept" data-request-id="\${escapeHtml(approval.requestId)}" title="Approve this pending request and let Codex continue.">Approve</button>
                    <button data-action="resolve-approval" data-decision="decline" data-request-id="\${escapeHtml(approval.requestId)}" title="Decline this pending request and tell Codex not to proceed with it.">Decline</button>
                    <button class="danger" data-action="resolve-approval" data-decision="cancel" data-request-id="\${escapeHtml(approval.requestId)}" title="Cancel this pending request and mark it as cancelled.">Cancel</button>
                  </div>\`
                : ""}
            </article>
          \`)
          .join("");
      }

      function diffList() {
        const diffs = state.selectedTask?.diffs ?? [];
        if (!diffs.length) {
          return '<div class="empty">No diff payloads captured for this task.</div>';
        }

        return diffs
          .map((diff) => \`
            <article class="diff-item">
              <strong>\${escapeHtml(diff.path)}</strong>
              <span class="muted">\${escapeHtml(diff.summary)}</span>
              <div class="diff-actions">
                <button data-action="open-diff" data-diff-path="\${escapeHtml(diff.path)}" title="Open this captured diff in the VSCode diff view.">Open Diff</button>
              </div>
            </article>
          \`)
          .join("");
      }

      function foldout(section, title, count, content) {
        return \`
          <details class="panel foldout" data-section="\${escapeHtml(section)}" \${sectionState[section] ? "open" : ""}>
            <summary title="Show or hide \${escapeHtml(title.toLowerCase())} for the selected task.">
              <div class="foldout-title">
                <div class="eyebrow" style="margin-bottom:0;">\${escapeHtml(title)}</div>
                <span class="chip">\${escapeHtml(String(count))}</span>
              </div>
              <span class="muted">Toggle</span>
            </summary>
            <div class="foldout-body">\${content}</div>
          </details>
        \`;
      }

      function renderBadges(badges) {
        if (!Array.isArray(badges) || badges.length === 0) {
          return "";
        }

        return badges
          .map(
            (badge) =>
              \`<span class="badge \${escapeHtml(String(badge?.tone ?? "runtime"))}">\${escapeHtml(String(badge?.label ?? ""))}</span>\`,
          )
          .join("");
      }

      function taskAssetById(assetId) {
        return (state.selectedTask?.assets ?? []).find((asset) => asset.assetId === assetId) ?? null;
      }

      function messageAttachmentList(message) {
        if (!Array.isArray(message.assetIds) || message.assetIds.length === 0) {
          return "";
        }

        return \`<div class="composer-attachments">\${message.assetIds
          .map((assetId) => {
            const asset = taskAssetById(assetId);
            if (!asset) {
              return "";
            }
            return \`<span class="composer-chip">\${escapeHtml(asset.kind === "image" ? "Photo" : "File")} · \${escapeHtml(asset.displayName)}</span>\`;
          })
          .join("")}</div>\`;
      }

      function composerAttachmentList() {
        const attachmentPaths = currentComposerAttachmentPaths();
        if (!attachmentPaths.length) {
          return '<span class="muted">No local photos or files attached.</span>';
        }

        return attachmentPaths
          .map((attachmentPath) => \`<span class="composer-chip">\${escapeHtml(fileNameFromPath(attachmentPath))}</span>\`)
          .join("");
      }

      function accountSummary() {
        const account = state.account?.account;
        if (!account) {
          return "No account loaded";
        }
        return [account.type, account.email, account.planType].filter(Boolean).join(" · ");
      }

      function formatResetTime(epochSeconds) {
        if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) {
          return "unknown reset";
        }
        return new Date(epochSeconds * 1000).toLocaleString(undefined, {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      }

      function formatWindowDuration(minutes) {
        if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
          return "?";
        }
        if (minutes % 1440 === 0) {
          return String(minutes / 1440) + "d";
        }
        if (minutes % 60 === 0) {
          return String(minutes / 60) + "h";
        }
        return String(minutes) + "m";
      }

      function remainingPercent(window) {
        if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) {
          return "?";
        }
        return String(Math.max(0, Math.min(100, 100 - window.usedPercent)));
      }

      function formatRateWindow(label, window) {
        if (!window) {
          return null;
        }
        const parts = [
          label + " " + remainingPercent(window) + "% left",
          formatWindowDuration(window.windowDurationMins),
          "reset " + formatResetTime(window.resetsAt),
        ];
        return parts.join(" · ");
      }

      function rateSummary() {
        const rate = state.rateLimits?.rateLimits;
        if (!rate) {
          return "Unavailable";
        }
        const lines = [];
        const primary = formatRateWindow("Primary", rate.primary);
        const secondary = formatRateWindow("Secondary", rate.secondary);
        if (primary) {
          lines.push(primary);
        }
        if (secondary) {
          lines.push(secondary);
        }
        return lines.join("\\n") || "Available";
      }

      function modelSelectOptionsHtml() {
        const currentModel = currentComposerExecutionProfile().model ?? "";
        const options = [
          \`<option value="">Runtime default</option>\`,
          ...(state.models ?? []).map((model) => \`<option value="\${escapeHtml(model.id)}" \${model.id === currentModel ? "selected" : ""}>\${escapeHtml(model.id)}</option>\`),
        ];
        return options.join("");
      }

      function effortSelectOptionsHtml() {
        const currentEffort = currentComposerExecutionProfile().effort ?? "";
        const options = [
          \`<option value="">Model default</option>\`,
          ...currentEffortOptions().map((effort) => \`<option value="\${escapeHtml(effort)}" \${effort === currentEffort ? "selected" : ""}>\${escapeHtml(effort)}</option>\`),
        ];
        return options.join("");
      }

      function attachmentSummaryText() {
        const attachments = currentComposerAttachmentPaths();
        if (!attachments.length) {
          return "No attachments selected.";
        }
        const counts = countAttachmentKinds(attachments);
        const parts = [];
        if (counts.imageCount > 0) {
          parts.push(String(counts.imageCount) + " photo(s)");
        }
        if (counts.fileCount > 0) {
          parts.push(String(counts.fileCount) + " file(s)");
        }
        return parts.join(" · ");
      }

      function emptySelectionHint() {
        if (!state.showLocalImportedTasks && state.hiddenTaskCount > 0) {
          return "Only Feishu-bound tasks are currently shown. Turn on Show local imported tasks if you want to inspect imported host threads.";
        }
        return "Pick a task from the list above. Opened as an editor tab, this monitor keeps conversation, approvals, diffs, and the desktop composer on one page.";
      }

      function sendCurrentComposerMessage() {
        const taskId = currentTaskId();
        const composer = document.getElementById("composer");
        const content = composer instanceof HTMLTextAreaElement ? composer.value.trim() : "";
        const attachmentPaths = taskId ? currentComposerAttachmentPaths() : [];
        const executionProfile = currentComposerExecutionProfile();
        if ((!content && attachmentPaths.length === 0) || !taskId) {
          return;
        }
        vscode.postMessage({
          type: "send-message",
          taskId,
          content,
          attachmentPaths,
          executionProfile: {
            ...(executionProfile.model ? { model: executionProfile.model } : {}),
            ...(executionProfile.effort ? { effort: executionProfile.effort } : {}),
            ...(executionProfile.planMode ? { planMode: true } : {}),
          },
        });
      }

      function selectedTaskPanel() {
        const task = state.selectedTask;
        if (!task) {
          return \`
            <section class="panel">
              <div class="eyebrow">Monitor</div>
              <h2>No task selected</h2>
              <p class="muted">\${escapeHtml(emptySelectionHint())}</p>
            </section>
          \`;
        }

        return \`
          <section class="panel">
            <div class="hero">
              <div>
                <div class="eyebrow">Conversation Monitor</div>
                <h2>\${escapeHtml(task.title)}</h2>
                <p class="muted">\${escapeHtml(task.taskId)} · \${escapeHtml(task.status)} · \${escapeHtml(task.mode)}</p>
              </div>
              <div class="hero-badges">\${renderBadges(task.badges)}</div>
            </div>
            <div class="metrics" style="margin-top: 12px;">
              <div class="metric"><strong>Workspace</strong><span>\${escapeHtml(task.workspaceRoot)}</span></div>
              <div class="metric"><strong>Thread</strong><span>\${escapeHtml(task.threadId)}</span></div>
              <div class="metric"><strong>Model</strong><span>\${escapeHtml(executionValue(task.executionProfile?.model, "runtime-default"))}</span></div>
              <div class="metric"><strong>Reasoning</strong><span>\${escapeHtml(executionValue(task.executionProfile?.effort, "model-default"))}</span></div>
              <div class="metric"><strong>Plan Mode</strong><span>\${escapeHtml(task.executionProfile?.planMode ? "on" : "off")}</span></div>
              <div class="metric"><strong>Sandbox</strong><span>\${escapeHtml(executionValue(task.executionProfile?.sandbox, "runtime-default"))}</span></div>
              <div class="metric"><strong>Approval</strong><span>\${escapeHtml(executionValue(task.executionProfile?.approvalPolicy, "runtime-default"))}</span></div>
              <div class="metric"><strong>Feishu Chat</strong><span>\${escapeHtml(task.feishuBinding?.chatId ?? "unbound")}</span></div>
              <div class="metric"><strong>Feishu Thread</strong><span>\${escapeHtml(task.feishuBinding?.threadKey ?? "unbound")}</span></div>
            </div>
            <div class="sync-row" style="margin-top: 12px;">
              <label class="toggle" title="When enabled, desktop-side agent replies keep posting back into the bound Feishu thread.">
                <input id="sync-toggle" type="checkbox" data-action="toggle-feishu-sync" \${task.desktopReplySyncToFeishu ? "checked" : ""} \${task.feishuBinding ? "" : "disabled"} />
                <span>Desktop replies continue syncing back to Feishu</span>
              </label>
              <div class="actions">
                <button data-action="open-status" title="Open the bridge status page for daemon health, account, and runtime limits.">View Status</button>
                <button class="danger" data-action="interrupt" title="Stop the task's active Codex turn as soon as the runtime accepts the interrupt.">Stop Turn</button>
                <button data-action="retry" title="Ask Codex to retry the last turn and keep working on the same task.">Retry Last Turn</button>
                <button \${task.feishuBinding ? "disabled" : ""} data-action="bind-new-feishu-topic" title="Create a new topic in the default Feishu group and bind this task to it for mobile follow-up.">Bind to New Feishu Topic</button>
                <button \${task.feishuBinding ? "" : "disabled"} data-action="unbind" title="Detach this task from its current Feishu thread without deleting local task data.">Unbind Feishu</button>
                <button \${task.canForgetLocalTask ? "" : "disabled"} data-action="forget-local-task" title="Remove this local task record from the monitor but keep the underlying Codex thread on disk.">Forget Local Copy</button>
                <button class="danger" \${task.canForgetLocalTask ? "" : "disabled"} data-action="delete-local-task" title="Permanently delete this local task and its underlying Codex thread from this computer.">Delete Local Copy</button>
              </div>
            </div>
            \${task.latestSummary ? \`<div class="panel" style="margin-top: 12px; padding: 12px;"><div class="eyebrow">Latest Summary</div>\${pre(task.latestSummary)}</div>\` : ""}
          </section>
          \${foldout("approvals", "Approvals", task.approvals.length, \`<div class="approvals">\${approvalsList()}</div>\`)}
          \${foldout("diffs", "Diffs", task.diffs.length, \`<div class="diffs">\${diffList()}</div>\`)}
          <section class="panel">
            <div class="eyebrow">Conversation</div>
            <div id="conversation-list" class="conversation">\${messageList()}</div>
            <div class="eyebrow" style="margin-top: 14px;">Desktop Composer</div>
            <div class="composer-shell">
              <div class="composer-toolbar">
                <span class="muted">Task-scoped draft with model, reasoning, plan mode, and local photo/file attachments. <code>Enter</code> sends, <code>Shift+Enter</code> inserts a newline, and <code>Ctrl/Cmd+Enter</code> also sends.</span>
                <div class="composer-actions">
                  <button data-action="pick-composer-attachments" title="Attach local photos or files from this computer to the next desktop-side message.">Add Photos / Files</button>
                  <button data-action="clear-composer" title="Clear the current draft text and attached files for this task." \${currentComposerDraft() || currentComposerAttachmentPaths().length ? "" : "disabled"}>Clear Draft</button>
                  <button class="primary" data-action="send-message" title="Send the current desktop message into this Codex task.">Send Message</button>
                </div>
              </div>
              <div class="actions" style="margin-bottom: 10px;">
                <label class="toggle" title="Choose which model the next turns on this task should use.">
                  <span class="muted">Model</span>
                  <select id="composer-model">\${modelSelectOptionsHtml()}</select>
                </label>
                <label class="toggle" title="Choose the reasoning effort for upcoming turns on this task.">
                  <span class="muted">Reasoning</span>
                  <select id="composer-effort">\${effortSelectOptionsHtml()}</select>
                </label>
                <label class="toggle" title="When enabled, ask Codex to run the next turn in plan mode before implementation.">
                  <input id="composer-plan-mode" type="checkbox" \${currentComposerExecutionProfile().planMode ? "checked" : ""} />
                  <span>Plan Mode</span>
                </label>
              </div>
              <div class="composer-attachments">\${composerAttachmentList()}</div>
              <textarea id="composer" placeholder="Type here to continue the selected task from VSCode. Shift+Enter for newline, Ctrl/Cmd+Enter to send.">\${escapeHtml(currentComposerDraft())}</textarea>
              <div class="composer-footer">
                <span class="muted">Desktop messages are tagged as <code>vscode</code>. User text is not mirrored into Feishu.</span>
                <span class="muted">\${escapeHtml(attachmentSummaryText())}</span>
              </div>
            </div>
          </section>
        \`;
      }

      function render() {
        captureConversationScroll();
        document.getElementById("app").innerHTML = \`
          <section class="panel">
            <div class="hero">
              <div>
                <div class="eyebrow">Feishu Task Monitor</div>
                <h1 style="margin:0;">Codex Feishu Monitor</h1>
                <p class="muted">Track Feishu-bound bridge tasks in a full editor tab, and optionally inspect imported local Codex threads when you need deeper host-side context.</p>
              </div>
              <div class="chips">
                <span class="chip">\${escapeHtml(state.connection)}</span>
                <span class="chip">\${escapeHtml(String(state.taskCount))} shown / \${escapeHtml(String(state.totalTaskCount))} total</span>
              </div>
            </div>
            <div class="metrics" style="margin-top: 12px;">
              <div class="metric"><strong>Account</strong><span>\${escapeHtml(accountSummary())}</span></div>
              <div class="metric"><strong>Rate limits</strong><span>\${escapeHtml(rateSummary())}</span></div>
              <div class="metric"><strong>Last synced</strong><span>\${escapeHtml(formatLastUpdatedAt())}</span></div>
            </div>
            <div class="actions" style="margin-top: 12px;">
              <label class="toggle" title="Choose how many recent host-side Codex threads to import into the monitor.">
                <span class="muted">Import count</span>
                <input id="import-limit" class="inline-input" type="number" min="1" max="50" value="\${escapeHtml(String(importRecentLimit))}" />
              </label>
              <button data-action="import-recent-threads" title="Import recent host-side Codex threads into the bridge monitor without deleting anything from ~/.codex.">Import Recent Host Threads</button>
              <button data-action="forget-imported-tasks" title="Clear imported local-only task records from the monitor while keeping the underlying host Codex threads on disk.">Clear Imported Local Tasks</button>
              <button data-action="refresh" title="Re-fetch the current daemon snapshot and any host-thread updates.">Refresh Tasks</button>
            </div>
            <div class="sync-row" style="margin-top: 12px;">
              <label class="toggle" title="Show unbound local tasks too, including imported CLI threads and desktop-started tasks that have not been bound to Feishu yet.">
                <input type="checkbox" data-action="toggle-local-imported-tasks" \${state.showLocalImportedTasks ? "checked" : ""} />
                <span>Show local imported tasks</span>
              </label>
              <span class="muted">\${state.showLocalImportedTasks ? "Displaying Feishu tasks and local imports." : "Displaying Feishu-bound tasks only."} Refresh re-reads daemon state and host thread changes.</span>
            </div>
          </section>
          <section class="panel">
            <div class="eyebrow">Tasks</div>
            \${taskSelectionToolbar()}
            <div class="task-list">\${taskRows()}</div>
          </section>
          \${selectedTaskPanel()}
        \`;

        const composer = document.getElementById("composer");
        if (composer instanceof HTMLTextAreaElement) {
          composer.addEventListener("input", (event) => {
            setCurrentComposerDraft(event.target.value);
            resizeComposer();
          });
          composer.addEventListener("keydown", (event) => {
            if (event.isComposing || event.key !== "Enter" || event.shiftKey) {
              return;
            }
            event.preventDefault();
            sendCurrentComposerMessage();
          });
        }

        const composerModel = document.getElementById("composer-model");
        if (composerModel instanceof HTMLSelectElement) {
          composerModel.addEventListener("change", (event) => {
            const selectedModel = event.target.value || "";
            const descriptor = (state.models ?? []).find((model) => model.id === selectedModel || model.model === selectedModel) ?? null;
            const nextProfile = {
              ...currentComposerExecutionProfile(),
              model: selectedModel,
            };
            if (descriptor && nextProfile.effort && !descriptor.supportedReasoningEfforts.includes(nextProfile.effort)) {
              nextProfile.effort = descriptor.defaultReasoningEffort;
            }
            if (!selectedModel) {
              nextProfile.effort = currentComposerExecutionProfile().effort ?? "";
            }
            setCurrentComposerExecutionProfile(nextProfile);
            render();
            vscode.postMessage({
              type: "update-execution-profile",
              taskId: currentTaskId(),
              executionProfile: {
                ...(nextProfile.model ? { model: nextProfile.model } : {}),
                ...(nextProfile.effort ? { effort: nextProfile.effort } : {}),
                ...(nextProfile.planMode ? { planMode: true } : {}),
              },
            });
          });
        }

        const composerEffort = document.getElementById("composer-effort");
        if (composerEffort instanceof HTMLSelectElement) {
          composerEffort.addEventListener("change", (event) => {
            const nextProfile = {
              ...currentComposerExecutionProfile(),
              effort: event.target.value || "",
            };
            setCurrentComposerExecutionProfile(nextProfile);
            vscode.postMessage({
              type: "update-execution-profile",
              taskId: currentTaskId(),
              executionProfile: {
                ...(nextProfile.model ? { model: nextProfile.model } : {}),
                ...(nextProfile.effort ? { effort: nextProfile.effort } : {}),
                ...(nextProfile.planMode ? { planMode: true } : {}),
              },
            });
          });
        }

        const composerPlanMode = document.getElementById("composer-plan-mode");
        if (composerPlanMode instanceof HTMLInputElement) {
          composerPlanMode.addEventListener("change", (event) => {
            const nextProfile = {
              ...currentComposerExecutionProfile(),
              planMode: Boolean(event.target.checked),
            };
            setCurrentComposerExecutionProfile(nextProfile);
            vscode.postMessage({
              type: "update-execution-profile",
              taskId: currentTaskId(),
              executionProfile: {
                ...(nextProfile.model ? { model: nextProfile.model } : {}),
                ...(nextProfile.effort ? { effort: nextProfile.effort } : {}),
                ...(nextProfile.planMode ? { planMode: true } : {}),
              },
            });
          });
        }

        const importLimitInput = document.getElementById("import-limit");
        if (importLimitInput instanceof HTMLInputElement) {
          importLimitInput.addEventListener("input", (event) => {
            importRecentLimit = Math.max(1, Math.min(50, Math.trunc(Number(event.target.value) || importRecentLimit)));
          });
        }

        const conversation = document.getElementById("conversation-list");
        if (conversation instanceof HTMLElement) {
          conversation.addEventListener("scroll", () => {
            captureConversationScroll();
          });
        }

        document.querySelectorAll("details[data-section]").forEach((details) => {
          if (!(details instanceof HTMLDetailsElement)) {
            return;
          }
          details.addEventListener("toggle", () => {
            const section = details.dataset.section;
            if (!section) {
              return;
            }
            sectionState[section] = details.open;
          });
        });

        resizeComposer();
        restoreConversationScroll();
      }

      window.addEventListener("message", (event) => {
        if (event.data?.type === "composer-attachments-selected") {
          const taskId = event.data.taskId;
          if (!taskId || !Array.isArray(event.data.attachmentPaths)) {
            return;
          }
          const existing = composerAttachmentPaths[taskId] ?? [];
          setComposerAttachmentPaths(taskId, [...existing, ...event.data.attachmentPaths]);
          render();
          return;
        }

        if (event.data?.type === "composer-cleared") {
          clearComposerState(event.data.taskId);
          render();
          return;
        }

        if (event.data?.type !== "state") {
          return;
        }
        state = event.data.state;
        if (state.selectedTask?.taskId && !composerExecutionProfiles[state.selectedTask.taskId]) {
          composerExecutionProfiles[state.selectedTask.taskId] = defaultComposerExecutionProfile();
        }
        trimSelectedLocalTasks();
        render();
        if (event.data.focusComposer) {
          const composer = document.getElementById("composer");
          if (composer) {
            composer.focus();
          }
        }
      });

      document.addEventListener("click", (event) => {
        const target = event.target.closest("[data-action]");
        if (!target) {
          return;
        }

        const action = target.dataset.action;
        const taskId = target.dataset.taskId || state.selectedTaskId;

        switch (action) {
          case "select-task":
            vscode.postMessage({ type: "select-task", taskId: target.dataset.taskId });
            return;
          case "toggle-multi-select":
            multiSelectMode = !multiSelectMode;
            if (!multiSelectMode) {
              selectedLocalTaskIds = {};
            }
            render();
            return;
          case "select-visible-local-tasks":
            state.tasks.forEach((task) => {
              if (!task.isFeishuBound) {
                selectedLocalTaskIds[task.taskId] = true;
              }
            });
            render();
            return;
          case "clear-local-task-selection":
            selectedLocalTaskIds = {};
            render();
            return;
          case "import-recent-threads": {
            const importLimitInput = document.getElementById("import-limit");
            const limit = importLimitInput instanceof HTMLInputElement ? Number(importLimitInput.value) : importRecentLimit;
            importRecentLimit = Math.max(1, Math.min(50, Math.trunc(limit || importRecentLimit)));
            vscode.postMessage({ type: "import-recent-threads", limit: importRecentLimit });
            return;
          }
          case "refresh":
            vscode.postMessage({ type: "refresh" });
            return;
          case "forget-imported-tasks":
            vscode.postMessage({ type: "forget-imported-tasks" });
            return;
          case "open-status":
            vscode.postMessage({ type: "open-status" });
            return;
          case "pick-composer-attachments":
            if (!taskId) {
              return;
            }
            vscode.postMessage({ type: "pick-composer-attachments", taskId });
            return;
          case "clear-composer":
            if (!taskId) {
              return;
            }
            clearComposerState(taskId);
            render();
            return;
          case "send-message": {
            sendCurrentComposerMessage();
            return;
          }
          case "interrupt":
          case "retry":
          case "bind-new-feishu-topic":
          case "unbind":
            if (!taskId) {
              return;
            }
            vscode.postMessage({ type: action, taskId });
            return;
          case "forget-local-task":
            if (!taskId) {
              return;
            }
            vscode.postMessage({ type: "forget-local-task", taskId });
            return;
          case "forget-local-tasks": {
            const taskIds = selectedVisibleLocalTaskIds();
            if (!taskIds.length) {
              return;
            }
            vscode.postMessage({ type: "forget-local-tasks", taskIds });
            return;
          }
          case "delete-local-task":
            if (!taskId) {
              return;
            }
            vscode.postMessage({ type: "delete-local-task", taskId });
            return;
          case "delete-local-tasks": {
            const taskIds = selectedVisibleLocalTaskIds();
            if (!taskIds.length) {
              return;
            }
            vscode.postMessage({ type: "delete-local-tasks", taskIds });
            return;
          }
          case "resolve-approval":
            if (!taskId || !target.dataset.requestId || !target.dataset.decision) {
              return;
            }
            vscode.postMessage({
              type: "resolve-approval",
              taskId,
              requestId: target.dataset.requestId,
              decision: target.dataset.decision,
            });
            return;
          case "open-diff":
            if (!taskId || !target.dataset.diffPath) {
              return;
            }
            vscode.postMessage({
              type: "open-diff",
              taskId,
              diffPath: target.dataset.diffPath,
            });
            return;
          default:
            return;
        }
      });

      document.addEventListener("change", (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.dataset.action === "toggle-feishu-sync" && state.selectedTaskId) {
          vscode.postMessage({
            type: "toggle-feishu-sync",
            taskId: state.selectedTaskId,
            enabled: target.checked,
          });
          return;
        }
        if (target instanceof HTMLInputElement && target.dataset.action === "toggle-local-imported-tasks") {
          vscode.postMessage({
            type: "toggle-local-imported-tasks",
            enabled: target.checked,
          });
          return;
        }
        if (target instanceof HTMLInputElement && target.dataset.action === "toggle-local-task-selection" && target.dataset.taskId) {
          if (target.checked) {
            selectedLocalTaskIds[target.dataset.taskId] = true;
          } else {
            delete selectedLocalTaskIds[target.dataset.taskId];
          }
          render();
        }
      });

      vscode.postMessage({ type: "ready" });
    </script>
  </body>
</html>`;
  }
}
