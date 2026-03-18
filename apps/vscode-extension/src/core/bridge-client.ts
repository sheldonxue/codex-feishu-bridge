import type {
  BridgeTask,
  FeishuRunningMessageMode,
  MessageSurface,
  QueuedApproval,
  ReasoningEffort,
  TaskAssetKind,
  TaskExecutionProfile,
} from "@codex-feishu-bridge/protocol";

import type { DaemonSnapshot } from "./task-model";

export interface BridgeClientConfig {
  baseUrl: string;
  wsPath: string;
}

export interface LoginStartResult {
  type: "apiKey" | "chatgpt" | "chatgptAuthTokens";
  loginId?: string | null;
  authUrl?: string;
}

export interface SocketEventFrame {
  type: "event";
  event: {
    kind: string;
    payload: unknown;
    taskId: string;
    seq: number;
    timestamp: string;
  };
}

export interface SocketSnapshotFrame {
  type: "snapshot";
  snapshot: DaemonSnapshot;
}

export type BridgeSocketFrame = SocketEventFrame | SocketSnapshotFrame;

export interface BridgeSocket {
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

interface CreateTaskPayload {
  title: string;
  workspaceRoot?: string;
  prompt?: string;
  assetIds?: string[];
  executionProfile?: TaskExecutionProfile;
  source?: MessageSurface;
  replyToFeishu?: boolean;
}

interface TaskMessagePayload {
  content: string;
  assetIds?: string[];
  executionProfile?: TaskExecutionProfile;
  source?: MessageSurface;
  replyToFeishu?: boolean;
}

interface TaskSettingsPayload {
  desktopReplySyncToFeishu?: boolean;
  feishuRunningMessageMode?: FeishuRunningMessageMode;
  executionProfile?: TaskExecutionProfile;
}

interface UploadAssetPayload {
  fileName: string;
  mimeType: string;
  contentBase64: string;
  kind?: TaskAssetKind;
}

export interface UploadedAsset {
  asset: {
    assetId: string;
    kind: TaskAssetKind;
    displayName: string;
    localPath: string;
    mimeType: string;
    createdAt: string;
  };
  task: BridgeTask;
}

export interface ModelDescriptor {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
}

export function buildWebSocketUrl(baseUrl: string, wsPath: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function decodeSocketData(data: unknown): Promise<string | null> {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text();
  }

  return null;
}

export class BridgeClient {
  constructor(private readonly config: BridgeClientConfig) {}

  async health(): Promise<unknown> {
    return this.requestJson("/health");
  }

  async login(): Promise<LoginStartResult> {
    return this.requestJson("/auth/login/start", {
      method: "POST",
      body: JSON.stringify({ type: "chatgpt" }),
    });
  }

  async fetchSnapshot(): Promise<DaemonSnapshot> {
    const tasks = await this.requestJson<{ tasks: BridgeTask[] }>("/tasks");
    const [account, rateLimits] = await Promise.allSettled([
      this.requestJson("/auth/account"),
      this.requestJson("/auth/rate-limits"),
    ]);

    return {
      seq: 0,
      tasks: tasks.tasks,
      account: account.status === "fulfilled" ? account.value : null,
      rateLimits: rateLimits.status === "fulfilled" ? rateLimits.value : null,
    };
  }

  async listTasks(): Promise<BridgeTask[]> {
    const result = await this.requestJson<{ tasks: BridgeTask[] }>("/tasks");
    return result.tasks;
  }

  async getTask(taskId: string): Promise<BridgeTask> {
    const result = await this.requestJson<{ task: BridgeTask }>(`/tasks/${encodeURIComponent(taskId)}`);
    return result.task;
  }

