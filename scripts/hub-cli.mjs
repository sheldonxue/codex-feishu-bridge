#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile, mkdir, rm, stat, writeFile, appendFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HUB_VERSION = 1;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_HUB_ROOT =
  process.env.CODEX_FEISHU_BRIDGE_HUB_ROOT ?? path.resolve(REPO_ROOT, "..", `${path.basename(REPO_ROOT)}-hub`);
const DEFAULT_LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_ATTEMPTS = 200;
const AGENTS = [
  "coordinator-agent",
  "runtime-agent",
  "feishu-agent",
  "desktop-agent",
  "qa-agent",
];
const THREAD_CLOSING_KINDS = new Set(["done"]);
const MESSAGE_KINDS = new Set([
  "handoff",
  "needs-input",
  "blocked",
  "ack",
  "done",
  "decision-needed",
  "fyi",
  "ready-for-merge",
  "broadcast",
]);
const WORKTREE_TO_AGENT = new Map([
  ["codex-feishu-bridge-coordinator", "coordinator-agent"],
  ["codex-feishu-bridge-runtime", "runtime-agent"],
  ["codex-feishu-bridge-feishu", "feishu-agent"],
  ["codex-feishu-bridge-desktop", "desktop-agent"],
  ["codex-feishu-bridge-qa", "qa-agent"],
]);

const [command = "help", ...argv] = process.argv.slice(2);

function printUsage() {
  console.log(`codex-feishu-bridge hub CLI

Usage:
  node scripts/hub-cli.mjs init [--hub-root PATH]
  node scripts/hub-cli.mjs post --from AGENT --to AGENT --kind KIND --summary TEXT [--body TEXT | --body-file FILE] [--thread THREAD_ID]
  node scripts/hub-cli.mjs broadcast --from AGENT --summary TEXT [--body TEXT | --body-file FILE]
  node scripts/hub-cli.mjs read [--agent AGENT] [--thread THREAD_ID] [--broadcast]
  node scripts/hub-cli.mjs ack --agent AGENT --thread THREAD_ID --summary TEXT [--body TEXT | --body-file FILE]
  node scripts/hub-cli.mjs done --agent AGENT --thread THREAD_ID --summary TEXT [--body TEXT | --body-file FILE]
  node scripts/hub-cli.mjs status [--agent AGENT]
  node scripts/hub-cli.mjs doctor
  node scripts/hub-cli.mjs render [--agent AGENT]

Environment:
  CODEX_FEISHU_BRIDGE_HUB_ROOT  Override the shared hub directory
  CODEX_HUB_AGENT               Default current agent when --agent is omitted
`);
}

