import * as path from "node:path";

import * as vscode from "vscode";

import type { BridgeTask, MessageSurface, QueuedApproval } from "@codex-feishu-bridge/protocol";

import { BridgeClient } from "./core/bridge-client";
import { diffSummaryText } from "./core/diff-summary";
import { TaskStore } from "./core/task-store";
import { openStatusPanel, openTaskDetailPanel } from "./panels/task-detail-panel";
import { TaskMonitorViewProvider } from "./panels/task-monitor-view";
import { TaskTreeItem, TaskTreeProvider } from "./providers/task-tree";

interface ExtensionServices {
  client: BridgeClient;
  store: TaskStore;
}

interface DevCreateTaskRequest {
  title: string;
  workspaceRoot?: string;
  prompt?: string;
}

interface DevSendMessageRequest {
  taskId: string;
  content: string;
  imagePaths?: string[];
  replyToFeishu?: boolean;
}

interface DevResolveApprovalRequest {
  taskId: string;
  requestId: string;
  decision: "accept" | "decline" | "cancel";
}

interface DevOpenDiffRequest {
  taskId: string;
  diffPath?: string;
}

function bridgeConfiguration(): { baseUrl: string; wsPath: string } {
  const config = vscode.workspace.getConfiguration("codexFeishuBridge");
  return {
    baseUrl: config.get<string>("baseUrl", "http://127.0.0.1:8787"),
    wsPath: config.get<string>("wsPath", "/ws"),
  };
}

function mimeTypeForPath(targetPath: string): string {
  const extension = path.extname(targetPath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

async function pickTask(store: TaskStore, placeholder: string, predicate?: (task: BridgeTask) => boolean): Promise<BridgeTask | undefined> {
  const candidates = store
    .listTasks()
    .filter((task) => (predicate ? predicate(task) : true))
    .map((task) => ({
      label: task.title,
      description: task.status,
      detail: task.workspaceRoot,
      task,
    }));

  if (candidates.length === 0) {
    vscode.window.showInformationMessage("No matching Codex bridge tasks were found.");
    return undefined;
  }

  const selection = await vscode.window.showQuickPick(candidates, { placeHolder: placeholder });
  return selection?.task;
}

async function resolveTaskArgument(store: TaskStore, taskOrItem?: BridgeTask | TaskTreeItem): Promise<BridgeTask | undefined> {
  if (!taskOrItem) {
    return undefined;
  }

  if (taskOrItem instanceof TaskTreeItem) {
    return taskOrItem.task;
  }

  return taskOrItem;
}

async function uploadImages(services: ExtensionServices, task: BridgeTask): Promise<string[]> {
  const wantsAttachments = await vscode.window.showQuickPick(
    [
      { label: "No attachments", attach: false },
      { label: "Attach images", attach: true },
    ],
    {
      placeHolder: "Attach local images to this message?",
    },
  );

  if (!wantsAttachments?.attach) {
    return [];
  }

  const files = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: "Upload images",
    filters: {
      Images: ["png", "jpg", "jpeg", "gif", "webp"],
    },
  });
  if (!files?.length) {
    return [];
  }

  const assetIds: string[] = [];
  for (const file of files) {
    const content = await vscode.workspace.fs.readFile(file);
    const upload = await services.client.uploadTaskImage(task.taskId, {
      fileName: path.basename(file.fsPath),
      mimeType: mimeTypeForPath(file.fsPath),
      contentBase64: Buffer.from(content).toString("base64"),
    });
    assetIds.push(upload.asset.assetId);
  }

  await services.store.refresh();
  return assetIds;
}

async function uploadImagePaths(services: ExtensionServices, taskId: string, imagePaths: string[]): Promise<string[]> {
  if (imagePaths.length === 0) {
    return [];
  }

  const assetIds: string[] = [];
  for (const imagePath of imagePaths) {
    const target = vscode.Uri.file(imagePath);
    const content = await vscode.workspace.fs.readFile(target);
    const upload = await services.client.uploadTaskImage(taskId, {
      fileName: path.basename(target.fsPath),
      mimeType: mimeTypeForPath(target.fsPath),
      contentBase64: Buffer.from(content).toString("base64"),
    });
    assetIds.push(upload.asset.assetId);
  }

  await services.store.refresh();
  return assetIds;
}

