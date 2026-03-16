export type CodexAuthType = "apiKey" | "chatgpt" | "chatgptAuthTokens";

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
}

export interface CodexRuntime {
  readonly backend: "mock" | "stdio";
  start(): Promise<void>;
  health(): Promise<CodexRuntimeHealth>;
  loginStart(params: CodexLoginStartParams): Promise<CodexLoginStartResult>;
  readAccount(refreshToken?: boolean): Promise<CodexAccountSnapshot>;
  readRateLimits(): Promise<CodexRateLimitSnapshot>;
  listThreads(): Promise<CodexThreadDescriptor[]>;
  readThread(threadId: string): Promise<CodexThreadDescriptor | null>;
  resumeThread(threadId: string): Promise<CodexThreadDescriptor>;
  dispose(): Promise<void>;
  onNotification(listener: (notification: CodexRuntimeNotification) => void): () => void;
}
