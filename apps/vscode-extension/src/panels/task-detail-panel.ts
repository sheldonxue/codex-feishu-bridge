import * as vscode from "vscode";

import type { BridgeTask } from "@codex-feishu-bridge/protocol";

import { diffSummaryText } from "../core/diff-summary";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderTask(task: BridgeTask): string {
  const approvals = task.pendingApprovals
    .map(
      (approval) =>
        `<li><strong>${escapeHtml(approval.kind)}</strong> - ${escapeHtml(approval.reason)} (<code>${escapeHtml(approval.state)}</code>)</li>`,
    )
    .join("");
  const diffs = task.diffs
    .map(
      (diff) =>
        `<details><summary>${escapeHtml(diff.path)} - ${escapeHtml(diffSummaryText(diff.summary))}</summary><pre>${escapeHtml(diff.patch ?? "")}</pre></details>`,
    )
    .join("");
  const conversation = task.conversation
    .map(
      (message) =>
        `<article class="message"><header>${escapeHtml(message.author)} / ${escapeHtml(message.surface)} - ${escapeHtml(
          new Date(message.createdAt).toLocaleString(),
        )}</header><pre>${escapeHtml(message.content)}</pre></article>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f4efe3;
      --fg: #12202f;
      --card: #fffdf7;
      --border: #d2c7b2;
      --accent: #0f6d62;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111723;
        --fg: #ecf3ff;
        --card: #1a2230;
        --border: #2e3b53;
        --accent: #7ed7c8;
      }
    }
    body {
      font-family: "IBM Plex Sans", sans-serif;
      margin: 0;
      padding: 24px;
      background: radial-gradient(circle at top left, rgba(15,109,98,0.16), transparent 32%), var(--bg);
      color: var(--fg);
    }
    section {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px 18px;
      margin-bottom: 16px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.05);
    }
    h1, h2 { margin: 0 0 12px; }
    h1 { font-size: 24px; }
    h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent); }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .meta div { padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); }
    pre { white-space: pre-wrap; word-break: break-word; }
    .message { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; }
  </style>
</head>
<body>
  <section>
    <h1>${escapeHtml(task.title)}</h1>
    <div class="meta">
      <div><strong>Status</strong><br />${escapeHtml(task.status)}</div>
      <div><strong>Mode</strong><br />${escapeHtml(task.mode)}</div>
      <div><strong>Workspace</strong><br /><code>${escapeHtml(task.workspaceRoot)}</code></div>
      <div><strong>Images</strong><br />${task.imageAssets.length}</div>
      <div><strong>Desktop Reply Sync</strong><br />${task.desktopReplySyncToFeishu}</div>
    </div>
  </section>
  <section>
    <h2>Approvals</h2>
    <ul>${approvals || "<li>No approvals for this task.</li>"}</ul>
  </section>
  <section>
    <h2>Diffs</h2>
    ${diffs || "<p>No diff data available.</p>"}
  </section>
  <section>
    <h2>Conversation</h2>
    ${conversation || "<p>No conversation history yet.</p>"}
  </section>
</body>
</html>`;
}

export function openTaskDetailPanel(task: BridgeTask): void {
  const panel = vscode.window.createWebviewPanel(
    "codexFeishuBridge.taskDetails",
    `Task: ${task.title}`,
    vscode.ViewColumn.Beside,
    {
      enableFindWidget: true,
    },
  );
  panel.webview.html = renderTask(task);
}

export function openStatusPanel(snapshot: {
  account: unknown;
  rateLimits: unknown;
  connection: string;
  taskCount: number;
}): void {
  const panel = vscode.window.createWebviewPanel(
    "codexFeishuBridge.status",
    "Codex Bridge Status",
    vscode.ViewColumn.Beside,
    {},
  );
  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<body style="font-family: IBM Plex Sans, sans-serif; padding: 24px;">
  <h1>Codex Bridge Status</h1>
  <p><strong>Connection:</strong> ${escapeHtml(snapshot.connection)}</p>
  <p><strong>Tracked tasks:</strong> ${snapshot.taskCount}</p>
  <h2>Account</h2>
  <pre>${escapeHtml(JSON.stringify(snapshot.account, null, 2))}</pre>
  <h2>Rate limits</h2>
  <pre>${escapeHtml(JSON.stringify(snapshot.rateLimits, null, 2))}</pre>
</body>
</html>`;
}