  async createTask(payload: CreateTaskPayload): Promise<BridgeTask> {
    const result = await this.requestJson<{ task: BridgeTask }>("/tasks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return result.task;
  }

  async resumeTask(taskId: string): Promise<BridgeTask> {
    const result = await this.requestJson<{ task: BridgeTask }>(`/tasks/${encodeURIComponent(taskId)}/resume`, {
      method: "POST",
    });
    return result.task;
  }

  async importThreads(threadId?: string): Promise<BridgeTask[]> {
    const result = await this.requestJson<{ tasks: BridgeTask[] }>("/tasks/import", {
      method: "POST",
      body: JSON.stringify(threadId ? { threadId } : {}),
    });
    return result.tasks;
  }

  async importRecentThreads(limit = 5): Promise<BridgeTask[]> {
    const result = await this.requestJson<{ tasks: BridgeTask[] }>("/tasks/import/recent", {
      method: "POST",
      body: JSON.stringify({ limit }),
    });
    return result.tasks;
  }

  async forgetImportedTasks(): Promise<string[]> {
    const result = await this.requestJson<{ removedTaskIds: string[] }>("/tasks/forget/imported", {
      method: "POST",
    });
    return result.removedTaskIds;
  }

  async sendMessage(taskId: string, payload: TaskMessagePayload): Promise<BridgeTask> {
    const result = await this.requestJson<{ task: BridgeTask }>(`/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return result.task;
  }

  async updateTaskSettings(taskId: string, payload: TaskSettingsPayload): Promise<BridgeTask> {
    const result = await this.requestJson<{ task: BridgeTask }>(`/tasks/${encodeURIComponent(taskId)}/settings`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return result.task;
  }

  async unbindFeishuThread(taskId: string): Promise<BridgeTask> {
    const result = await this.requestJson<{ task: BridgeTask }>(`/tasks/${encodeURIComponent(taskId)}/feishu/unbind`, {
      method: "POST",
    });
    return result.task;
  }

  async bindTaskToNewFeishuTopic(taskId: string): Promise<BridgeTask> {
    const result = await this.requestJson<{ task: BridgeTask }>(`/tasks/${encodeURIComponent(taskId)}/feishu/topic`, {
      method: "POST",
    });
    return result.task;
  }

  async forgetTask(taskId: string): Promise<void> {
    await this.requestJson<{ taskId: string }>(`/tasks/${encodeURIComponent(taskId)}/forget`, {
      method: "POST",
    });
  }

  async deleteLocalTask(taskId: string): Promise<void> {
    await this.requestJson<{ taskId: string }>(`/tasks/${encodeURIComponent(taskId)}/delete-local`, {
      method: "POST",
    });
  }

  async interruptTask(taskId: string): Promise<BridgeTask> {
    const result = await this.requestJson<{ task: BridgeTask }>(`/tasks/${encodeURIComponent(taskId)}/interrupt`, {
      method: "POST",
    });
    return result.task;
  }

  async resolveApproval(taskId: string, approval: QueuedApproval, decision: "accept" | "decline" | "cancel"): Promise<BridgeTask> {
    const result = await this.requestJson<{ task: BridgeTask }>(
      `/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approval.requestId)}/resolve`,
      {
        method: "POST",
        body: JSON.stringify({ decision }),
      },
    );
    return result.task;
  }

  async uploadTaskImage(taskId: string, payload: UploadAssetPayload): Promise<UploadedAsset> {
    return this.uploadTaskAsset(taskId, payload);
  }

  async uploadTaskAsset(taskId: string, payload: UploadAssetPayload): Promise<UploadedAsset> {
    return this.requestJson<UploadedAsset>(`/tasks/${encodeURIComponent(taskId)}/uploads`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const result = await this.requestJson<{ models: ModelDescriptor[] }>("/models");
    return result.models;
  }

  connect(onFrame: (frame: BridgeSocketFrame) => void, onClose: () => void): BridgeSocket {
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSocket is not available in this extension host.");
    }

    const socket = new WebSocket(buildWebSocketUrl(this.config.baseUrl, this.config.wsPath)) as BridgeSocket;
    socket.addEventListener("message", async (event) => {
      try {
        const raw = await decodeSocketData(event.data);
        if (!raw) {
          return;
        }

        onFrame(JSON.parse(raw) as BridgeSocketFrame);
      } catch {
        // Ignore malformed daemon frames and keep the extension alive.
      }
    });
    socket.addEventListener("close", () => {
      onClose();
    });
    socket.addEventListener("error", () => {
      onClose();
    });
    return socket;
  }

  private async requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
    const url = new URL(pathname, this.config.baseUrl);
    const response = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Bridge request failed (${response.status}): ${body}`);
    }

    return (await response.json()) as T;
  }
}
