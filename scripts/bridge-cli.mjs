#!/usr/bin/env node

const baseUrl = process.env.BRIDGE_BASE_URL ?? "http://127.0.0.1:8787";
const [command = "help", ...args] = process.argv.slice(2);

async function request(pathname, init) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Bridge CLI request failed (${response.status}): ${body}`);
  }

  return response.json();
}

function printUsage() {
  console.log(`codex-feishu-bridge CLI

Usage:
  node scripts/bridge-cli.mjs list
  node scripts/bridge-cli.mjs import [threadId]
  node scripts/bridge-cli.mjs resume <taskId>
  node scripts/bridge-cli.mjs send <taskId> <message>
`);
}

switch (command) {
  case "list": {
    const result = await request("/tasks");
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  case "import": {
    const [threadId] = args;
    const result = await request("/tasks/import", {
      method: "POST",
      body: JSON.stringify(threadId ? { threadId } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  case "resume": {
    const [taskId] = args;
    if (!taskId) {
      throw new Error("resume requires a taskId");
    }
    const result = await request(`/tasks/${encodeURIComponent(taskId)}/resume`, {
      method: "POST",
    });
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  case "send": {
    const [taskId, ...messageParts] = args;
    if (!taskId || messageParts.length === 0) {
      throw new Error("send requires a taskId and a message");
    }
    const result = await request(`/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: messageParts.join(" "),
      }),
    });
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  default:
    printUsage();
    if (command !== "help") {
      process.exitCode = 1;
    }
}
