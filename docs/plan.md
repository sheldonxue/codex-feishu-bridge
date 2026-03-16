# Plan

## Phase 0: Docs and Repo Conventions

- Rewrite product and architecture docs for the CLI-first runtime
- Lock the commit policy into `AGENTS.md` and `docs/agents.md`
- Update `README.md`, `status.md`, and `log.md`
- Validation: doc consistency checks and repo self-checks
- Commit boundary: `📝 docs: align repository with cli-first codex bridge plan`
- Status: completed

## Phase 1: Runtime and Auth

- Add a Codex runtime adapter inside `bridge-daemon`
- Manage `codex app-server` and expose auth endpoints
- Mount a shared Codex home path in Docker
- Validation: daemon health plus mockable auth flow tests
- Commit boundary: `✨ feat: add codex app-server auth runtime`
- Status: completed

## Phase 2: Protocol and Task Model

- Define bridge task, event, approval, client, and image asset contracts
- Lock `bridge-managed` and `manual-import` task modes
- Validation: protocol unit tests and serialization checks
- Commit boundary: `✨ feat: define bridge task and event protocol`
- Status: completed

## Phase 3: Daemon Core

- Implement task orchestration, event fanout, uploads, approvals, and snapshots
- Expose HTTP and WebSocket endpoints
- Validation: integration tests for task lifecycle and event streaming
- Commit boundary: `✨ feat: add daemon session orchestration and event streaming`
- Status: completed

## Phase 4: VSCode Frontend

- Add commands, task tree, detail view, diff panel, and desktop actions
- Add desktop image input and daemon integration
- Validation: extension compile checks and integration tests against a mock daemon
- Commit boundary: `✨ feat: add vscode task dashboard and multimodal input`
- Status: completed

## Phase 5: Feishu Bridge

- Add webhook verification, thread binding, outgoing updates, and mobile controls
- Route `reply`, `steer`, `interrupt`, `approve`, `cancel`, and `retry`
- Validation: webhook, dedupe, and thread routing tests
- Commit boundary: `✨ feat: add feishu threaded task bridge`
- Status: completed

## Phase 6: Manual CLI Import

- Import and resume existing raw Codex threads
- Normalize them into bridge task records
- Validation: import and resume tests using persisted mock thread data
- Commit boundary: `✨ feat: support manual codex thread import and resume`
- Status: completed

## Phase 7: Hardening

- Cover daemon restart recovery, tunnel failures, duplicate callbacks, expired approvals, and stale turns
- Add minimal diagnostics and recovery hints
- Validation: failure-mode tests and restart recovery checks
- Commit boundary: `🐛 fix: harden task recovery and feishu action replay`
- Status: completed

## Follow-Up Backlog

- Validate `stdio` mode against a real logged-in `codex app-server`
- Decide whether to promote the CLI wrapper into a dedicated `apps/` package
- Add explicit diagnostics for Feishu delivery failures and tunnel health
- Add live-user documentation for loading the VSCode extension in development mode
