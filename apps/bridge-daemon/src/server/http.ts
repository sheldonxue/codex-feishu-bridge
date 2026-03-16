import http, { type IncomingMessage, type ServerResponse } from "node:http";

import type { BridgeConfig, Logger } from "@codex-feishu-bridge/shared";

import type { CodexRuntime } from "../runtime";

interface BridgeHttpServerOptions {
  config: BridgeConfig;
  logger: Logger;
  runtime: CodexRuntime;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export function createBridgeHttpServer(options: BridgeHttpServerOptions): http.Server {
  const { config, logger, runtime } = options;

  return http.createServer(async (request, response) => {
    try {
      if (!request.url || !request.method) {
        sendJson(response, 400, { error: "invalid request" });
        return;
      }

      const url = new URL(request.url, `http://${request.headers.host ?? `${config.host}:${config.port}`}`);

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          runtime: await runtime.health(),
          codexHome: config.codexHome,
          uploadsDir: config.uploadsDir,
          publicBaseUrl: config.publicBaseUrl ?? null,
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

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      logger.error("bridge http request failed", error);
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  });
}
