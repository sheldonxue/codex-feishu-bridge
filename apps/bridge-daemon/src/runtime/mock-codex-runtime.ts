import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import type { BridgeConfig, Logger } from "@codex-feishu-bridge/shared";

import type {
  CodexAccountSnapshot,
  CodexApprovalDecision,
  CodexApprovalPolicy,
  CodexInputItem,
  CodexLoginStartParams,
  CodexLoginStartResult,
  CodexModelDescriptor,
  CodexRateLimitSnapshot,
  CodexRuntime,
  CodexRuntimeHealth,
  CodexRuntimeNotification,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexThreadDescriptor,
  CodexThreadItem,
  CodexTurnDescriptor,
  CodexTurnStatus,
} from "./types";

interface MockPendingApproval {
  itemId: string;
  requestId: number;
  turnId: string;
  type: "commandExecution" | "fileChange";
}

interface MockTurnState {
  turn: CodexTurnDescriptor;
  pendingApproval?: MockPendingApproval;
}

interface MockThreadState {
  descriptor: CodexThreadDescriptor;
  turns: Map<string, MockTurnState>;
  activeTurnId?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildUserMessageItem(input: CodexInputItem[]): CodexThreadItem {
  return {
    id: randomUUID(),
    type: "userMessage",
    content: input,
  };
}

function buildAgentMessage(text: string): CodexThreadItem {
  return {
    id: randomUUID(),
    type: "agentMessage",
    text,
    phase: "final_answer",
  };
}

const MOCK_MODELS: CodexModelDescriptor[] = [
  {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    isDefault: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4-mini",
    model: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    isDefault: false,
    supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
    defaultReasoningEffort: "low",
  },
];

export class MockCodexRuntime implements CodexRuntime {
  readonly backend = "mock";

  private readonly emitter = new EventEmitter();
  private readonly threads = new Map<string, MockThreadState>();
  private account: CodexAccountSnapshot = {
    account: null,
    requiresOpenaiAuth: true,
  };
  private nextServerRequestId = 1;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.logger.info("mock codex runtime started");
  }

  async health(): Promise<CodexRuntimeHealth> {
    return {
      backend: this.backend,
      connected: true,
      initialized: true,
    };
  }

  async loginStart(params: CodexLoginStartParams): Promise<CodexLoginStartResult> {
    const loginId = params.type === "chatgpt" ? randomUUID() : null;
    const result: CodexLoginStartResult = {
      type: params.type,
      loginId,
      authUrl:
        params.type === "chatgpt"
          ? `https://chatgpt.com/mock-auth?login_id=${loginId}`
          : undefined,
    };

    this.emitNotification("auth.login.started", result);

    if (this.config.mockAutoCompleteLogin) {
      this.account = {
        account:
          params.type === "chatgpt"
            ? {
                type: "chatgpt",
                email: "mock-user@example.com",
                planType: "pro",
              }
            : {
                type: params.type,
              },
        requiresOpenaiAuth: true,
      };

      this.emitNotification("account/login/completed", {
        loginId,
        success: true,
        error: null,
      });
      this.emitNotification("account/updated", {
        authMode: params.type === "apiKey" ? "apikey" : params.type,
      });
    }

    return result;
  }

  async readAccount(): Promise<CodexAccountSnapshot> {
    return this.account;
  }