function parseArgs(input) {
  const options = {
    artifacts: [],
    refs: [],
  };

  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    switch (value) {
      case "--hub-root":
        index += 1;
        options.hubRoot = input[index];
        break;
      case "--agent":
        index += 1;
        options.agent = input[index];
        break;
      case "--from":
        index += 1;
        options.from = input[index];
        break;
      case "--to":
        index += 1;
        options.to = input[index];
        break;
      case "--kind":
        index += 1;
        options.kind = input[index];
        break;
      case "--summary":
        index += 1;
        options.summary = input[index];
        break;
      case "--body":
        index += 1;
        options.body = input[index];
        break;
      case "--body-file":
        index += 1;
        options.bodyFile = input[index];
        break;
      case "--thread":
        index += 1;
        options.thread = input[index];
        break;
      case "--artifact":
        index += 1;
        options.artifacts.push(input[index]);
        break;
      case "--ref":
        index += 1;
        options.refs.push(input[index]);
        break;
      case "--broadcast":
        options.broadcast = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${value}`);
    }
  }

  return options;
}

function resolveHubRoot(options) {
  return path.resolve(options.hubRoot ?? DEFAULT_HUB_ROOT);
}

function resolveAgent(agent) {
  const value = agent ?? process.env.CODEX_HUB_AGENT ?? inferAgentFromCwd();
  if (!value) {
    throw new Error("Unable to determine agent. Pass --agent or set CODEX_HUB_AGENT.");
  }
  if (!AGENTS.includes(value)) {
    throw new Error(`Unknown agent: ${value}`);
  }
  return value;
}

function inferAgentFromCwd() {
  const cwd = process.cwd();
  for (const [basename, agent] of WORKTREE_TO_AGENT.entries()) {
    if (cwd.includes(`/${basename}`) || cwd.endsWith(basename)) {
      return agent;
    }
  }
  return null;
}

function createHubPaths(hubRoot) {
  return {
    hubRoot,
    readmePath: path.join(hubRoot, "README.md"),
    configPath: path.join(hubRoot, "config.json"),
    broadcastPath: path.join(hubRoot, "broadcast.jsonl"),
    mailboxDir: path.join(hubRoot, "mailbox"),
    viewsDir: path.join(hubRoot, "views"),
    artifactsDir: path.join(hubRoot, "artifacts"),
    lockPath: path.join(hubRoot, ".hub.lock"),
  };
}

function mailboxPath(paths, agent) {
  return path.join(paths.mailboxDir, `${agent}.jsonl`);
}

function viewPath(paths, agent) {
  return path.join(paths.viewsDir, `${agent}.md`);
}

function broadcastViewPath(paths) {
  return path.join(paths.viewsDir, "broadcast.md");
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function ensureFile(filePath, initialContent) {
  try {
    await writeFile(filePath, initialContent, { flag: "wx" });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
  }
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function loadJsonLines(filePath) {
  const content = await readOptionalFile(filePath);
  if (!content.trim()) {
    return [];
  }

  return content
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL in ${filePath} at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function indentBody(body) {
  if (!body) {
    return "_No body provided._";
  }
  return body
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatList(values) {
  if (!values || values.length === 0) {
    return "_None_";
  }
  return values.map((value) => `- ${value}`).join("\n");
}

function sortByCreatedAt(records) {
  return [...records].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function groupThreads(records) {
  const threads = new Map();
  for (const record of sortByCreatedAt(records)) {
    if (!threads.has(record.threadId)) {
      threads.set(record.threadId, []);
    }
    threads.get(record.threadId).push(record);
  }
  return threads;
}

function summarizeThread(records, agent) {
  const ordered = sortByCreatedAt(records);
  const latest = ordered.at(-1);
  const participants = Array.from(new Set(ordered.flatMap((record) => [record.from, record.to]).filter(Boolean)));
  return {
    threadId: latest.threadId,
    latestKind: latest.kind,
    latestAt: latest.createdAt,
    latestSummary: latest.summary,
    latestFrom: latest.from,
    latestTo: latest.to,
    participants,
    open: !THREAD_CLOSING_KINDS.has(latest.kind),
    visibleTo: agent,
  };
}

function renderThreadMarkdown(summary, records) {
  const lines = [
    `## ${summary.threadId} ${summary.open ? "[open]" : "[closed]"}`,
    `- latest: ${summary.latestAt}`,
    `- latest_kind: ${summary.latestKind}`,
    `- latest_summary: ${summary.latestSummary}`,
    `- participants: ${summary.participants.join(", ")}`,
    "",
  ];

  for (const record of sortByCreatedAt(records)) {
    lines.push(`### ${record.createdAt} ${record.kind} ${record.from} -> ${record.to ?? "broadcast"}`);
    lines.push(`- summary: ${record.summary}`);
    if (record.refs?.length) {
      lines.push("- refs:");
      lines.push(...record.refs.map((value) => `  - ${value}`));
    }
    if (record.artifacts?.length) {
      lines.push("- artifacts:");
      lines.push(...record.artifacts.map((value) => `  - ${value}`));
    }
    lines.push(indentBody(record.body));
    lines.push("");
  }

  return lines.join("\n");
}

