import * as vscode from "vscode";

import type { BridgeTask, MessageSurface, QueuedApproval } from "@codex-feishu-bridge/protocol";

import { BridgeClient } from "../core/bridge-client";
import { buildMonitorState, type MonitorViewState } from "../core/monitor-model";
import { TaskStore } from "../core/task-store";

interface TaskMonitorViewProviderOptions {
  context: vscode.ExtensionContext;
  client: BridgeClient;
  store: TaskStore;
  sendMessage: (
    taskId: string,
    payload: {
      content: string;
      imagePaths?: string[];
      source?: MessageSurface;
      replyToFeishu?: boolean;
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

export class TaskMonitorViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "codexFeishuBridge.monitor";
  private static readonly selectedTaskStorageKey = "codexFeishuBridge.monitor.selectedTaskId";
  private static readonly showLocalImportedTasksStorageKey = "codexFeishuBridge.monitor.showLocalImportedTasks";

  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | null = null;
  private selectedTaskId: string | undefined;
  private showLocalImportedTasks: boolean;
  private focusComposerOnNextState = false;

  constructor(private readonly options: TaskMonitorViewProviderOptions) {
    this.selectedTaskId = this.options.context.workspaceState.get<string>(TaskMonitorViewProvider.selectedTaskStorageKey);
    this.showLocalImportedTasks =
      this.options.context.workspaceState.get<boolean>(TaskMonitorViewProvider.showLocalImportedTasksStorageKey) ?? false;
    this.disposables.push({
      dispose: this.options.store.onDidChange(() => {
        void this.postState();
      }),
    });
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
    };
    view.webview.html = this.renderHtml(view.webview);
    this.disposables.push(
      view.webview.onDidReceiveMessage((message) => {
        void this.handleMessage(message);
      }),
      view.onDidDispose(() => {
        this.view = null;
      }),
    );
    await this.postState();
  }

  async focusTask(taskOrId?: BridgeTask | string, focusComposer = false): Promise<void> {
    const taskId = typeof taskOrId === "string" ? taskOrId : taskOrId?.taskId;
    await this.setSelectedTask(taskId);
    if (focusComposer) {
      this.focusComposerOnNextState = true;
    }
    await vscode.commands.executeCommand("workbench.view.explorer");
    try {
      await vscode.commands.executeCommand(`${TaskMonitorViewProvider.viewType}.focus`);
    } catch {
      // Ignore focus-command support differences across VSCode versions.
    }
    this.view?.show?.(true);
    await this.postState();
  }

  dispose(): void {
    this.view = null;
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
      imagePaths?: string[];
      diffPath?: string;
      requestId?: string;
      decision?: "accept" | "decline" | "cancel";
      enabled?: boolean;
      limit?: number;
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
            TaskMonitorViewProvider.showLocalImportedTasksStorageKey,
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
          if (!task || (!content && !(payload.imagePaths?.length))) {
            return;
          }
          await this.options.sendMessage(task.taskId, {
            content: content ?? "",
            imagePaths: payload.imagePaths ?? [],
            source: "vscode",
            replyToFeishu: task.feishuBinding ? task.desktopReplySyncToFeishu : false,
          });
          await this.postWebviewMessage({
            type: "composer-cleared",
            taskId: task.taskId,
          });
          return;
        }
        case "pick-composer-images": {
          const task = this.getTask(payload.taskId);
          if (!task) {
            return;
          }
          const files = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: "Attach images",
            filters: {
              Images: ["png", "jpg", "jpeg", "gif", "webp"],
            },
          });
          if (!files?.length) {
            return;
          }
          await this.postWebviewMessage({
            type: "composer-images-selected",
            taskId: task.taskId,
            imagePaths: files.map((file) => file.fsPath),
          });
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

  private async setSelectedTask(taskId?: string): Promise<void> {
    this.selectedTaskId = taskId;
    await this.options.context.workspaceState.update(TaskMonitorViewProvider.selectedTaskStorageKey, taskId);
  }

  private async postWebviewMessage(message: Record<string, unknown>): Promise<void> {
    if (!this.view) {
      return;
    }
    await this.view.webview.postMessage(message);
  }