  async readRateLimits(): Promise<CodexRateLimitSnapshot> {
    return {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: {
          usedPercent: 12,
          windowDurationMins: 15,
          resetsAt: 1760000000,
        },
        secondary: null,
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 12,
            windowDurationMins: 15,
            resetsAt: 1760000000,
          },
          secondary: null,
        },
      },
    };
  }

  async listModels(): Promise<CodexModelDescriptor[]> {
    return structuredClone(MOCK_MODELS);
  }

  async startThread(params: {
    cwd: string;
    title?: string;
    model?: string;
    approvalPolicy?: CodexApprovalPolicy;
    sandbox?: CodexSandboxMode;
  }): Promise<CodexThreadDescriptor> {
    const threadId = `thr_${randomUUID()}`;
    const thread = this.seedExternalThread({
      id: threadId,
      name: params.title ?? "Untitled task",
      cwd: params.cwd,
      updatedAt: nowIso(),
      status: { type: "idle" },
    });

    this.emitNotification("thread/started", { thread });
    return thread;
  }

  async listThreads(): Promise<CodexThreadDescriptor[]> {
    return [...this.threads.values()].map((entry) => entry.descriptor);
  }

  async readThread(threadId: string): Promise<CodexThreadDescriptor | null> {
    return this.threads.get(threadId)?.descriptor ?? null;
  }

  async resumeThread(threadId: string): Promise<CodexThreadDescriptor> {
    const existing = this.threads.get(threadId);
    if (existing) {
      existing.descriptor.updatedAt = nowIso();
      this.emitNotification("thread/started", { thread: existing.descriptor });
      return existing.descriptor;
    }

    const descriptor: CodexThreadDescriptor = {
      id: threadId,
      name: "Imported thread",
      cwd: this.config.workspaceRoot,
      updatedAt: nowIso(),
      status: { type: "idle" },
    };

    this.threads.set(threadId, {
      descriptor,
      turns: new Map(),
    });
    this.emitNotification("thread/started", { thread: descriptor });
    return descriptor;
  }

  async startTurn(params: {
    threadId: string;
    input: CodexInputItem[];
    model?: string;
    effort?: CodexReasoningEffort;
    approvalPolicy?: CodexApprovalPolicy;
    sandbox?: CodexSandboxMode;
    planMode?: boolean;
  }): Promise<CodexTurnDescriptor> {
    const threadState = this.requireThread(params.threadId);
    const turnId = `turn_${randomUUID()}`;
    const turn: CodexTurnDescriptor = {
      id: turnId,
      threadId: params.threadId,
      status: "inProgress",
      items: [],
    };

    threadState.turns.set(turnId, { turn });
    threadState.activeTurnId = turnId;
    this.updateThreadStatus(threadState, "running");
    this.emitNotification("turn/started", { turn });

    const userMessage = buildUserMessageItem(params.input);
    turn.items?.push(userMessage);
    this.emitNotification("item/completed", { threadId: params.threadId, turnId, item: userMessage });

    this.completeOrPauseTurn(threadState, turnId, params.input);
    return turn;
  }

  async steerTurn(params: { threadId: string; turnId: string; input: CodexInputItem[] }): Promise<{ turnId: string }> {
    const threadState = this.requireThread(params.threadId);
    const turnState = threadState.turns.get(params.turnId);
    if (!turnState) {
      throw new Error(`Unknown turn: ${params.turnId}`);
    }

    const userMessage = buildUserMessageItem(params.input);
    turnState.turn.items?.push(userMessage);
    this.emitNotification("item/completed", {
      threadId: params.threadId,
      turnId: params.turnId,
      item: userMessage,
    });

    this.completeOrPauseTurn(threadState, params.turnId, params.input);
    return { turnId: params.turnId };
  }

  async interruptTurn(params: { threadId: string; turnId?: string }): Promise<void> {
    const threadState = this.requireThread(params.threadId);
    const turnId = params.turnId ?? threadState.activeTurnId;
    if (!turnId) {
      return;
    }

    const turnState = threadState.turns.get(turnId);
    if (!turnState) {
      return;
    }

    turnState.turn.status = "interrupted";
    threadState.activeTurnId = undefined;
    this.updateThreadStatus(threadState, "interrupted");
    this.emitNotification("turn/completed", {
      turn: turnState.turn,
    });
    this.updateThreadStatus(threadState, "idle");
  }

  async respondToRequest(requestId: number | string, result: unknown): Promise<void> {
    const decision = typeof result === "string" ? result : "cancel";

    for (const threadState of this.threads.values()) {
      for (const [turnId, turnState] of threadState.turns) {
        const pending = turnState.pendingApproval;
        if (!pending || String(pending.requestId) !== String(requestId)) {
          continue;
        }

        this.emitNotification("serverRequest/resolved", {
          threadId: threadState.descriptor.id,
          requestId: pending.requestId,
        });

        const finalStatus = this.applyApprovalDecision(turnState.turn, pending, decision as CodexApprovalDecision);
        delete turnState.pendingApproval;

        if (finalStatus === "completed") {
          this.emitNotification("item/completed", {
            threadId: threadState.descriptor.id,
            turnId,
            item: {
              id: pending.itemId,
              type: pending.type,
              status: decision === "accept" || decision === "acceptForSession" ? "completed" : "declined",
            },
          });
        }

        threadState.activeTurnId = undefined;
        this.updateThreadStatus(threadState, "idle");
        this.emitNotification("turn/completed", {
          turn: turnState.turn,
        });
        return;
      }
    }
  }

  async dispose(): Promise<void> {
    this.emitter.removeAllListeners();
  }

  onNotification(listener: (notification: CodexRuntimeNotification) => void): () => void {
    this.emitter.on("notification", listener);
    return () => {
      this.emitter.off("notification", listener);
    };
  }

  seedExternalThread(descriptor?: Partial<CodexThreadDescriptor>): CodexThreadDescriptor {
    const threadId = descriptor?.id ?? `thr_${randomUUID()}`;
    const thread: CodexThreadDescriptor = {
      id: threadId,
      name: descriptor?.name ?? "Imported thread",
      cwd: descriptor?.cwd ?? this.config.workspaceRoot,
      updatedAt: descriptor?.updatedAt ?? nowIso(),
      status: descriptor?.status ?? { type: "idle" },
    };

    this.threads.set(threadId, {
      descriptor: thread,
      turns: new Map(),
    });

    return thread;
  }

  private applyApprovalDecision(
    turn: CodexTurnDescriptor,
    pending: MockPendingApproval,
    decision: CodexApprovalDecision,
  ): CodexTurnStatus {
    if (decision === "accept" || decision === "acceptForSession") {
      const agentMessage = buildAgentMessage(
        pending.type === "fileChange"
          ? "Mock runtime applied the requested file changes."
          : "Mock runtime executed the approved command.",
      );
      turn.items?.push(agentMessage);
      this.emitNotification("item/completed", {
        threadId: turn.threadId,
        turnId: turn.id,
        item: agentMessage,
      });
      turn.status = "completed";
      return "completed";
    }

    turn.status = "failed";
    turn.error = {
      message: "Approval was declined or cancelled.",
    };
    return "failed";
  }

  private completeOrPauseTurn(threadState: MockThreadState, turnId: string, input: CodexInputItem[]): void {
    const turnState = threadState.turns.get(turnId);
    if (!turnState) {
      return;
    }

    const textPrompt = input
      .filter((item): item is Extract<CodexInputItem, { type: "text" }> => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();
    const wantsFileApproval = /\b(edit|patch|modify|diff|refactor)\b/i.test(textPrompt);
    const wantsCommandApproval = /\b(command|network|shell)\b/i.test(textPrompt);

    if (wantsFileApproval) {
      const fileChangeItemId = randomUUID();
      const fileChangeItem: CodexThreadItem = {
        id: fileChangeItemId,
        type: "fileChange",
        status: "inProgress",
        changes: [
          {
            path: "src/example.ts",
            kind: "update",
            diff: `--- a/src/example.ts\n+++ b/src/example.ts\n@@\n-console.log("before");\n+console.log("after");\n`,
          },
        ],
      };
      turnState.turn.items?.push(fileChangeItem);
      this.emitNotification("item/started", {
        threadId: threadState.descriptor.id,
        turnId,
        item: fileChangeItem,
      });
      this.emitNotification("turn/diff/updated", {
        threadId: threadState.descriptor.id,
        turnId,
        diff: `--- a/src/example.ts\n+++ b/src/example.ts\n@@\n-console.log("before");\n+console.log("after");\n`,
      });

      const requestId = this.nextServerRequestId++;
      turnState.pendingApproval = {
        itemId: fileChangeItemId,
        requestId,
        turnId,
        type: "fileChange",
      };
      this.updateThreadStatus(threadState, "awaitingApproval");
      this.emitNotification(
        "item/fileChange/requestApproval",
        {
          itemId: fileChangeItemId,
          threadId: threadState.descriptor.id,
          turnId,
          requestId,
          reason: "Apply the proposed file changes?",
        },
        requestId,
      );
      return;
    }

    if (wantsCommandApproval) {
      const commandItemId = randomUUID();
      const commandItem: CodexThreadItem = {
        id: commandItemId,
        type: "commandExecution",
        status: "inProgress",
        command: ["npm", "test"],
        cwd: threadState.descriptor.cwd ?? this.config.workspaceRoot,
      };
      turnState.turn.items?.push(commandItem);
      this.emitNotification("item/started", {
        threadId: threadState.descriptor.id,
        turnId,
        item: commandItem,
      });

      const requestId = this.nextServerRequestId++;
      turnState.pendingApproval = {
        itemId: commandItemId,
        requestId,
        turnId,
        type: "commandExecution",
      };
      this.updateThreadStatus(threadState, "awaitingApproval");
      this.emitNotification(
        "item/commandExecution/requestApproval",
        {
          itemId: commandItemId,
          threadId: threadState.descriptor.id,
          turnId,
          requestId,
          reason: "Run the requested command?",
          command: ["npm", "test"],
          cwd: commandItem.cwd,
        },
        requestId,
      );
      return;
    }

    const imageCount = input.filter((item) => item.type === "localImage").length;
    const answer = textPrompt
      ? `Mock response for: ${textPrompt}${imageCount > 0 ? ` (with ${imageCount} image attachment${imageCount > 1 ? "s" : ""})` : ""}`
      : `Mock response with ${imageCount} image attachment${imageCount > 1 ? "s" : ""}.`;
    const agentMessage = buildAgentMessage(answer);
    turnState.turn.items?.push(agentMessage);
    this.emitNotification("item/completed", {
      threadId: threadState.descriptor.id,
      turnId,
      item: agentMessage,
    });

    turnState.turn.status = "completed";
    threadState.activeTurnId = undefined;
    this.emitNotification("turn/completed", { turn: turnState.turn });
    this.updateThreadStatus(threadState, "idle");
  }

  private requireThread(threadId: string): MockThreadState {
    const threadState = this.threads.get(threadId);
    if (!threadState) {
      throw new Error(`Unknown thread: ${threadId}`);
    }

    return threadState;
  }

  private updateThreadStatus(
    threadState: MockThreadState,
    status: "idle" | "running" | "awaitingApproval" | "interrupted",
  ): void {
    threadState.descriptor.updatedAt = nowIso();
    threadState.descriptor.status = { type: status };
    this.emitNotification("thread/status/changed", {
      threadId: threadState.descriptor.id,
      status,
    });
  }

  private emitNotification(method: string, params?: unknown, requestId?: number): void {
    this.emitter.emit("notification", { method, params, requestId });
  }
}