async function renderMailboxView(paths, agent, mailboxRecords, broadcastRecords) {
  const threads = groupThreads(mailboxRecords);
  const summaries = Array.from(threads.values()).map((records) => summarizeThread(records, agent));
  const openThreads = summaries.filter((summary) => summary.open).sort((left, right) => right.latestAt.localeCompare(left.latestAt));
  const closedThreads = summaries.filter((summary) => !summary.open).sort((left, right) => right.latestAt.localeCompare(left.latestAt));
  const recentBroadcasts = sortByCreatedAt(broadcastRecords).slice(-5).reverse();

  const sections = [
    `# ${agent} mailbox`,
    "",
    `- hub_root: ${paths.hubRoot}`,
    `- generated_at: ${new Date().toISOString()}`,
    `- open_threads: ${openThreads.length}`,
    "",
    "## Operator Reminder",
    "",
    "- Read this view before each work round.",
    "- Use the hub CLI for handoffs, acknowledgements, and completion updates.",
    "- Stable project memory still lives in the repository docs.",
    "",
    "## Recent Broadcasts",
    "",
  ];

  if (recentBroadcasts.length === 0) {
    sections.push("_No broadcasts yet._", "");
  } else {
    for (const record of recentBroadcasts) {
      sections.push(`- ${record.createdAt} ${record.from}: ${record.summary}`);
    }
    sections.push("");
  }

  sections.push("## Open Threads", "");
  if (openThreads.length === 0) {
    sections.push("_No open threads._", "");
  } else {
    for (const summary of openThreads) {
      sections.push(renderThreadMarkdown(summary, threads.get(summary.threadId)));
    }
  }

  sections.push("## Closed Threads", "");
  if (closedThreads.length === 0) {
    sections.push("_No closed threads yet._", "");
  } else {
    for (const summary of closedThreads.slice(0, 10)) {
      sections.push(renderThreadMarkdown(summary, threads.get(summary.threadId)));
    }
  }

  await writeFile(viewPath(paths, agent), `${sections.join("\n").trimEnd()}\n`);
}

async function renderBroadcastView(paths, broadcastRecords) {
  const sections = [
    "# broadcast",
    "",
    `- hub_root: ${paths.hubRoot}`,
    `- generated_at: ${new Date().toISOString()}`,
    "",
    "## Broadcast Events",
    "",
  ];

  const records = sortByCreatedAt(broadcastRecords).reverse();
  if (records.length === 0) {
    sections.push("_No broadcast events yet._");
  } else {
    for (const record of records) {
      sections.push(`## ${record.threadId}`);
      sections.push(`- created_at: ${record.createdAt}`);
      sections.push(`- from: ${record.from}`);
      sections.push(`- kind: ${record.kind}`);
      sections.push(`- summary: ${record.summary}`);
      if (record.refs?.length) {
        sections.push("- refs:");
        sections.push(...record.refs.map((value) => `  - ${value}`));
      }
      if (record.artifacts?.length) {
        sections.push("- artifacts:");
        sections.push(...record.artifacts.map((value) => `  - ${value}`));
      }
      sections.push(indentBody(record.body), "");
    }
  }

  await writeFile(broadcastViewPath(paths), `${sections.join("\n").trimEnd()}\n`);
}

async function renderViews(paths, filterAgent = null) {
  const broadcastRecords = await loadJsonLines(paths.broadcastPath);
  await renderBroadcastView(paths, broadcastRecords);

  const targetAgents = filterAgent ? [filterAgent] : AGENTS;
  for (const agent of targetAgents) {
    const mailboxRecords = await loadJsonLines(mailboxPath(paths, agent));
    await renderMailboxView(paths, agent, mailboxRecords, broadcastRecords);
  }
}

async function acquireLock(paths) {
  await mkdir(paths.hubRoot, { recursive: true });
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(paths.lockPath);
      await writeFile(path.join(paths.lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }, null, 2));
      return;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }

      const lockStats = await stat(paths.lockPath).catch(() => null);
      const ageMs = lockStats ? Date.now() - lockStats.mtimeMs : 0;
      if (lockStats && ageMs > DEFAULT_LOCK_STALE_MS) {
        await rm(paths.lockPath, { recursive: true, force: true });
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  throw new Error(`Timed out waiting for hub lock at ${paths.lockPath}`);
}