  private async postState(): Promise<void> {
    if (!this.view) {
      return;
    }
    const state = buildMonitorState(this.options.store.getSnapshot(), this.selectedTaskId, {
      showLocalImportedTasks: this.showLocalImportedTasks,
    });
    if (state.selectedTaskId !== this.selectedTaskId) {
      this.selectedTaskId = state.selectedTaskId;
      await this.options.context.workspaceState.update(TaskMonitorViewProvider.selectedTaskStorageKey, this.selectedTaskId);
    }
    await this.view.webview.postMessage({
      type: "state",
      state,
      focusComposer: this.focusComposerOnNextState,
    });
    this.focusComposerOnNextState = false;
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
      .task-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 10px;
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 10px 12px;
        width: 100%;
        text-align: left;
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
      };
      let composerDrafts = {};
      let composerImagePaths = {};
      let importRecentLimit = 8;
      let sectionState = {
        approvals: false,
        diffs: false,
      };
      let conversationScrollByTask = {};

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

      function currentComposerImagePaths() {
        const taskId = currentTaskId();
        return taskId ? (composerImagePaths[taskId] ?? []) : [];
      }

      function setComposerImagePaths(taskId, imagePaths) {
        if (!taskId) {
          return;
        }
        composerImagePaths[taskId] = [...new Set(imagePaths)];
      }

      function clearComposerState(taskId) {
        if (!taskId) {
          return;
        }
        composerDrafts[taskId] = "";
        composerImagePaths[taskId] = [];
      }

      function fileNameFromPath(targetPath) {
        const segments = String(targetPath ?? "").split(/[\\\\/]/);
        return segments[segments.length - 1] || targetPath;
      }

