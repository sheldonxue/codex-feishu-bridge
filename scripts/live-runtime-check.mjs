#!/usr/bin/env node

const baseUrl = process.env.BRIDGE_BASE_URL ?? "http://127.0.0.1:8787";
const args = process.argv.slice(2);

function parseArgs(argv) {
  const options = {
    createThread: false,
    workspaceRoot: process.cwd(),
    title: `Live validation ${new Date().toISOString()}`,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--create-thread":
        options.createThread = true;
        break;
      case "--workspace-root":
        index += 1;
        options.workspaceRoot = argv[index] ?? options.workspaceRoot;
        break;
      case "--title":
        index += 1;
        options.title = argv[index] ?? options.title;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${value}`);
    }
  }

  return options;
}

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
    throw new Error(`Request failed (${response.status}) ${pathname}: ${body}`);
  }

  return response.json();
}

function printUsage() {
  console.log(`codex-feishu-bridge live runtime check

Usage:
  node scripts/live-runtime-check.mjs
  node scripts/live-runtime-check.mjs --create-thread
  node scripts/live-runtime-check.mjs --create-thread --workspace-root /workspace/codex-feishu-bridge
  node scripts/live-runtime-check.mjs --create-thread --title "Live validation task"

Notes:
  - Default mode is read-only and does not create a thread.
  - --create-thread creates and resumes a real thread without sending a prompt.
  - This helper does not send turn content, so it avoids model-token usage by default.
`);
}

function printSection(title, value) {
  console.log(`\n## ${title}`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const options = parseArgs(args);

  console.log(`# Live Runtime Check`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Mode: ${options.createThread ? "create-thread" : "read-only"}`);

  const health = await request("/health");
  const account = await request("/auth/account");
  const rateLimits = await request("/auth/rate-limits");
  const tasks = await request("/tasks");

  printSection("Health", health);
  printSection("Account", account);
  printSection("Rate Limits", rateLimits);
  printSection("Tasks Summary", {
    taskCount: tasks.tasks.length,
    taskIds: tasks.tasks.map((task) => task.taskId),
  });

  if (!options.createThread) {
    console.log("\nRead-only validation completed.");
    console.log("Skipped thread creation and turn actions.");
    return;
  }

  const created = await request("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: options.title,
      workspaceRoot: options.workspaceRoot,
      prompt: "",
    }),
  });

  const resumed = await request(`/tasks/${encodeURIComponent(created.task.taskId)}/resume`, {
    method: "POST",
  });

  const imported = await request("/tasks/import", {
    method: "POST",
    body: JSON.stringify({
      threadId: created.task.threadId,
    }),
  });

  printSection("Created Task", {
    taskId: created.task.taskId,
    threadId: created.task.threadId,
    status: created.task.status,
    workspaceRoot: created.task.workspaceRoot,
  });
  printSection("Resumed Task", {
    taskId: resumed.task.taskId,
    status: resumed.task.status,
    activeTurnId: resumed.task.activeTurnId ?? null,
  });
  printSection("Imported Thread", {
    importedCount: imported.tasks.length,
    taskIds: imported.tasks.map((task) => task.taskId),
  });

  console.log("\nCreate-thread validation completed.");
  console.log("No prompt was sent, so this path should not consume model tokens.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("If you are running inside workspace-dev, set BRIDGE_BASE_URL=http://bridge-runtime:8787.");
  process.exitCode = 1;
});