async function releaseLock(paths) {
  await rm(paths.lockPath, { recursive: true, force: true });
}

async function withLock(paths, callback) {
  await acquireLock(paths);
  try {
    return await callback();
  } finally {
    await releaseLock(paths);
  }
}

async function ensureHub(paths) {
  await mkdir(paths.hubRoot, { recursive: true });
  await mkdir(paths.mailboxDir, { recursive: true });
  await mkdir(paths.viewsDir, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });

  const config = {
    version: HUB_VERSION,
    hubRoot: paths.hubRoot,
    agents: AGENTS,
    generatedBy: "scripts/hub-cli.mjs",
    updatedAt: new Date().toISOString(),
  };

  await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(paths.readmePath, createReadme(paths));
  await ensureFile(paths.broadcastPath, "");

  for (const agent of AGENTS) {
    await ensureFile(mailboxPath(paths, agent), "");
    await ensureFile(viewPath(paths, agent), "");
  }
  await ensureFile(broadcastViewPath(paths), "");
  await renderViews(paths);
}

function createReadme(paths) {
  return `# codex-feishu-bridge shared hub

This directory is the shared communication hub for the multi-agent worktree workflow.

- hub_root: ${paths.hubRoot}
- agents: ${AGENTS.join(", ")}
- machine truth: \`broadcast.jsonl\` and \`mailbox/*.jsonl\`
- readable views: \`views/*.md\`

Rules:

1. Do not hand-edit \`jsonl\` files. Use \`node scripts/hub-cli.mjs ...\`.
2. Treat mailbox and broadcast files as append-only logs.
3. Use repository docs for stable architecture and status, not for live mailbox traffic.
4. Read your own mailbox view before each work round.
`;
}

async function readBody(options) {
  if (options.body && options.bodyFile) {
    throw new Error("Use either --body or --body-file, not both.");
  }
  if (options.bodyFile) {
    return readFile(path.resolve(options.bodyFile), "utf8");
  }
  return options.body ?? "";
}

function validateKind(kind, commandName) {
  if (!kind) {
    throw new Error(`${commandName} requires --kind`);
  }
  if (!MESSAGE_KINDS.has(kind)) {
    throw new Error(`Unknown kind: ${kind}`);
  }
}

async function appendRecord(filePath, record) {
  await appendFile(filePath, `${JSON.stringify(record)}\n`);
}

async function findThreadRecords(paths, agent, threadId) {
  const records = await loadJsonLines(mailboxPath(paths, agent));
  return records.filter((record) => record.threadId === threadId);
}

function resolveThreadCounterpart(threadRecords, actor) {
  const participants = Array.from(new Set(threadRecords.flatMap((record) => [record.from, record.to]).filter(Boolean)));
  const others = participants.filter((participant) => participant !== actor);
  if (others.length !== 1) {
    throw new Error(`Thread is not a direct agent conversation for ${actor}`);
  }
  return others[0];
}

async function commandInit(options) {
  const hubRoot = resolveHubRoot(options);
  const paths = createHubPaths(hubRoot);
  await withLock(paths, async () => {
    await ensureHub(paths);
  });
  console.log(JSON.stringify({
    ok: true,
    hubRoot,
    agents: AGENTS,
  }, null, 2));
}