function selectTaskDiff(task: BridgeTask, diffPath?: string): BridgeTask["diffs"][number] {
  const selectedDiff = diffPath ? task.diffs.find((candidate) => candidate.path === diffPath) : task.diffs[0];
  if (!selectedDiff) {
    throw new Error(diffPath ? `No diff was found for ${diffPath}.` : `No diff data is available for ${task.title}.`);
  }

  return selectedDiff;
}

function diffDocumentContent(diff: BridgeTask["diffs"][number]): string {
  const patch = diff.patch?.trimEnd();
  if (!patch) {
    return `# ${diff.path}\n\n${diffSummaryText(diff.summary)}`;
  }

  const looksLikeUnifiedDiff =
    patch.startsWith("diff ") ||
    patch.startsWith("--- ") ||
    patch.startsWith("+++ ") ||
    patch.includes("\n--- ") ||
    patch.includes("\n+++ ");

  if (looksLikeUnifiedDiff || patch.includes(diff.path)) {
    return patch;
  }

  return `# ${diff.path}\n\n${patch}`;
}

async function openTaskDiff(task: BridgeTask, diffPath?: string): Promise<BridgeTask["diffs"][number]> {
  const selectedDiff = selectTaskDiff(task, diffPath);
  const document = await vscode.workspace.openTextDocument({
    content: diffDocumentContent(selectedDiff),
    language: "diff",
  });
  await vscode.window.showTextDocument(document, { preview: false });
  return selectedDiff;
}

async function sendTaskMessage(
  services: ExtensionServices,
  taskId: string,
  payload: {
    content: string;
    imagePaths?: string[];
    imageAssetIds?: string[];
    source?: MessageSurface;
    replyToFeishu?: boolean;
  },
): Promise<BridgeTask> {
  const imageAssetIds = payload.imageAssetIds ?? (await uploadImagePaths(services, taskId, payload.imagePaths ?? []));
  await services.client.sendMessage(taskId, {
    content: payload.content,
    imageAssetIds,
    source: payload.source,
    replyToFeishu: payload.replyToFeishu,
  });
  await services.store.refresh();
  return services.client.getTask(taskId);
}

async function resolveTaskApproval(
  services: ExtensionServices,
  request: DevResolveApprovalRequest,
): Promise<BridgeTask> {
  const task = await services.client.getTask(request.taskId);
  const approval = task.pendingApprovals.find((entry) => entry.requestId === request.requestId);
  if (!approval) {
    throw new Error(`No approval was found for request ${request.requestId}.`);
  }

  await services.client.resolveApproval(request.taskId, approval, request.decision);
  await services.store.refresh();
  return services.client.getTask(request.taskId);
}

function serializeTaskTree(treeProvider: TaskTreeProvider): Array<{
  taskId: string;
  title: string;
  status: BridgeTask["status"];
  description?: string | boolean;
}> {
  return treeProvider.getChildren().map((item) => ({
    taskId: item.task.taskId,
    title: item.task.title,
    status: item.task.status,
    description: item.description,
  }));
}

async function withTaskMessage(
  services: ExtensionServices,
  task: BridgeTask,
  options?: { title?: string; placeholder?: string; initialValue?: string },
): Promise<void> {
  const content = await vscode.window.showInputBox({
    title: options?.title ?? `Message ${task.title}`,
    placeHolder: options?.placeholder ?? "Send a message to the Codex task",
    value: options?.initialValue,
  });

  if (content === undefined) {
    return;
  }

  await sendTaskMessage(services, task.taskId, {
    content,
    imageAssetIds: await uploadImages(services, task),
    source: "vscode",
    replyToFeishu: task.feishuBinding ? task.desktopReplySyncToFeishu : false,
  });
}

