import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

import type { BridgeConfig, Logger } from "@codex-feishu-bridge/shared";

type JsonRpcId = number;

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
  id?: JsonRpcId;
}

export class JsonRpcStdioClient {
  private readonly emitter = new EventEmitter();
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private nextId = 1;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    this.child = spawn(this.config.codexExecutable, this.config.codexArgs, {
      cwd: this.config.workspaceRoot,
      env: {
        ...process.env,
        CODEX_HOME: this.config.codexHome,
      },
      stdio: "pipe",
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.logger.warn("codex app-server stderr", chunk.toString("utf8"));
    });

    this.child.once("exit", (code, signal) => {
      const error = new Error(`codex app-server exited with code=${code} signal=${signal}`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.initialized = false;
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex_feishu_bridge",
        title: "Codex Feishu Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }

    this.child.kill();
    this.child = null;
    this.initialized = false;
  }

  async request<TResponse>(method: string, params?: unknown): Promise<TResponse> {
    await this.start();

    if (!this.child) {
      throw new Error("codex app-server is not available");
    }

    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    const result = new Promise<TResponse>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as TResponse),
        reject,
      });
    });

    this.writePayload(payload);

    return result;
  }

  notify(method: string, params?: unknown): void {
    if (!this.child) {
      return;
    }

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });

    this.writePayload(payload);
  }

  respond(id: JsonRpcId | string, result: unknown): void {
    if (!this.child) {
      return;
    }

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      result,
    });

    this.writePayload(payload);
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.emitter.on("notification", listener);
    return () => {
      this.emitter.off("notification", listener);
    };
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private writePayload(payload: string): void {
    this.child?.stdin.write(`${payload}\n`, "utf8");
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: JsonRpcResponse | JsonRpcNotification;
    try {
      message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    } catch (error) {
      this.logger.warn("failed to parse codex app-server message", {
        line,
        error,
      });
      return;
    }

    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    this.emitter.emit("notification", message);
  }
}