      function formatLastUpdatedAt() {
        if (!state.lastUpdatedAt) {
          return "Waiting for first sync";
        }
        return new Date(state.lastUpdatedAt).toLocaleString();
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
          .map((task) => \`
            <button class="task-row \${task.isSelected ? "selected" : ""}" data-action="select-task" data-task-id="\${escapeHtml(task.taskId)}">
              <div class="meta">
                <strong>\${escapeHtml(task.title)}</strong>
                <span class="muted">\${escapeHtml(task.description)}</span>
              </div>
              \${task.isFeishuBound ? '<span class="badge feishu">Feishu</span>' : ""}
            </button>
          \`)
          .join("");
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
                    <button class="primary" data-action="resolve-approval" data-decision="accept" data-request-id="\${escapeHtml(approval.requestId)}">Approve</button>
                    <button data-action="resolve-approval" data-decision="decline" data-request-id="\${escapeHtml(approval.requestId)}">Decline</button>
                    <button class="danger" data-action="resolve-approval" data-decision="cancel" data-request-id="\${escapeHtml(approval.requestId)}">Cancel</button>
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
                <button data-action="open-diff" data-diff-path="\${escapeHtml(diff.path)}">Open diff</button>
              </div>
            </article>
          \`)
          .join("");
      }

      function foldout(section, title, count, content) {
        return \`
          <details class="panel foldout" data-section="\${escapeHtml(section)}" \${sectionState[section] ? "open" : ""}>
            <summary>
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

      function composerAttachmentList() {
        const imagePaths = currentComposerImagePaths();
        if (!imagePaths.length) {
          return '<span class="muted">No local images attached.</span>';
        }

        return imagePaths
          .map((imagePath) => \`<span class="composer-chip">\${escapeHtml(fileNameFromPath(imagePath))}</span>\`)
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

      function emptySelectionHint() {
        if (!state.showLocalImportedTasks && state.hiddenTaskCount > 0) {
          return "Only Feishu-bound tasks are currently shown. Turn on Show local imported tasks if you want to inspect imported host threads.";
        }
        return "Pick a task from the tree or the list above. Feishu-bound tasks are highlighted so you can monitor mobile conversations without leaving VSCode.";
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
              \${task.feishuBinding ? '<span class="badge feishu">Feishu Bound</span>' : '<span class="badge runtime">Local Only</span>'}
            </div>
            <div class="metrics" style="margin-top: 12px;">
              <div class="metric"><strong>Workspace</strong><span>\${escapeHtml(task.workspaceRoot)}</span></div>
              <div class="metric"><strong>Thread</strong><span>\${escapeHtml(task.threadId)}</span></div>
              <div class="metric"><strong>Feishu Chat</strong><span>\${escapeHtml(task.feishuBinding?.chatId ?? "unbound")}</span></div>
              <div class="metric"><strong>Feishu Thread</strong><span>\${escapeHtml(task.feishuBinding?.threadKey ?? "unbound")}</span></div>
            </div>
            <div class="sync-row" style="margin-top: 12px;">
              <label class="toggle">
                <input id="sync-toggle" type="checkbox" data-action="toggle-feishu-sync" \${task.desktopReplySyncToFeishu ? "checked" : ""} \${task.feishuBinding ? "" : "disabled"} />
                <span>Desktop replies continue syncing back to Feishu</span>
              </label>
              <div class="actions">
                <button data-action="open-status">Status</button>
                <button class="danger" data-action="interrupt">Interrupt</button>
                <button data-action="retry">Retry</button>
                <button \${task.feishuBinding ? "" : "disabled"} data-action="unbind">Unbind</button>
                <button \${task.canForgetLocalTask ? "" : "disabled"} data-action="forget-local-task">Forget Local</button>
                <button class="danger" \${task.canForgetLocalTask ? "" : "disabled"} data-action="delete-local-task">Delete Local</button>
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
                <span class="muted">Task-scoped draft, local image attachments, and <code>Ctrl/Cmd+Enter</code> to send.</span>
                <div class="composer-actions">
                  <button data-action="pick-composer-images">Attach Images</button>
                  <button data-action="clear-composer" \${currentComposerDraft() || currentComposerImagePaths().length ? "" : "disabled"}>Clear</button>
                  <button class="primary" data-action="send-message">Send</button>
                </div>
              </div>
              <div class="composer-attachments">\${composerAttachmentList()}</div>
              <textarea id="composer" placeholder="Type here to continue the selected task from VSCode. Shift+Enter for newline, Ctrl/Cmd+Enter to send.">\${escapeHtml(currentComposerDraft())}</textarea>
              <div class="composer-footer">
                <span class="muted">Desktop messages are tagged as <code>vscode</code>. User text is not mirrored into Feishu.</span>
                <span class="muted">\${currentComposerImagePaths().length ? escapeHtml(String(currentComposerImagePaths().length)) + " image(s) attached" : "No attachments selected."}</span>
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
                <p class="muted">Track Feishu-bound bridge tasks by default, and optionally inspect imported local Codex threads when you need deeper host-side context.</p>
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
              <label class="toggle">
                <span class="muted">Import count</span>
                <input id="import-limit" class="inline-input" type="number" min="1" max="50" value="\${escapeHtml(String(importRecentLimit))}" />
              </label>
              <button data-action="import-recent-threads">Import Recent Host Threads</button>
              <button data-action="forget-imported-tasks">Clear Imported Local Tasks</button>
              <button data-action="refresh">Refresh Tasks</button>
            </div>
            <div class="sync-row" style="margin-top: 12px;">
              <label class="toggle">
                <input type="checkbox" data-action="toggle-local-imported-tasks" \${state.showLocalImportedTasks ? "checked" : ""} />
                <span>Show local imported tasks</span>
              </label>
              <span class="muted">\${state.showLocalImportedTasks ? "Displaying Feishu tasks and local imports." : "Displaying Feishu-bound tasks only."} Refresh re-reads daemon state and host thread changes.</span>
            </div>
          </section>
          <section class="panel">
            <div class="eyebrow">Tasks</div>
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
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              const sendButton = document.querySelector('[data-action="send-message"]');
              if (sendButton instanceof HTMLElement) {
                sendButton.click();
              }
            }
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
        if (event.data?.type === "composer-images-selected") {
          const taskId = event.data.taskId;
          if (!taskId || !Array.isArray(event.data.imagePaths)) {
            return;
          }
          const existing = composerImagePaths[taskId] ?? [];
          setComposerImagePaths(taskId, [...existing, ...event.data.imagePaths]);
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
          case "pick-composer-images":
            if (!taskId) {
              return;
            }
            vscode.postMessage({ type: "pick-composer-images", taskId });
            return;
          case "clear-composer":
            if (!taskId) {
              return;
            }
            clearComposerState(taskId);
            render();
            return;
          case "send-message": {
            const composer = document.getElementById("composer");
            const content = composer instanceof HTMLTextAreaElement ? composer.value.trim() : "";
            const imagePaths = taskId ? currentComposerImagePaths() : [];
            if ((!content && imagePaths.length === 0) || !taskId) {
              return;
            }
            vscode.postMessage({ type: "send-message", taskId, content, imagePaths });
            return;
          }
          case "interrupt":
          case "retry":
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
          case "delete-local-task":
            if (!taskId) {
              return;
            }
            vscode.postMessage({ type: "delete-local-task", taskId });
            return;
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
        }
      });

      vscode.postMessage({ type: "ready" });
    </script>
  </body>
</html>`;
  }
}
