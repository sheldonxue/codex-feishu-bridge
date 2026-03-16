#!/usr/bin/env node

import readline from "node:readline";

const threads = new Map([
  [
    "thread-live-shape",
    {
      id: "thread-live-shape",
      name: "Live Shape Thread",
      cwd: "/workspace/codex-feishu-bridge",
      createdAt: 1773700000,
      updatedAt: 1773700600,
      status: {
        type: "notLoaded",
      },
    },
  ],
]);

const requests = [];

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function threadPayload(thread) {
  return {
    cliVersion: "0.115.0-alpha.11",
    createdAt: thread.createdAt,
    cwd: thread.cwd,
    ephemeral: false,
    id: thread.id,
    modelProvider: "openai",
    name: thread.name,
    preview: "Thread preview",
    source: "appServer",
    status: thread.status,
    turns: [],
    updatedAt: thread.updatedAt,
  };
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  if (!("id" in message) || !message.method) {
    return;
  }

  requests.push({
    id: message.id,
    method: message.method,
    params: message.params ?? null,
  });

  switch (message.method) {
    case "initialize":
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          userAgent: "fake-codex-app-server/0.1.0",
        },
      });
      return;
    case "account/read":
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          account: {
            type: "chatgpt",
            email: "bridge@example.com",
            planType: "plus",
          },
          requiresOpenaiAuth: true,
        },
      });
      return;
    case "account/rateLimits/read":
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          rateLimits: {
            limitId: "codex",
            limitName: null,
            primary: {
              usedPercent: 10,
              windowDurationMins: 300,
              resetsAt: 1773703600,
            },
            secondary: null,
          },
          rateLimitsByLimitId: {},
        },
      });
      return;
    case "thread/list":
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          data: [...threads.values()].map(threadPayload),
          nextCursor: null,
        },
      });
      return;
    case "thread/read": {
      const thread = threads.get(message.params.threadId) ?? null;
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          thread: thread ? threadPayload(thread) : null,
        },
      });
      return;
    }
    case "thread/resume": {
      const thread = threads.get(message.params.threadId) ?? threads.values().next().value;
      thread.status = {
        type: "idle",
      };
      thread.updatedAt = 1773701200;
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          thread: threadPayload(thread),
        },
      });
      return;
    }
    case "thread/start": {
      const thread = {
        id: "thread-created",
        name: null,
        cwd: message.params.cwd ?? "/workspace/codex-feishu-bridge",
        createdAt: 1773701800,
        updatedAt: 1773701800,
        status: {
          type: "active",
          activeFlags: [],
        },
      };
      threads.set(thread.id, thread);
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          thread: threadPayload(thread),
        },
      });
      return;
    }
    case "turn/start":
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          turn: {
            id: "turn-created",
            status: "inProgress",
            items: [],
          },
        },
      });
      writeMessage({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: message.params.threadId,
          turn: {
            id: "turn-created",
            status: "inProgress",
            items: [],
          },
        },
      });
      return;
    case "turn/steer":
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          turnId: message.params.expectedTurnId,
        },
      });
      return;
    case "turn/interrupt":
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: null,
      });
      return;
    case "bridge/test/requests":
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          requests,
        },
      });
      return;
    default:
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Unknown method: ${message.method}`,
        },
      });
  }
});