async function commandPost(options) {
  const from = resolveAgent(options.from);
  const to = resolveAgent(options.to);
  validateKind(options.kind, "post");
  if (options.kind === "broadcast") {
    throw new Error("Use the broadcast command for kind=broadcast");
  }
  if (!options.summary) {
    throw new Error("post requires --summary");
  }

  const hubRoot = resolveHubRoot(options);
  const paths = createHubPaths(hubRoot);
  const body = await readBody(options);
  const record = {
    id: randomUUID(),
    threadId: options.thread ?? randomUUID(),
    createdAt: new Date().toISOString(),
    from,
    to,
    kind: options.kind,
    summary: options.summary,
    body,
    artifacts: options.artifacts,
    refs: options.refs,
  };

  await withLock(paths, async () => {
    await ensureHub(paths);
    await appendRecord(mailboxPath(paths, from), record);
    if (to !== from) {
      await appendRecord(mailboxPath(paths, to), record);
    }
    await renderViews(paths, from);
    if (to !== from) {
      await renderViews(paths, to);
    }
  });

  console.log(JSON.stringify(record, null, 2));
}

async function commandBroadcast(options) {
  const from = resolveAgent(options.from);
  if (!options.summary) {
    throw new Error("broadcast requires --summary");
  }

  const hubRoot = resolveHubRoot(options);
  const paths = createHubPaths(hubRoot);
  const body = await readBody(options);
  const record = {
    id: randomUUID(),
    threadId: options.thread ?? randomUUID(),
    createdAt: new Date().toISOString(),
    from,
    to: null,
    kind: "broadcast",
    summary: options.summary,
    body,
    artifacts: options.artifacts,
    refs: options.refs,
  };

  await withLock(paths, async () => {
    await ensureHub(paths);
    await appendRecord(paths.broadcastPath, record);
    await renderViews(paths);
  });

  console.log(JSON.stringify(record, null, 2));
}

async function commandRead(options) {
  const hubRoot = resolveHubRoot(options);
  const paths = createHubPaths(hubRoot);
  await ensureHub(paths);

  if (options.broadcast) {
    process.stdout.write(await readOptionalFile(broadcastViewPath(paths)));
    return;
  }

  const agent = resolveAgent(options.agent);
  if (!options.thread) {
    process.stdout.write(await readOptionalFile(viewPath(paths, agent)));
    return;
  }

  const records = await findThreadRecords(paths, agent, options.thread);
  if (records.length === 0) {
    throw new Error(`No thread ${options.thread} found for ${agent}`);
  }
  const summary = summarizeThread(records, agent);
  process.stdout.write(`${renderThreadMarkdown(summary, records).trimEnd()}\n`);
}

async function commandAckOrDone(options, kind) {
  const agent = resolveAgent(options.agent);
  if (!options.thread) {
    throw new Error(`${kind} requires --thread`);
  }
  if (!options.summary) {
    throw new Error(`${kind} requires --summary`);
  }

  const hubRoot = resolveHubRoot(options);
  const paths = createHubPaths(hubRoot);
  const body = await readBody(options);

  let record;
  await withLock(paths, async () => {
    await ensureHub(paths);
    const threadRecords = await findThreadRecords(paths, agent, options.thread);
    if (threadRecords.length === 0) {
      throw new Error(`No thread ${options.thread} found for ${agent}`);
    }

    const counterpart = resolveThreadCounterpart(threadRecords, agent);
    record = {
      id: randomUUID(),
      threadId: options.thread,
      createdAt: new Date().toISOString(),
      from: agent,
      to: counterpart,
      kind,
      summary: options.summary,
      body,
      artifacts: options.artifacts,
      refs: options.refs,
    };

    await appendRecord(mailboxPath(paths, agent), record);
    if (counterpart !== agent) {
      await appendRecord(mailboxPath(paths, counterpart), record);
    }
    await renderViews(paths, agent);
    if (counterpart !== agent) {
      await renderViews(paths, counterpart);
    }
  });

  console.log(JSON.stringify(record, null, 2));
}

