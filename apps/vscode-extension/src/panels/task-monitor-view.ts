import * as vscode from "vscode";

import type { BridgeTask, QueuedApproval } from "@codex-feishu-bridge/protocol";

import { BridgeClient } from "../core/bridge-client";
import { buildMonitorState, type MonitorViewState } from "../core/monitor-model";
import { TaskStore } from "../core/task-store";

interface TaskMonitorViewProviderOptions {
  context: vscode.ExtensionContext;
  client: BridgeClient;
  store: TaskStore;
  openStatus: () => Promise<void>;
  openDiff: (task: BridgeTask, diffPath?: string) => Promise<void>;
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

  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | null = null;
  private selectedTaskId: string | undefined;
  private focusComposerOnNextState = false;

  constructor(private readonly options: TaskMonitorViewProviderOptions) {
    this.selectedTaskId = this.options.context.workspaceState.get<string>(TaskMonitorViewProvider.selectedTaskStorageKey);
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
      diffPath?: string;
      requestId?: string;
      decision?: "accept" | "decline" | "cancel";
      enabled?: boolean;
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
          return;
        case "open-status":
          await this.options.openStatus();
          return;
        case "send-message": {
          const task = this.getTask(payload.taskId);
          const content = payload.content?.trim();
          if (!task || !content) {
            return;
          }
          await this.options.client.sendMessage(task.taskId, {
            content,
            source: "vscode",
            replyToFeishu: task.feishuBinding ? task.desktopReplySyncToFeishu : false,
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
          await this.options.client.sendMessage(task.taskId, {
            content: "Retry the last turn and continue.",
            source: "vscode",
            replyToFeishu: task.feishuBinding ? task.desktopReplySyncToFeishu : false,
          });
          await this.options.store.refresh();
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

  private async postState(): Promise<void> {
    if (!this.view) {
      return;
    }
    const state = buildMonitorState(this.options.store.getSnapshot(), this.selectedTaskId);
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
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 10px 12px;
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
      .conversation {
        display: grid;
        gap: 10px;
        max-height: 36vh;
        overflow: auto;
        padding-right: 4px;
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
        min-height: 88px;
        resize: vertical;
        border-radius: 14px;
        border: 1px solid var(--border);
        padding: 12px;
        background: rgba(255,255,255,0.02);
        color: inherit;
        box-sizing: border-box;
      }
      .composer-footer, .sync-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .toggle {
        display: inline-flex;
        align-items: center;
        gap: 8px;
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
        tasks: [],
        selectedTask: null,
        selectedTaskId: undefined,
        account: null,
        rateLimits: null,
      };
      let composerDraft = "";

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

      function taskRows() {
        if (!state.tasks.length) {
          return '<div class="empty">No bridge tasks are available yet.</div>';
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

      function accountSummary() {
        const account = state.account?.account;
        if (!account) {
          return "No account loaded";
        }
        return [account.type, account.email, account.planType].filter(Boolean).join(" · ");
      }

      function rateSummary() {
        const rate = state.rateLimits?.rateLimits;
        if (!rate) {
          return "Unavailable";
        }
        const lines = [];
        if (rate.primary) {
          lines.push(\`Primary \${rate.primary.usedPercent}%\`);
        }
        if (rate.secondary) {
          lines.push(\`Secondary \${rate.secondary.usedPercent}%\`);
        }
        return lines.join(" · ") || "Available";
      }

      function selectedTaskPanel() {
        const task = state.selectedTask;
        if (!task) {
          return \`
            <section class="panel">
              <div class="eyebrow">Monitor</div>
              <h2>No task selected</h2>
              <p class="muted">Pick a task from the tree or the list above. Feishu-bound tasks are highlighted so you can monitor mobile conversations without leaving VSCode.</p>
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
                <button data-action="refresh">Refresh</button>
                <button data-action="open-status">Status</button>
                <button class="danger" data-action="interrupt">Interrupt</button>
                <button data-action="retry">Retry</button>
                <button \${task.feishuBinding ? "" : "disabled"} data-action="unbind">Unbind</button>
              </div>
            </div>
            \${task.latestSummary ? \`<div class="panel" style="margin-top: 12px; padding: 12px;"><div class="eyebrow">Latest Summary</div>\${pre(task.latestSummary)}</div>\` : ""}
          </section>
          <section class="panel">
            <div class="eyebrow">Conversation</div>
            <div class="conversation">\${messageList()}</div>
          </section>
          <section class="panel">
            <div class="eyebrow">Approvals</div>
            <div class="approvals">\${approvalsList()}</div>
          </section>
          <section class="panel">
            <div class="eyebrow">Diffs</div>
            <div class="diffs">\${diffList()}</div>
          </section>
          <section class="panel">
            <div class="eyebrow">Desktop Composer</div>
            <textarea id="composer" placeholder="Type here to continue the selected task from VSCode without using a popup input box...">\${escapeHtml(composerDraft)}</textarea>
            <div class="composer-footer" style="margin-top: 12px;">
              <span class="muted">Desktop messages are tagged as <code>vscode</code>. User text is not mirrored into Feishu.</span>
              <div class="actions">
                <button class="primary" data-action="send-message">Send</button>
              </div>
            </div>
          </section>
        \`;
      }

      function render() {
        document.getElementById("app").innerHTML = \`
          <section class="panel">
            <div class="hero">
              <div>
                <div class="eyebrow">Feishu Task Monitor</div>
                <h1 style="margin:0;">Codex Feishu Monitor</h1>
                <p class="muted">Track all bridge tasks, with Feishu-bound conversations highlighted for quick desktop supervision.</p>
              </div>
              <div class="chips">
                <span class="chip">\${escapeHtml(state.connection)}</span>
                <span class="chip">\${escapeHtml(String(state.taskCount))} tasks</span>
              </div>
            </div>
            <div class="metrics" style="margin-top: 12px;">
              <div class="metric"><strong>Account</strong><span>\${escapeHtml(accountSummary())}</span></div>
              <div class="metric"><strong>Rate limits</strong><span>\${escapeHtml(rateSummary())}</span></div>
            </div>
          </section>
          <section class="panel">
            <div class="eyebrow">Tasks</div>
            <div class="task-list">\${taskRows()}</div>
          </section>
          \${selectedTaskPanel()}
        \`;

        const composer = document.getElementById("composer");
        if (composer) {
          composer.addEventListener("input", (event) => {
            composerDraft = event.target.value;
          });
        }
      }

      window.addEventListener("message", (event) => {
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
          case "refresh":
            vscode.postMessage({ type: "refresh" });
            return;
          case "open-status":
            vscode.postMessage({ type: "open-status" });
            return;
          case "send-message": {
            const composer = document.getElementById("composer");
            const content = composer?.value?.trim();
            if (!content || !taskId) {
              return;
            }
            composerDraft = "";
            vscode.postMessage({ type: "send-message", taskId, content });
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
        }
      });

      vscode.postMessage({ type: "ready" });
    </script>
  </body>
</html>`;
  }
}
