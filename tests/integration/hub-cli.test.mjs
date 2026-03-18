import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it, beforeEach, afterEach } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "hub-cli.mjs");

let tempRoot;

async function runHub(args, options = {}) {
  const env = {
    ...process.env,
    CODEX_FEISHU_BRIDGE_HUB_ROOT: options.hubRoot ?? path.join(tempRoot, "hub"),
    CODEX_HUB_AGENT: options.agent,
  };
  const { stdout, stderr } = await execFileAsync("node", [scriptPath, ...args], {
    cwd: options.cwd ?? repoRoot,
    env,
  });
  return {
    stdout,
    stderr,
  };
}

async function readText(filePath) {
  return readFile(filePath, "utf8");
}

describe("hub-cli", () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-hub-test-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("initializes the hub directory and default files", async () => {
    const hubRoot = path.join(tempRoot, "hub");
    const { stdout } = await runHub(["init"], { hubRoot });
    const result = JSON.parse(stdout);

    assert.equal(result.ok, true);
    assert.equal(result.hubRoot, hubRoot);

    const files = await readdir(hubRoot);
    assert.ok(files.includes("README.md"));
    assert.ok(files.includes("config.json"));
    assert.ok(files.includes("mailbox"));
    assert.ok(files.includes("views"));
    assert.ok(files.includes("artifacts"));

    const feishuView = await readText(path.join(hubRoot, "views", "feishu-agent.md"));
    assert.match(feishuView, /# feishu-agent mailbox/);
    assert.match(feishuView, /No open threads/);
  });

  it("posts a handoff, mirrors it into both visible mailboxes, and renders views", async () => {
    const hubRoot = path.join(tempRoot, "hub");
    const bodyFile = path.join(tempRoot, "body.md");
    await writeFile(bodyFile, "Validate live webhook flow.\nUse the real callback URL.");

    const { stdout } = await runHub([
      "post",
      "--from",
      "coordinator-agent",
      "--to",
      "feishu-agent",
      "--kind",
      "handoff",
      "--summary",
      "Validate live Feishu ingress",
      "--body-file",
      bodyFile,
      "--ref",
      path.join(repoRoot, "docs", "architecture.md"),
    ], { hubRoot });

    const record = JSON.parse(stdout);
    assert.equal(record.kind, "handoff");

    const status = JSON.parse((await runHub(["status"], { hubRoot })).stdout);
    const feishuSummary = status.agents.find((agent) => agent.agent === "feishu-agent");
    assert.equal(feishuSummary.openThreadCount, 1);
    assert.equal(feishuSummary.threads[0].threadId, record.threadId);

    const feishuView = await readText(path.join(hubRoot, "views", "feishu-agent.md"));
    const coordinatorView = await readText(path.join(hubRoot, "views", "coordinator-agent.md"));
    assert.match(feishuView, /Validate live Feishu ingress/);
    assert.match(coordinatorView, /Validate live Feishu ingress/);

    const focused = (await runHub([
      "read",
      "--agent",
      "feishu-agent",
      "--thread",
      record.threadId,
    ], { hubRoot })).stdout;
    assert.match(focused, /handoff coordinator-agent -> feishu-agent/);
  });

  it("appends broadcast, ack, and done events while keeping history append-only", async () => {
    const hubRoot = path.join(tempRoot, "hub");
    const post = JSON.parse((await runHub([
      "post",
      "--from",
      "coordinator-agent",
      "--to",
      "desktop-agent",
      "--kind",
      "needs-input",
      "--summary",
      "Confirm diff rendering in live daemon mode",
    ], { hubRoot })).stdout);

    await runHub([
      "broadcast",
      "--from",
      "coordinator-agent",
      "--summary",
      "Hub cutover is active",
    ], { hubRoot });

    await runHub([
      "ack",
      "--agent",
      "desktop-agent",
      "--thread",
      post.threadId,
      "--summary",
      "Accepted and queued for validation",
    ], { hubRoot });

    await runHub([
      "done",
      "--agent",
      "desktop-agent",
      "--thread",
      post.threadId,
      "--summary",
      "Completed the live desktop pass",
    ], { hubRoot });

    const broadcastView = await readText(path.join(hubRoot, "views", "broadcast.md"));
    assert.match(broadcastView, /Hub cutover is active/);

    const desktopMailboxLines = (await readText(path.join(hubRoot, "mailbox", "desktop-agent.jsonl")))
      .trim()
      .split("\n");
    assert.equal(desktopMailboxLines.length, 3);

    const status = JSON.parse((await runHub(["status", "--agent", "desktop-agent"], { hubRoot })).stdout);
    assert.equal(status.agents[0].openThreadCount, 0);
    assert.equal(status.agents[0].threads[0].latestKind, "done");
  });

  it("serializes concurrent writes with a shared lock", async () => {
    const hubRoot = path.join(tempRoot, "hub");
    await runHub(["init"], { hubRoot });

    await Promise.all([
      runHub([
        "post",
        "--from",
        "runtime-agent",
        "--to",
        "qa-agent",
        "--kind",
        "fyi",
        "--summary",
        "Runtime validation iteration A",
      ], { hubRoot }),
      runHub([
        "post",
        "--from",
        "runtime-agent",
        "--to",
        "qa-agent",
        "--kind",
        "fyi",
        "--summary",
        "Runtime validation iteration B",
      ], { hubRoot }),
    ]);

    const qaMailboxLines = (await readText(path.join(hubRoot, "mailbox", "qa-agent.jsonl")))
      .trim()
      .split("\n");
    assert.equal(qaMailboxLines.length, 2);
    assert.match(qaMailboxLines[0], /Runtime validation iteration/);
    assert.match(qaMailboxLines[1], /Runtime validation iteration/);
  });

  it("reports stale locks and parse issues through doctor", async () => {
    const hubRoot = path.join(tempRoot, "hub");
    await runHub(["init"], { hubRoot });

    const lockPath = path.join(hubRoot, ".hub.lock");
    await mkdir(lockPath, { recursive: true });
    const staleDate = new Date(Date.now() - 120_000);
    await utimes(lockPath, staleDate, staleDate);
    await writeFile(path.join(hubRoot, "mailbox", "runtime-agent.jsonl"), "{broken json}\n");

    let error;
    try {
      await runHub(["doctor"], { hubRoot });
    } catch (caught) {
      error = caught;
    }

    assert.ok(error);
    assert.match(error.stdout, /Stale lock detected/);
    assert.match(error.stdout, /Invalid JSONL/);
  });
});
