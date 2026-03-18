import http, { type IncomingMessage, type ServerResponse } from "node:http";

import type { BridgeConfig, Logger } from "@codex-feishu-bridge/shared";
import { WebSocketServer, type WebSocket } from "ws";

import { FeishuBridge } from "../feishu/bridge";
import type { CodexRuntime } from "../runtime";
import {
  BridgeService,
  type BridgeServiceSnapshot,
  type CreateTaskRequest,
  type TaskSettingsRequest,
  type TaskMessageRequest,
  type UploadImageRequest,
} from "../service/bridge-service";

interface BridgeHttpServerOptions {
  config: BridgeConfig;
  feishu?: FeishuBridge;
  logger: Logger;
  runtime: CodexRuntime;
  service: BridgeService;
}

type JsonObject = Record<string, unknown>;

async function readBodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return "";
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const body = await readBodyText(request);
  if (!body) {
    return {} as T;
  }

  return JSON.parse(body) as T;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendWsJson(socket: WebSocket, body: unknown): void {
  socket.send(JSON.stringify(body));
}

function snapshotPayload(snapshot: BridgeServiceSnapshot): JsonObject {
  return {
    type: "snapshot",
    snapshot,
  };
}

function eventPayload(event: unknown): JsonObject {
  return {
    type: "event",
    event,
  };
}

function notFound(response: ServerResponse): void {
  sendJson(response, 404, { error: "not found" });
}

export function createBridgeHttpServer(options: BridgeHttpServerOptions): http.Server {
  const { config, feishu, logger, runtime, service } = options;
  const websocketServer = new WebSocketServer({ noServer: true });

  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url || !request.method) {
        sendJson(response, 400, { error: "invalid request" });
        return;
      }

      const url = new URL(request.url, `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
      const segments = url.pathname.split("/").filter(Boolean);

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          runtime: await runtime.health(),
          codexHome: config.codexHome,
          uploadsDir: config.uploadsDir,
          publicBaseUrl: config.publicBaseUrl ?? null,
          wsPath: config.wsPath,
          tasks: service.listTasks().length,
          feishuEnabled: feishu?.enabled ?? false,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/auth/login/start") {
        const body = await readJsonBody<{ type?: "chatgpt" | "apiKey" | "chatgptAuthTokens"; apiKey?: string }>(
          request,
        );

        const result = await runtime.loginStart({
          type: body.type ?? "chatgpt",
          apiKey: body.apiKey,
        });

        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/auth/account") {
        sendJson(response, 200, await runtime.readAccount(false));
        return;
      }

      if (request.method === "GET" && url.pathname === "/auth/rate-limits") {
        sendJson(response, 200, await runtime.readRateLimits());
        return;
      }

      if (request.method === "GET" && url.pathname === "/tasks") {
        const tasks = await service.syncRuntimeThreads();
        sendJson(response, 200, {
          tasks,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/tasks") {
        const body = await readJsonBody<CreateTaskRequest>(request);
        if (!body.title?.trim()) {
          sendJson(response, 400, { error: "title is required" });
          return;
        }

        const task = await service.createTask(body);
        sendJson(response, 201, { task });
        return;
      }

      if (request.method === "POST" && url.pathname === "/tasks/import") {
        const body = await readJsonBody<{ threadId?: string }>(request);
        const tasks = await service.importThreads(body.threadId);
        sendJson(response, 200, { tasks });
        return;
      }

      if (request.method === "POST" && url.pathname === "/feishu/webhook") {
        if (!feishu?.webhookEnabled) {
          sendJson(response, 503, { error: "feishu webhook is not configured" });
          return;
        }

        const rawBody = await readBodyText(request);
        const result = await feishu.handleWebhook(rawBody, {
          signature: request.headers["x-lark-signature"]?.toString(),
          timestamp: request.headers["x-lark-request-timestamp"]?.toString(),
          nonce: request.headers["x-lark-request-nonce"]?.toString(),
        });
        sendJson(response, result.statusCode, result.body);
        return;
      }

      if (segments[0] === "tasks" && segments[1]) {
        const taskId = decodeURIComponent(segments[1]);

        if (request.method === "GET" && segments.length === 2) {
          const task = service.getTask(taskId);
          if (!task) {
            notFound(response);
            return;
          }

          sendJson(response, 200, { task });
          return;
        }

        if (request.method === "POST" && segments.length === 3 && segments[2] === "resume") {
          const task = await service.resumeTask(taskId);
          sendJson(response, 200, { task });
          return;
        }

        if (request.method === "POST" && segments.length === 3 && segments[2] === "messages") {
          const body = await readJsonBody<TaskMessageRequest>(request);
          const task = await service.sendMessage(taskId, {
            content: body.content ?? "",
            imageAssetIds: body.imageAssetIds ?? [],
            source: body.source,
            replyToFeishu: body.replyToFeishu,
          });
          sendJson(response, 200, { task });
          return;
        }

        if (request.method === "POST" && segments.length === 3 && segments[2] === "settings") {
          const body = await readJsonBody<TaskSettingsRequest>(request);
          const task = await service.updateTaskSettings(taskId, body);
          sendJson(response, 200, { task });
          return;
        }

        if (request.method === "POST" && segments.length === 3 && segments[2] === "interrupt") {
          const task = await service.interruptTask(taskId);
          sendJson(response, 200, { task });
          return;
        }

        if (request.method === "POST" && segments.length === 3 && segments[2] === "uploads") {
          const body = await readJsonBody<UploadImageRequest>(request);
          const result = await service.uploadTaskImage(taskId, body);
          sendJson(response, 201, result);
          return;
        }

        if (request.method === "POST" && segments.length === 4 && segments[2] === "feishu" && segments[3] === "bind") {
          const body = await readJsonBody<{
            chatId: string;
            threadKey: string;
            rootMessageId?: string;
            webhookTenantKey?: string;
          }>(request);
          const task = await service.bindFeishuThread(taskId, body);
          sendJson(response, 200, { task });
          return;
        }

        if (request.method === "POST" && segments.length === 4 && segments[2] === "feishu" && segments[3] === "unbind") {
          const task = await service.unbindFeishuThread(taskId);
          sendJson(response, 200, { task });
          return;
        }

        if (
          request.method === "POST" &&
          segments.length === 5 &&
          segments[2] === "approvals" &&
          segments[4] === "resolve"
        ) {
          const body = await readJsonBody<{ decision?: "accept" | "acceptForSession" | "decline" | "cancel" }>(
            request,
          );
          if (!body.decision) {
            sendJson(response, 400, { error: "decision is required" });
            return;
          }

          const requestId = decodeURIComponent(segments[3]);
          const task = await service.resolveApproval(taskId, requestId, body.decision);
          sendJson(response, 200, { task });
          return;
        }
      }

      notFound(response);
    } catch (error) {
      logger.error("bridge http request failed", error);
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  });

  const unsubscribe = service.subscribe(({ event, snapshot }) => {
    for (const socket of websocketServer.clients) {
      if (socket.readyState !== socket.OPEN) {
        continue;
      }

      sendWsJson(socket, eventPayload(event));
      sendWsJson(socket, snapshotPayload(snapshot));
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
    if (url.pathname !== config.wsPath) {
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (socket: WebSocket) => {
    sendWsJson(socket, snapshotPayload(service.getSnapshot()));
  });

  server.on("close", () => {
    unsubscribe();
    websocketServer.close();
  });

  return server;
}
