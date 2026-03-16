export type CodexAuthType = "apiKey" | "chatgpt" | "chatgptAuthTokens";
export type CodexTurnStatus = "inProgress" | "completed" | "interrupted" | "failed";
export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface CodexTextInput {
  type: "text";
  text: string;
}

export interface CodexLocalImageInput {
  type: "localImage";
  path: string;
}

export type CodexInputItem = CodexTextInput | CodexLocalImageInput;

export interface CodexFileChangeEntry {
  path: string;
  kind: string;
  diff?: string;
}

export interface CodexThreadItemBase {
  id: string;
  type: string;
  status?: string;
}

export interface CodexUserMessageItem extends CodexThreadItemBase {
  type: "userMessage";
  content: CodexInputItem[];
}

export interface CodexAgentMessageItem extends CodexThreadItemBase {
  type: "agentMessage";
  text: string;
  phase?: "commentary" | "final_answer";
}

export interface CodexFileChangeItem extends CodexThreadItemBase {
  type: "fileChange";
  changes: CodexFileChangeEntry[];
}

export interface CodexCommandExecutionItem extends CodexThreadItemBase {
  type: "commandExecution";
  command?: string[];
  cwd?: string;
}

export interface CodexReviewModeItem extends CodexThreadItemBase {
  type: "enteredReviewMode" | "exitedReviewMode";
  review?: {
    id?: string;
    summary?: string;
  };
}

export type CodexThreadItem =
  | CodexUserMessageItem
  | CodexAgentMessageItem
  | CodexFileChangeItem
  | CodexCommandExecutionItem
  | CodexReviewModeItem
  | CodexThreadItemBase;

export interface CodexTurnDescriptor {
  id: string;
  threadId: string;
  status: CodexTurnStatus;
  items?: CodexThreadItem[];
  error?: {
    message: string;
  };
}

export interface CodexAccountSnapshot {
  account: null | {
    type: CodexAuthType;
    email?: string;
    planType?: string;
  };
  requiresOpenaiAuth: boolean;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface CodexRateLimitSnapshot {
  rateLimits: {
    limitId: string;
    limitName: string | null;
    primary: CodexRateLimitWindow | null;
    secondary: CodexRateLimitWindow | null;
  } | null;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot["rateLimits"]>;
}

export interface CodexLoginStartParams {
  type: CodexAuthType;
  apiKey?: string;
  idToken?: string;
  accessToken?: string;
}

export interface CodexLoginStartResult {
  type: CodexAuthType;
  loginId?: string | null;
  authUrl?: string;
}

export interface CodexThreadDescriptor {
  id: string;
  name?: string | null;
  cwd?: string | null;
  updatedAt?: string;
  status?: unknown;
}

export interface CodexRuntimeHealth {
  backend: "mock" | "stdio";
  connected: boolean;
  initialized: boolean;
}

export interface CodexRuntimeNotification {
  method: string;
  params?: unknown;
  requestId?: number | string;
}

export interface CodexRuntime {
  readonly backend: "mock" | "stdio";
  start(): Promise<void>;
  health(): Promise<CodexRuntimeHealth>;
  loginStart(params: CodexLoginStartParams): Promise<CodexLoginStartResult>;
  readAccount(refreshToken?: boolean): Promise<CodexAccountSnapshot>;
  readRateLimits(): Promise<CodexRateLimitSnapshot>;
  startThread(params: { cwd: string; title?: string }): Promise<CodexThreadDescriptor>;
  listThreads(): Promise<CodexThreadDescriptor[]>;
  readThread(threadId: string): Promise<CodexThreadDescriptor | null>;
  resumeThread(threadId: string): Promise<CodexThreadDescriptor>;
  startTurn(params: { threadId: string; input: CodexInputItem[] }): Promise<CodexTurnDescriptor>;
  steerTurn(params: {
    threadId: string;
    turnId: string;
    input: CodexInputItem[];
  }): Promise<{ turnId: string }>;
  interruptTurn(params: { threadId: string; turnId?: string }): Promise<void>;
  respondToRequest(requestId: number | string, result: unknown): Promise<void>;
  dispose(): Promise<void>;
  onNotification(listener: (notification: CodexRuntimeNotification) => void): () => void;
}
