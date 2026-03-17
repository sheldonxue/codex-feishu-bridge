# codex-feishu-bridge

CLI-first Codex, VSCode, and Feishu bridge for multi-device task monitoring and control.

## Product Shape

This repository is built around three surfaces:

- `Codex CLI + codex app-server` as the real task runtime and auth surface
- `VSCode extension` as the desktop UI for tasks, diffs, approvals, and image inputs
- `Feishu` as the mobile multi-task thread interface

The OpenAI VSCode extension is not the runtime authority for this project.

## Current State

- Docker is the default environment for Node and TypeScript work.
- The monorepo is organized with `npm workspaces`.
- The architecture is locked to a CLI-first runtime.
- The bridge daemon, VSCode frontend, Feishu bridge, manual import flow, and recovery hardening are implemented in the local development path.
- `docs/plan.md` is the only execution-plan source for the repository.
- The selected live-validation path is complete for `runtime`, `desktop`, and `feishu`.
- Multi-agent live validation now uses a sibling shared hub instead of branch-local handoff docs.

## Closeout Summary

- Runtime live validation is complete on the authoritative `stdio` daemon at `http://127.0.0.1:8891`, including:
  - real `thread/start`
  - real `turn/start`
  - immediate `turn/steer`
  - immediate `turn/interrupt`
  - approval accept flow
  - structured diff recovery for the affected real path
- Desktop live validation is complete for the selected closeout path, including:
  - task tree
  - detail panel
  - diff opening
  - approval resolution
  - image upload
  - bounded post-fix diff recheck on `8891`
- Feishu live validation is complete for the selected closeout path, using the official SDK long-connection client:
  - ingress delivery
  - thread continuity
  - `interrupt`, `retry`, `cancel`, `approve`, and `decline`
- QA's final gate for this round is `conditional go`.

The `conditional go` caveats are non-gating for the selected path:

- runtime manual import and resume were not re-proven as separate real-stdio closeout slices
- desktop `login` and `retry` were not retained as standalone final live-evidence slices
- Feishu webhook/public-callback compatibility was not the selected live path in this round

## Quick Start

1. Copy `docker/.env.example` to `docker/.env` and fill the runtime values you want to use.
2. Start the development container:

```bash
docker compose -f docker/compose.yaml --env-file docker/.env.example up -d workspace-dev
```

3. Enter the development container:

```bash
docker compose -f docker/compose.yaml --env-file docker/.env.example exec workspace-dev bash
```

4. Install workspace dependencies inside the container:

```bash
npm install
```

5. Start the bridge runtime container when working on daemon features:

```bash
docker compose -f docker/compose.yaml --env-file docker/.env.example up -d bridge-runtime
```

6. Build and test the implemented slices inside Docker:

```bash
npm run build:daemon
npm run test:daemon
npm run build:extension
npm run test:extension
```

For real `stdio` and Feishu runs, prefer calling `docker compose` directly with `--env-file docker/.env`.
The helper npm scripts in `package.json` keep using `docker/.env.example` as the default mock/dev baseline.

7. Use the bridge CLI wrapper from the development container:

```bash
BRIDGE_BASE_URL=http://bridge-runtime:8787 npm run bridge:cli -- list
BRIDGE_BASE_URL=http://bridge-runtime:8787 npm run bridge:cli -- import
BRIDGE_BASE_URL=http://bridge-runtime:8787 npm run bridge:cli -- resume <task-id>
```

8. Run the read-only live runtime probe inside the development container:

```bash
npm run validate:runtime:container
```

9. Load `apps/vscode-extension` in VSCode to use the desktop task view and commands.

## Shared Hub Workflow

Use the shared hub when multiple Codex CLI agents are running in separate worktrees:

1. Initialize the sibling hub once:

```bash
npm run hub:init
```

2. Check hub health and current thread status:

```bash
npm run hub:doctor
npm run hub:status
```

3. Read one agent inbox view directly:

```bash
npm run hub:read -- --agent feishu-agent
```

4. Send a direct handoff:

```bash
npm run hub:post -- --from coordinator-agent --to feishu-agent --kind handoff --summary "Validate live webhook flow" --body "Use the real callback URL and report blocked conditions."
```

5. Send a whole-team broadcast:

```bash
npm run hub:broadcast -- --from coordinator-agent --summary "Hub cutover is active" --body "Read your inbox view before resuming work."
```

6. Acknowledge and close a thread:

```bash
node scripts/hub-cli.mjs ack --agent feishu-agent --thread <thread-id> --summary "Accepted"
node scripts/hub-cli.mjs done --agent feishu-agent --thread <thread-id> --summary "Completed"
```

The default hub path is `/home/dungloi/Workspaces/codex-feishu-bridge-hub`.
Override it with `CODEX_FEISHU_BRIDGE_HUB_ROOT` when needed.

## Live Validation Workflow

Use this sequence when you want to reproduce the selected live-validation path:

1. Start `bridge-runtime` with `CODEX_RUNTIME_BACKEND=stdio`.
2. If you want Docker to reuse a real host login state and host `codex` binary, set:

```bash
export HOST_CODEX_HOME=/home/you/.codex
export HOST_CODEX_BIN_DIR=/path/to/codex-bin-dir
export BRIDGE_CODEX_HOME=/codex-home
export CODEX_APP_SERVER_BIN=/opt/host-codex-bin/codex
export CODEX_RUNTIME_BACKEND=stdio
```

3. Start the runtime container with those overrides in scope:

