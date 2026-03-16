# Plan

`docs/plan.md` is the single execution-plan source for this repository.
The historical root `PLAN.md` draft has been absorbed here and removed to avoid split planning.

## Completed Phases

### Phase 0: Docs and Repo Conventions

- Rewrote product and architecture docs for the CLI-first runtime.
- Locked the commit policy into `AGENTS.md` and `docs/agents.md`.
- Updated `README.md`, `docs/status.md`, and `docs/log.md`.
- Validation: doc consistency checks and repo self-checks.
- Commit boundary: `📝 docs: align repository with cli-first codex bridge plan`.
- Status: completed.

### Phase 1: Runtime and Auth

- Added a Codex runtime adapter inside `bridge-daemon`.
- Managed `codex app-server` and exposed auth endpoints.
- Mounted a shared Codex home path in Docker for the local dev path.
- Validation: daemon health plus mockable auth flow tests.
- Commit boundary: `✨ feat: add codex app-server auth runtime`.
- Status: completed.

### Phase 2: Protocol and Task Model

- Defined bridge task, event, approval, client, and image asset contracts.
- Locked `bridge-managed` and `manual-import` task modes.
- Kept `taskId = threadId` as the bridge-managed primary mapping rule.
- Validation: protocol unit tests and serialization checks.
- Commit boundary: `✨ feat: define bridge task and event protocol`.
- Status: completed.

### Phase 3: Daemon Core

- Implemented task orchestration, event fanout, uploads, approvals, snapshots, and restart recovery.
- Exposed HTTP and WebSocket endpoints for auth, tasks, uploads, approvals, and Feishu ingress.
- Validation: integration tests for task lifecycle and event streaming.
- Commit boundary: `✨ feat: add daemon session orchestration and event streaming`.
- Status: completed.

### Phase 4: VSCode Frontend

- Added commands, task tree, detail view, diff panel, desktop actions, and image upload flow.
- Kept VSCode as the desktop UI only, not the runtime authority.
- Validation: extension compile checks and integration tests against a mock daemon.
- Commit boundary: `✨ feat: add vscode task dashboard and multimodal input`.
- Status: completed.

### Phase 5: Feishu Bridge

- Added webhook verification, thread binding, outgoing updates, and mobile controls.
- Routed `reply`, `steer`, `interrupt`, `approve`, `cancel`, and `retry`.
- Kept the product rule of one bridge task to one Feishu root message and reply chain.
- Validation: webhook, dedupe, and thread routing tests.
- Commit boundary: `✨ feat: add feishu threaded task bridge`.
- Status: completed.

### Phase 6: Manual CLI Import

- Imported and resumed existing raw Codex threads.
- Normalized imported threads into the same bridge task model.
- Preserved the `v1` boundary that live attach to another external raw CLI process is not guaranteed.
- Validation: import and resume tests using persisted mock thread data.
- Commit boundary: `✨ feat: support manual codex thread import and resume`.
- Status: completed.

### Phase 7: Hardening

- Covered daemon restart recovery, duplicate callbacks, expired approvals, and stale turns.
- Added recovery reconciliation and minimal diagnostics.
- Validation: failure-mode tests and restart recovery checks.
- Commit boundary: `🐛 fix: harden task recovery and feishu action replay`.
- Status: completed.

## Next Iteration: Live Validation

The next iteration is not feature expansion.
It is a live-validation pass against the real runtime, real Feishu ingress, and real desktop loading path.

### Runtime and Auth Validation

- Run `bridge-daemon` with `CODEX_RUNTIME_BACKEND=stdio`.
- Current progress in this slice:
  - daemon can run in Docker against a host-mounted Codex binary directory and host Codex home
  - `/health`, `/auth/account`, `/auth/rate-limits`, and task reconciliation were verified against a real ChatGPT login
- Validate against a real logged-in `codex app-server`:
  - `account/login/start`
  - `account/read`
  - `account/rateLimits/read`
  - `thread/start`
  - `thread/resume`
  - `thread/list`
  - `thread/read`
  - `turn/start`
  - `turn/steer`
  - `turn/interrupt`
- Compare real runtime notifications against the current bridge mapping:
  - thread state changes
  - turn lifecycle
  - `fileChange`
  - `commandExecution`
  - `serverRequest/resolved`
- If mismatches appear, only adjust the runtime adapter and bridge-service mapping unless the real protocol is missing an essential field.
- Expected commit boundary: `✨ feat: align daemon runtime with live codex app-server`.

### Feishu Live Validation

- Validate with real `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN`, `FEISHU_ENCRYPT_KEY`, and `FEISHU_DEFAULT_CHAT_ID`.
- Validate via a user-provided public callback URL:
  - new task sends the root message
  - later updates stay in the same reply chain
  - mobile replies route to the correct task
  - `approve`, `decline`, `cancel`, `interrupt`, and `retry` reach the right task
  - duplicate webhook deliveries are still deduplicated
- If the live payload differs from the mocked assumption, only adjust the Feishu bridge and HTTP ingress adapter.
- Expected commit boundary: `✨ feat: align feishu bridge with live webhook flow`.

### Desktop Live Validation

- Load `apps/vscode-extension` in VSCode development mode against the real daemon.
- Validate:
  - task tree
  - task detail panel
  - diff opening
  - login entry
  - sending messages
  - image uploads
  - approvals and retry actions
- Add explicit live-loading instructions to `README.md`.
- Keep `scripts/bridge-cli.mjs` as a script in this iteration; do not promote it into its own `apps/` package yet.
- Expected docs commit boundary: `📝 docs: add live validation workflow for vscode and daemon`.
- Possible polish commit if small behavior fixes are required: `🐛 fix: polish vscode bridge behavior against live daemon`.

## Acceptance and Exit Criteria

- Root `PLAN.md` no longer exists.
- `docs/plan.md` remains the only plan source.
- Existing regression checks still pass:
  - `npm run test:protocol`
  - `npm run test:shared`
  - `npm run test:daemon`
  - `npm run test:extension`
  - `npm run build:daemon`
  - `npm run build:extension`
- Live runtime validation confirms auth, thread lifecycle, turn control, and approval/diff events can flow through the current task model.
- Live Feishu validation confirms root-message creation, reply-chain updates, reply routing, and duplicate suppression.
- Live desktop validation confirms the VSCode extension can connect to the daemon and use the implemented task controls.

## Assumptions and Non-Goals

- The repository already covers the original implementation plan; the next focus is live validation, not new product scope.
- `manual raw codex` support means import, resume, and post-import control, not live attach to an arbitrary external running CLI process.
- Public ingress for Feishu remains user-provided; this repository does not add a built-in public relay in `v1`.
- If live `codex app-server` or live Feishu differs from the mocked assumptions, adapt the integration layer first and avoid reshaping the task model unless it is truly insufficient.