async function commandStatus(options) {
  const hubRoot = resolveHubRoot(options);
  const paths = createHubPaths(hubRoot);
  await ensureHub(paths);

  const targetAgents = options.agent ? [resolveAgent(options.agent)] : AGENTS;
  const agents = [];
  for (const agent of targetAgents) {
    const records = await loadJsonLines(mailboxPath(paths, agent));
    const threads = groupThreads(records);
    const summaries = Array.from(threads.values()).map((threadRecords) => summarizeThread(threadRecords, agent));
    agents.push({
      agent,
      openThreadCount: summaries.filter((summary) => summary.open).length,
      threads: summaries.sort((left, right) => right.latestAt.localeCompare(left.latestAt)),
    });
  }

  const result = {
    ok: true,
    hubRoot,
    generatedAt: new Date().toISOString(),
    agents,
  };

  console.log(JSON.stringify(result, null, 2));
}

async function commandDoctor(options) {
  const hubRoot = resolveHubRoot(options);
  const paths = createHubPaths(hubRoot);
  const issues = [];
  const checks = [];

  const rootExists = await pathExists(paths.hubRoot);
  checks.push({ name: "hubRoot", ok: rootExists, path: paths.hubRoot });
  if (!rootExists) {
    issues.push(`Hub root does not exist: ${paths.hubRoot}`);
  }

  if (rootExists) {
    for (const targetPath of [paths.configPath, paths.broadcastPath, paths.mailboxDir, paths.viewsDir, paths.artifactsDir]) {
      const exists = await pathExists(targetPath);
      checks.push({ name: path.basename(targetPath), ok: exists, path: targetPath });
      if (!exists) {
        issues.push(`Missing hub path: ${targetPath}`);
      }
    }

    for (const agent of AGENTS) {
      const mailbox = mailboxPath(paths, agent);
      const view = viewPath(paths, agent);
      const mailboxExists = await pathExists(mailbox);
      const viewExists = await pathExists(view);
      checks.push({ name: `${agent}.jsonl`, ok: mailboxExists, path: mailbox });
      checks.push({ name: `${agent}.md`, ok: viewExists, path: view });
      if (!mailboxExists) {
        issues.push(`Missing mailbox for ${agent}`);
      }
      if (!viewExists) {
        issues.push(`Missing view for ${agent}`);
      }
      if (mailboxExists) {
        try {
          await loadJsonLines(mailbox);
        } catch (error) {
          issues.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    if (await pathExists(paths.broadcastPath)) {
      try {
        await loadJsonLines(paths.broadcastPath);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (await pathExists(paths.lockPath)) {
    const lockStats = await stat(paths.lockPath);
    const stale = Date.now() - lockStats.mtimeMs > DEFAULT_LOCK_STALE_MS;
    checks.push({
      name: "lock",
      ok: !stale,
      path: paths.lockPath,
      stale,
    });
    if (stale) {
      issues.push(`Stale lock detected: ${paths.lockPath}`);
    }
  } else {
    checks.push({
      name: "lock",
      ok: true,
      path: paths.lockPath,
      stale: false,
    });
  }

  const result = {
    ok: issues.length === 0,
    hubRoot,
    checks,
    issues,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function commandRender(options) {
  const hubRoot = resolveHubRoot(options);
  const paths = createHubPaths(hubRoot);
  const agent = options.agent ? resolveAgent(options.agent) : null;
  await withLock(paths, async () => {
    await ensureHub(paths);
    await renderViews(paths, agent);
  });
  console.log(JSON.stringify({
    ok: true,
    hubRoot,
    rendered: agent ? [agent, "broadcast"] : [...AGENTS, "broadcast"],
  }, null, 2));
}

try {
  const options = parseArgs(argv);

  if (options.help || command === "help") {
    printUsage();
    process.exit(0);
  }

  switch (command) {
    case "init":
      await commandInit(options);
      break;
    case "post":
      await commandPost(options);
      break;
    case "broadcast":
      await commandBroadcast(options);
      break;
    case "read":
      await commandRead(options);
      break;
    case "ack":
      await commandAckOrDone(options, "ack");
      break;
    case "done":
      await commandAckOrDone(options, "done");
      break;
    case "status":
      await commandStatus(options);
      break;
    case "doctor":
      await commandDoctor(options);
      break;
    case "render":
      await commandRender(options);
      break;
    default:
      printUsage();
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