```bash
docker compose -f docker/compose.yaml --env-file docker/.env up -d bridge-runtime
```

4. Verify auth endpoints before creating tasks:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/auth/account
curl http://127.0.0.1:8787/auth/rate-limits
```

5. Run the read-only runtime helper:

```bash
npm run validate:runtime
```

6. If you want a no-prompt thread creation and resume check, run:

```bash
npm run validate:runtime -- --create-thread --workspace-root /workspace/codex-feishu-bridge
```

If you are running inside `workspace-dev`, use `BRIDGE_BASE_URL=http://bridge-runtime:8787` or the shortcut:

```bash
npm run validate:runtime:container
BRIDGE_BASE_URL=http://bridge-runtime:8787 npm run validate:runtime -- --create-thread --workspace-root /workspace/codex-feishu-bridge
```

7. Build the extension and launch the Extension Development Host:

```bash
npm run build:extension
```

Then open the repository in VSCode and run the `Codex Feishu Bridge Extension` launch target from [.vscode/launch.json](/home/dungloi/Workspaces/codex-feishu-bridge/.vscode/launch.json).

8. In the Extension Development Host:
- open the `Codex Bridge Tasks` view in Explorer
- run `Codex Bridge: Refresh Tasks`
- run `Codex Bridge: Open Status`
- create or resume a task and verify task state, diffs, approvals, and uploads against the daemon

9. For Feishu live validation, prefer the official SDK long-connection path.
Set `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and either `FEISHU_DEFAULT_CHAT_ID` or `FEISHU_DEFAULT_CHAT_NAME`, then let `bridge-daemon` start the long-connection client automatically at startup.

If you only know the group name, you can inspect or resolve visible chats with:

```bash
npm run feishu:resolve-chat -- --list
npm run feishu:resolve-chat -- --name "Your Feishu Group Name"
```

When `FEISHU_DEFAULT_CHAT_NAME` is present, `bridge-daemon` resolves the exact chat automatically at startup before enabling the Feishu bridge.

Use `/feishu/webhook` only as a compatibility path when you intentionally keep webhook credentials configured.

## Multi-Agent Restart Workflow

After hub cutover, restart the five worktree agents and reopen the same conversation state:

```bash
cd /home/dungloi/Workspaces/codex-feishu-bridge-coordinator && codex -a never -s workspace-write resume --last
cd /home/dungloi/Workspaces/codex-feishu-bridge-runtime && codex -a never -s danger-full-access resume --last
cd /home/dungloi/Workspaces/codex-feishu-bridge-feishu && codex -a never -s danger-full-access resume --last
cd /home/dungloi/Workspaces/codex-feishu-bridge-desktop && codex -a never -s workspace-write resume --last
cd /home/dungloi/Workspaces/codex-feishu-bridge-qa && codex -a never -s workspace-write resume --last
```

After restart, each agent should:

1. Read `AGENTS.md`
2. Read the repo docs in the normal order
3. Read `/home/dungloi/Workspaces/codex-feishu-bridge-hub/views/<agent>.md`
4. Use the hub CLI for all dynamic handoffs and blocked states

## Runtime Notes

- `bridge-daemon` is the local bridge orchestrator.
- `codex app-server` is managed by the daemon and provides the thread runtime.
- VSCode connects to the daemon over localhost HTTP and WebSocket.
- The selected Feishu live path now uses the official SDK long-connection client instead of a public callback URL.
- `/feishu/webhook` remains available as a compatibility ingress when webhook credentials are still configured.
- The daemon now exposes `/tasks`, `/tasks/import`, `/tasks/:id/resume`, `/tasks/:id/messages`, `/tasks/:id/uploads`, `/tasks/:id/approvals/*`, and `/feishu/webhook`.
- The daemon persists task state under `.tmp/` and reconciles recovered tasks on restart.
- Live runtime validation should prefer `CODEX_RUNTIME_BACKEND=stdio` so the daemon manages the real `codex app-server` process directly.
- Reusing a host login state in Docker uses `HOST_CODEX_HOME -> /codex-home`.
- Reusing a host Codex executable in Docker uses `HOST_CODEX_BIN_DIR -> /opt/host-codex-bin`.
- `npm run validate:runtime` is read-only by default.
- `npm run validate:runtime -- --create-thread` creates and resumes a real thread without sending a prompt.

## Feishu Notes

- Set `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and either `FEISHU_DEFAULT_CHAT_ID` or `FEISHU_DEFAULT_CHAT_NAME` in `docker/.env` for the long-connection path.
- `bridge-daemon` starts the official SDK long-connection client automatically when those three values are present.
- `FEISHU_VERIFICATION_TOKEN` and `FEISHU_ENCRYPT_KEY` are only required for the webhook compatibility path.
- Each task is mirrored into one Feishu root message plus reply chain.
- Incoming text replies support plain message steering plus control words such as `approve`, `decline`, `cancel`, `interrupt`, and `retry`.

## Repository Map

- `apps/vscode-extension`: desktop frontend for tasks, approvals, diffs, and image inputs
- `apps/bridge-daemon`: daemon runtime that owns Codex sessions and Feishu routing
- `packages/protocol`: shared bridge task, event, approval, and transport contracts
- `packages/shared`: shared config, filesystem, and transport helpers
- `docker/`: compose, images, and environment templates
- `docs/`: agent-facing product, architecture, status, plan, and decision records
- `.agent/`: future agent templates and checkpoints
