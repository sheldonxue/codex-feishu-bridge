import { EventEmitter } from "node:events";

import type { BridgeTask } from "@codex-feishu-bridge/protocol";

import { BridgeClient, type BridgeSocket, type BridgeSocketFrame } from "./bridge-client";
import { applyDaemonSnapshot, createEmptySnapshot, type ExtensionSnapshot } from "./task-model";

export class TaskStore {
  private readonly emitter = new EventEmitter();
  private snapshot: ExtensionSnapshot = createEmptySnapshot();
  private socket: BridgeSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly client: BridgeClient) {}

  getSnapshot(): ExtensionSnapshot {
    return this.snapshot;
  }

  listTasks(): BridgeTask[] {
    return this.snapshot.tasks;
  }

  onDidChange(listener: () => void): () => void {
    this.emitter.on("changed", listener);
    return () => {
      this.emitter.off("changed", listener);
    };
  }

  async start(): Promise<void> {
    await this.refresh();
    this.connectSocket();
  }

  async refresh(): Promise<void> {
    const daemonSnapshot = await this.client.fetchSnapshot();
    this.snapshot = applyDaemonSnapshot(
      this.snapshot,
      {
        ...daemonSnapshot,
        account: daemonSnapshot.account ?? this.snapshot.account,
        rateLimits: daemonSnapshot.rateLimits ?? this.snapshot.rateLimits,
      },
      this.socket ? "connected" : "disconnected",
    );
    this.emitter.emit("changed");
  }

  dispose(): void {
    this.disposed = true;
    this.socket?.close();
    this.socket = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.emitter.removeAllListeners();
  }

  private connectSocket(): void {
    this.snapshot = {
      ...this.snapshot,
      connection: "connecting",
    };
    this.emitter.emit("changed");

    this.socket = this.client.connect(
      (frame) => {
        this.applySocketFrame(frame);
      },
      () => {
        this.socket = null;
        if (this.disposed) {
          return;
        }

        this.snapshot = {
          ...this.snapshot,
          connection: "disconnected",
        };
        this.emitter.emit("changed");
        this.scheduleReconnect();
      },
    );
  }

  private applySocketFrame(frame: BridgeSocketFrame): void {
    if (frame.type === "snapshot") {
      this.snapshot = applyDaemonSnapshot(this.snapshot, frame.snapshot, "connected");
      this.emitter.emit("changed");
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      connection: "connected",
      lastUpdatedAt: frame.event.timestamp,
    };
    this.emitter.emit("changed");
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.refresh().catch(() => undefined);
      this.connectSocket();
    }, 3000);
  }
}
