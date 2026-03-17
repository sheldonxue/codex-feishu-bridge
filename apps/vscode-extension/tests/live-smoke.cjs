const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const vscode = require("vscode");

const baseUrl = process.env.CFB_BASE_URL ?? "http://127.0.0.1:8787";
const pollIntervalMs = Number(process.env.CFB_POLL_INTERVAL_MS ?? "1500");
const connectionTimeoutMs = Number(process.env.CFB_CONNECTION_TIMEOUT_MS ?? "45000");
const taskTimeoutMs = Number(process.env.CFB_TASK_TIMEOUT_MS ?? "180000");
const approvalTimeoutMs = Number(process.env.CFB_APPROVAL_TIMEOUT_MS ?? "90000");
const requireApproval = process.env.CFB_ALLOW_MISSING_APPROVAL !== "1";
const wsPath = process.env.CFB_WS_PATH ?? "/ws";

const promptText = [
  "Please edit `greeting.txt` so it contains exactly `hello bridge`.",
  "If the file change requires approval, request it instead of skipping it.",
  "Stop once the diff is ready for review.",
].join(" ");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(label, callback, timeoutMs) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const result = await callback();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(pollIntervalMs);
  }

  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${label}.${suffix}`);
}

async function requestJson(targetPath, init) {
  const response = await fetch(new URL(targetPath, baseUrl), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${targetPath}: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

function extensionPathUnderTest() {
  return path.resolve(__dirname, "..");
}

function findExtension() {
  const targetPath = extensionPathUnderTest();
  return vscode.extensions.all.find((extension) => path.resolve(extension.extensionPath) === targetPath);
}

async function activateExtension() {
  const extension = await waitFor("extension registration", () => findExtension() ?? false, 30000);
  await extension.activate();
  return extension;
}

async function execDev(command, argument) {
  return vscode.commands.executeCommand(command, argument);
}

async function currentSnapshot() {
  return execDev("codexFeishuBridge.dev.getSnapshot");
}

async function taskFromSnapshot(taskId) {
  const snapshot = await currentSnapshot();
  return snapshot.tasks.find((task) => task.taskId === taskId) ?? null;
}

function tabLabels() {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
}

async function createSmokeWorkspace() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-live-smoke-"));
  await fs.writeFile(path.join(workspaceRoot, "greeting.txt"), "hello world\n", "utf8");
  await fs.writeFile(
    path.join(workspaceRoot, "pixel.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6l0AAAAASUVORK5CYII=", "base64"),
  );
  return workspaceRoot;
}

async function run() {
  const health = await requestJson("/health");
  assert.equal(health.runtime.backend, "stdio", "Live smoke requires the stdio daemon backend.");

  await vscode.workspace.getConfiguration("codexFeishuBridge").update("baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration("codexFeishuBridge").update("wsPath", wsPath, vscode.ConfigurationTarget.Global);
  await activateExtension();
  await vscode.commands.executeCommand("workbench.view.explorer");

  const connectedSnapshot = await waitFor(
    "extension store connection",
    async () => {
      const snapshot = await currentSnapshot();
      return snapshot.connection === "connected" ? snapshot : false;
    },
    connectionTimeoutMs,
  );
  assert.equal(connectedSnapshot.connection, "connected");

  await execDev("codexFeishuBridge.dev.openStatus");
  await waitFor(
    "status panel tab",
    async () => (tabLabels().includes("Codex Bridge Status") ? true : false),
    15000,
  );

  const workspaceRoot = await createSmokeWorkspace();
  const title = `Live UI Smoke ${Date.now()}`;
  const task = await execDev("codexFeishuBridge.dev.createTask", {
    title,
    workspaceRoot,
  });
  assert.equal(task.title, title);
  assert.equal(task.workspaceRoot, workspaceRoot);

  const treeItems = await waitFor(
    "task tree entry",
    async () => {
      const items = await execDev("codexFeishuBridge.dev.getTaskTree");
      return items.some((item) => item.taskId === task.taskId) ? items : false;
    },
    15000,
  );
  assert(treeItems.some((item) => item.taskId === task.taskId), "Task tree did not contain the live task.");

  await execDev("codexFeishuBridge.dev.openTaskDetails", task.taskId);
  await waitFor(
    "task detail tab",
    async () => (tabLabels().includes(`Task: ${title}`) ? true : false),
    15000,
  );

  await execDev("codexFeishuBridge.dev.sendMessage", {
    taskId: task.taskId,
    content: promptText,
    imagePaths: [path.join(workspaceRoot, "pixel.png")],
  });

  const uploadedTask = await waitFor(
    "uploaded image to appear in task state",
    async () => {
      const currentTask = await taskFromSnapshot(task.taskId);
      return currentTask && currentTask.imageAssets.length > 0 ? currentTask : false;
    },
    30000,
  );
  assert(uploadedTask.conversation.length > 0, "Task conversation did not update after sending the live prompt.");

  const treeAfterSend = await waitFor(
    "task tree refresh after send",
    async () => {
      const items = await execDev("codexFeishuBridge.dev.getTaskTree");
      const currentItem = items.find((item) => item.taskId === task.taskId);
      return currentItem && currentItem.status !== "idle" ? currentItem : false;
    },
    30000,
  );

  const readyTask = await waitFor(
    "task diff output or approval",
    async () => {
      const currentTask = await taskFromSnapshot(task.taskId);
      if (!currentTask) {
        return false;
      }

      if (currentTask.pendingApprovals.some((approval) => approval.state === "pending")) {
        return currentTask;
      }

      return currentTask.diffs.length > 0 ? currentTask : false;
    },
    taskTimeoutMs,
  );

  let approvalTask =
    readyTask.pendingApprovals.some((approval) => approval.state === "pending") ? readyTask : null;
  if (!approvalTask) {
    try {
      approvalTask = await waitFor(
        "pending approval",
        async () => {
          const currentTask = await taskFromSnapshot(task.taskId);
          if (currentTask && currentTask.status === "awaiting-approval" && currentTask.pendingApprovals.length === 0) {
            throw new Error("Task entered awaiting-approval without any queued approval payload.");
          }
          return currentTask && currentTask.pendingApprovals.some((approval) => approval.state === "pending") ? currentTask : false;
        },
        approvalTimeoutMs,
      );
    } catch (error) {
      if (requireApproval) {
        throw error;
      }
    }
  }

  if (!approvalTask && requireApproval) {
    const currentTask = await taskFromSnapshot(task.taskId);
    throw new Error(
      `No approval surfaced for ${task.taskId}. Current status: ${currentTask?.status ?? "missing-task"}. ` +
        "This usually means the live Codex approval policy auto-accepted the action or the runtime did not emit the expected approval request.",
    );
  }

  if (approvalTask) {
    const approval = approvalTask.pendingApprovals.find((entry) => entry.state === "pending");
    assert(approval, "Expected a pending approval entry.");
    await execDev("codexFeishuBridge.dev.resolveApproval", {
      taskId: task.taskId,
      requestId: approval.requestId,
      decision: "accept",
    });
    await waitFor(
      "approval resolution",
      async () => {
        const currentTask = await taskFromSnapshot(task.taskId);
        const currentApproval = currentTask?.pendingApprovals.find((entry) => entry.requestId === approval.requestId);
        return currentApproval && currentApproval.state !== "pending" ? currentApproval : false;
      },
      30000,
    );
  }

  const diffTask =
    readyTask.diffs.length > 0
      ? readyTask
      : await waitFor(
          "task diff output",
          async () => {
            const currentTask = await taskFromSnapshot(task.taskId);
            return currentTask && currentTask.diffs.length > 0 ? currentTask : false;
          },
          taskTimeoutMs,
        );

  await execDev("codexFeishuBridge.dev.openDiff", {
    taskId: task.taskId,
  });
  const diffContent = await waitFor(
    "diff editor",
    async () => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.languageId !== "diff") {
          continue;
        }

        const text = editor.document.getText();
        if (text.includes("greeting.txt")) {
          return text;
        }
      }
      return false;
    },
    15000,
  );

  const result = {
    baseUrl,
    taskId: task.taskId,
    workspaceRoot,
    connection: connectedSnapshot.connection,
    initialTreeStatus: treeAfterSend.status,
    uploadedImageCount: uploadedTask.imageAssets.length,
    diffCount: diffTask.diffs.length,
    approvalValidated: Boolean(approvalTask),
    diffPreviewLength: diffContent.length,
  };

  console.log(`LIVE_SMOKE_RESULT ${JSON.stringify(result)}`);
}

module.exports = {
  run,
};