async function approveByKind(
  services: ExtensionServices,
  taskOrItem: BridgeTask | TaskTreeItem | undefined,
  kind: QueuedApproval["kind"],
): Promise<void> {
  const task = (await resolveTaskArgument(services.store, taskOrItem)) ??
    (await pickTask(services.store, `Select a task with pending ${kind} approvals`, (candidate) =>
      candidate.pendingApprovals.some((approval) => approval.kind === kind && approval.state === "pending"),
    ));
  if (!task) {
    return;
  }

  const approvals = task.pendingApprovals.filter((approval) => approval.kind === kind && approval.state === "pending");
  if (approvals.length === 0) {
    vscode.window.showInformationMessage(`No pending ${kind} approvals were found for ${task.title}.`);
    return;
  }

  const selectedApproval =
    approvals.length === 1
      ? approvals[0]
      : (
          await vscode.window.showQuickPick(
            approvals.map((approval) => ({
              label: approval.reason,
              description: approval.requestId,
              approval,
            })),
            { placeHolder: `Select a ${kind} approval to resolve` },
          )
        )?.approval;
  if (!selectedApproval) {
    return;
  }

  const decision = await vscode.window.showQuickPick(
    [
      { label: "Accept", value: "accept" as const },
      { label: "Decline", value: "decline" as const },
      { label: "Cancel", value: "cancel" as const },
    ],
    { placeHolder: "Choose an approval decision" },
  );
  if (!decision) {
    return;
  }

  await services.client.resolveApproval(task.taskId, selectedApproval, decision.value);
  await services.store.refresh();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const client = new BridgeClient(bridgeConfiguration());
  const services: ExtensionServices = {
    client,
    store: new TaskStore(client),
  };

  const showLocalImportedTasks = context.workspaceState.get<boolean>("codexFeishuBridge.monitor.showLocalImportedTasks") ?? false;
  const treeProvider = new TaskTreeProvider(services.store, {
    showLocalImportedTasks,
  });
  const monitorProvider = new TaskMonitorViewProvider({
    context,
    client,
    store: services.store,
    sendMessage: async (taskId, payload) => sendTaskMessage(services, taskId, payload),
    setShowLocalImportedTasks: async (enabled) => {
      treeProvider.setShowLocalImportedTasks(enabled);
    },
    forgetLocalTask: async (taskId) => {
      await services.client.forgetTask(taskId);
    },
    deleteLocalTask: async (taskId) => {
      await services.client.deleteLocalTask(taskId);
    },
    openStatus: async () => {
      await services.store.refresh();
      const snapshot = services.store.getSnapshot();
      openStatusPanel({
        account: snapshot.account,
        rateLimits: snapshot.rateLimits,
        connection: snapshot.connection,
        taskCount: snapshot.tasks.length,
      });
    },
    openDiff: async (task, diffPath) => {
      const freshTask = await services.client.getTask(task.taskId);
      await openTaskDiff(freshTask, diffPath);
    },
  });

  context.subscriptions.push(
    treeProvider,
    vscode.window.registerTreeDataProvider("codexFeishuBridge.tasks", treeProvider),
    monitorProvider,
    vscode.window.registerWebviewViewProvider(TaskMonitorViewProvider.viewType, monitorProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  );

  context.subscriptions.push({
    dispose() {
      services.store.dispose();
    },
  });

  void services.store.start().catch((error: unknown) => {
    void vscode.window.showErrorMessage(
      error instanceof Error ? `Failed to start Codex bridge store: ${error.message}` : "Failed to start Codex bridge store.",
    );
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("codexFeishuBridge.refresh", async () => {
      await services.store.refresh();
      void vscode.window.showInformationMessage("Codex bridge tasks refreshed.");
    }),
    vscode.commands.registerCommand("codexFeishuBridge.login", async () => {
      const result = await services.client.login();
      if (result.authUrl) {
        await vscode.env.openExternal(vscode.Uri.parse(result.authUrl));
        void vscode.window.showInformationMessage("Opened ChatGPT login in your browser.");
      } else {
        void vscode.window.showInformationMessage("Bridge login request started.");
      }
      await services.store.refresh();
    }),
    vscode.commands.registerCommand("codexFeishuBridge.newTask", async () => {
      const title = await vscode.window.showInputBox({
        title: "Create a Codex bridge task",
        placeHolder: "Task title",
      });
      if (!title?.trim()) {
        return;
      }

      const prompt = await vscode.window.showInputBox({
        title: `Initial prompt for ${title}`,
        placeHolder: "Optional prompt to send immediately",
      });

      await services.client.createTask({
        title,
        prompt: prompt ?? "",
      });
      await services.store.refresh();
      const latestTask = services.store.listTasks()[0];
      if (latestTask) {
        await monitorProvider.focusTask(latestTask, true);
      }
    }),
    vscode.commands.registerCommand("codexFeishuBridge.focusTaskInMonitor", async (taskOrItem?: BridgeTask | TaskTreeItem) => {
      const task = (await resolveTaskArgument(services.store, taskOrItem)) ??
        (await pickTask(services.store, "Select a task to monitor"));
      if (!task) {
        return;
      }
      await monitorProvider.focusTask(task);
    }),
    vscode.commands.registerCommand("codexFeishuBridge.resumeTask", async (taskOrItem?: BridgeTask | TaskTreeItem) => {
      const task = (await resolveTaskArgument(services.store, taskOrItem)) ??
        (await pickTask(services.store, "Select a task to resume"));
      if (!task) {
        return;
      }

      await services.client.resumeTask(task.taskId);
      await services.store.refresh();
      await monitorProvider.focusTask(task);
    }),
    vscode.commands.registerCommand("codexFeishuBridge.importThreads", async () => {
      const threadId = await vscode.window.showInputBox({
        title: "Import Codex threads",
        placeHolder: "Leave empty to import every visible thread",
      });
      await services.client.importThreads(threadId?.trim() || undefined);
      await services.store.refresh();
    }),
    vscode.commands.registerCommand("codexFeishuBridge.sendMessage", async (taskOrItem?: BridgeTask | TaskTreeItem) => {
      const task = (await resolveTaskArgument(services.store, taskOrItem)) ??
        (await pickTask(services.store, "Select a task to message"));
      if (!task) {
        return;
      }

      await monitorProvider.focusTask(task, true);
    }),
    vscode.commands.registerCommand("codexFeishuBridge.interruptTask", async (taskOrItem?: BridgeTask | TaskTreeItem) => {
      const task = (await resolveTaskArgument(services.store, taskOrItem)) ??
        (await pickTask(services.store, "Select a running task to interrupt", (candidate) => candidate.activeTurnId !== undefined));
      if (!task) {
        return;
      }

      await services.client.interruptTask(task.taskId);
      await services.store.refresh();
    }),
    vscode.commands.registerCommand("codexFeishuBridge.approveCommand", async (taskOrItem?: BridgeTask | TaskTreeItem) => {
      await approveByKind(services, taskOrItem, "command");
    }),
    vscode.commands.registerCommand("codexFeishuBridge.approveFileChange", async (taskOrItem?: BridgeTask | TaskTreeItem) => {
      await approveByKind(services, taskOrItem, "file-change");
    }),
    vscode.commands.registerCommand("codexFeishuBridge.retryTurn", async (taskOrItem?: BridgeTask | TaskTreeItem) => {
      const task = (await resolveTaskArgument(services.store, taskOrItem)) ??
        (await pickTask(services.store, "Select a task to retry"));
      if (!task) {
        return;
      }

      await withTaskMessage(services, task, {
        title: `Retry ${task.title}`,
        initialValue: "Retry the last turn, keep the existing context, and continue.",
        placeholder: "Optional retry instructions",
      });
    }),
    vscode.commands.registerCommand("codexFeishuBridge.openDiff", async (taskOrItem?: BridgeTask | TaskTreeItem) => {
      const task = (await resolveTaskArgument(services.store, taskOrItem)) ??
        (await pickTask(services.store, "Select a task with diff output", (candidate) => candidate.diffs.length > 0));
      if (!task) {
        return;
      }
      if (task.diffs.length === 0) {
        void vscode.window.showInformationMessage(`No diff data is available for ${task.title}.`);
        return;
      }

      const selectedDiff =
        task.diffs.length === 1
          ? task.diffs[0]
          : (
              await vscode.window.showQuickPick(
                task.diffs.map((diff) => ({
                  label: diff.path,
                  description: diffSummaryText(diff.summary),
                  diff,
                })),
                { placeHolder: "Select a diff to open" },
              )
            )?.diff;
      if (!selectedDiff) {
        return;
      }

      await openTaskDiff(task, selectedDiff.path);
    }),
    vscode.commands.registerCommand("codexFeishuBridge.openTaskDetails", async (taskOrItem?: BridgeTask | TaskTreeItem) => {
      const task = (await resolveTaskArgument(services.store, taskOrItem)) ??
        (await pickTask(services.store, "Select a task to inspect"));
      if (!task) {
        return;
      }

      const freshTask = await services.client.getTask(task.taskId);
      openTaskDetailPanel(freshTask);
    }),
    vscode.commands.registerCommand("codexFeishuBridge.openStatus", async () => {
      await services.store.refresh();
      const snapshot = services.store.getSnapshot();
      openStatusPanel({
        account: snapshot.account,
        rateLimits: snapshot.rateLimits,
        connection: snapshot.connection,
        taskCount: snapshot.tasks.length,
      });
    }),
  );

  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    context.subscriptions.push(
      vscode.commands.registerCommand("codexFeishuBridge.dev.getSnapshot", async () => {
        await services.store.refresh();
        return services.store.getSnapshot();
      }),
      vscode.commands.registerCommand("codexFeishuBridge.dev.getTaskTree", async () => {
        await services.store.refresh();
        return serializeTaskTree(treeProvider);
      }),
      vscode.commands.registerCommand("codexFeishuBridge.dev.createTask", async (request: DevCreateTaskRequest) => {
        const task = await services.client.createTask({
          title: request.title,
          workspaceRoot: request.workspaceRoot,
          prompt: request.prompt,
        });
        await services.store.refresh();
        return services.client.getTask(task.taskId);
      }),
      vscode.commands.registerCommand("codexFeishuBridge.dev.sendMessage", async (request: DevSendMessageRequest) =>
        sendTaskMessage(services, request.taskId, {
          content: request.content,
          imagePaths: request.imagePaths,
          source: "vscode",
          replyToFeishu: request.replyToFeishu,
        })),
      vscode.commands.registerCommand("codexFeishuBridge.dev.resolveApproval", async (request: DevResolveApprovalRequest) =>
        resolveTaskApproval(services, request)),
      vscode.commands.registerCommand("codexFeishuBridge.dev.openTaskDetails", async (taskId: string) => {
        const task = await services.client.getTask(taskId);
        openTaskDetailPanel(task);
        return {
          taskId: task.taskId,
          title: task.title,
        };
      }),
      vscode.commands.registerCommand("codexFeishuBridge.dev.openDiff", async (request: DevOpenDiffRequest) => {
        const task = await services.client.getTask(request.taskId);
        const diff = await openTaskDiff(task, request.diffPath);
        return {
          path: diff.path,
          summary: diffSummaryText(diff.summary),
        };
      }),
      vscode.commands.registerCommand("codexFeishuBridge.dev.openStatus", async () => {
        await services.store.refresh();
        const snapshot = services.store.getSnapshot();
        openStatusPanel({
          account: snapshot.account,
          rateLimits: snapshot.rateLimits,
          connection: snapshot.connection,
          taskCount: snapshot.tasks.length,
        });
        return {
          connection: snapshot.connection,
          taskCount: snapshot.tasks.length,
        };
      }),
    );
  }
}

export function deactivate(): void {
  // VSCode disposes registered subscriptions automatically.
}
