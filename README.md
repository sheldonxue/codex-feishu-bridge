# codex-feishu-bridge

`codex-feishu-bridge` is a CLI-first bridge that connects Codex tasks to a desktop VSCode surface and a mobile Feishu surface.
It is designed for developers who want to start, inspect, and control Codex work from multiple devices without making the editor plugin the runtime authority.

## Overview

The repository is built around three product surfaces:

- `Codex CLI + codex app-server` as the real task runtime and auth layer
- `VSCode extension` as the desktop UI for task lists, diffs, approvals, and uploads
- `Feishu` as the mobile conversation and control surface

The OpenAI VSCode extension is not required as the runtime authority for this project.

## Highlights

- CLI-first runtime with `codex app-server`
- Docker-first TypeScript development workflow
- VSCode task tree, detail panel, diff view, approvals, and image upload
- Feishu long-connection bridge with pure-thread conversations
- Card-first Feishu task creation and control
- Manual import and resume support for existing Codex threads

## Repository Layout

- `apps/bridge-daemon`: runtime bridge, HTTP/WebSocket server, Feishu integration
- `apps/vscode-extension`: desktop task UI and commands
- `packages/protocol`: shared task, event, approval, and transport contracts
- `packages/shared`: config and filesystem helpers
- `docker/`: development image, compose file, bootstrap scripts
- `docs/`: public product and architecture notes

## Public Docs

- [docs/prd.md](./docs/prd.md)
- [docs/architecture.md](./docs/architecture.md)

## Quick Start

1. Copy `docker/.env.example` to `docker/.env` and fill the values you want to use.
2. Start the development container:

```bash
docker compose -f docker/compose.yaml --env-file docker/.env.example up -d workspace-dev
```

3. Enter the container and install dependencies:

```bash
docker compose -f docker/compose.yaml --env-file docker/.env.example exec workspace-dev bash
npm install
```

4. Start the bridge runtime:

```bash
docker compose -f docker/compose.yaml --env-file docker/.env.example up -d bridge-runtime
```

5. Build and test the main packages:

```bash
npm run build:daemon
npm run test:daemon
npm run build:extension
npm run test:extension
```

For real `stdio` and Feishu runs, prefer calling `docker compose` directly with `--env-file docker/.env`.

## Runtime and Validation

To run against a real host Codex login and binary, provide these environment variables in `docker/.env`:

```bash
HOST_CODEX_HOME=/home/you/.codex
HOST_CODEX_BIN_DIR=/path/to/codex-package
BRIDGE_CODEX_HOME=/codex-home
CODEX_RUNTIME_BACKEND=stdio
CODEX_APP_SERVER_BIN=/opt/host-codex-bin/bin/codex.js
```

Then start the runtime and verify the auth endpoints:

```bash
docker compose -f docker/compose.yaml --env-file docker/.env up -d bridge-runtime
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/auth/account
curl http://127.0.0.1:8787/auth/rate-limits
```

You can also run the runtime helper:

```bash
npm run validate:runtime
```

Inside `workspace-dev`, use:

```bash
BRIDGE_BASE_URL=http://bridge-runtime:8787 npm run validate:runtime:container
```

## VSCode Usage

Build the extension:

```bash
npm run build:extension
```

Then open the repository in VSCode and run the `Codex Feishu Bridge Extension` launch target from [`.vscode/launch.json`](./.vscode/launch.json).

The extension provides:

- task tree
- task detail view
- diff opening
- status view
- desktop approval handling
- image upload

## Feishu Usage

The recommended mobile path is the official SDK long-connection client.

Set:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- either `FEISHU_DEFAULT_CHAT_ID` or `FEISHU_DEFAULT_CHAT_NAME`

If only the group name is known, resolve visible chats with:

```bash
npm run feishu:resolve-chat -- --list
npm run feishu:resolve-chat -- --name "Your Feishu Group Name"
```

When `FEISHU_DEFAULT_CHAT_NAME` is present, `bridge-daemon` resolves the exact chat automatically at startup.

The current Feishu workflow is:

1. Start a new Feishu topic or thread.
2. Send the first plain-text message describing the task.
3. Let `bridge-daemon` create or refresh a draft and reply with a configuration card.
4. Use the card to choose model, reasoning effort, sandbox, and approval policy.
5. Press `Create Task`.
6. Continue the task with plain text in the same thread.
7. Use the control card for status, interrupt, retry, approvals, inspect, and unbind actions.

The mobile thread stays clean:

- configuration cards
- control cards
- final agent replies
- approvals
- explicit errors
- necessary command results

Slash commands remain available as compatibility fallbacks, but card interaction is the recommended flow.

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
- Local task creation no longer auto-creates Feishu root messages, and Feishu no longer receives background task status summaries.
- Unbound plain text in a Feishu thread now creates or refreshes a thread-scoped draft and replies with a configuration card.
- The configuration card is the primary mobile UX. It lets you:
  - review the current draft prompt
  - choose model, reasoning effort, sandbox, and approval policy
  - reset to defaults
  - create or cancel the draft task
- After task creation, the configuration card is replaced by a task control card for:
  - status
  - interrupt
  - retry
  - approvals
  - unbind
  - task, tasks, health, account, and limits inspection
- Bound threads accept plain text as task input.
- Card actions and text messages both travel through the official SDK long-connection client. Enable the relevant card action event subscription in the Feishu developer console.
- Slash commands remain available as a compatibility fallback:
  - `/new`
  - `/new prompt <text>`
  - `/new models`
  - `/new model <model-id>`
  - `/new effort <none|minimal|low|medium|high|xhigh>`
  - `/new sandbox <read-only|workspace-write|danger-full-access>`
  - `/new approval <untrusted|on-failure|on-request|never>`
  - `/new create`
  - `/new cancel`
  - `/status`
  - `/interrupt`
  - `/retry [text]`
  - `/approve [requestId]`
  - `/decline [requestId]`
  - `/cancel [requestId]`
  - `/bind <taskId>`
  - `/unbind`
- Automatic system output is kept intentionally sparse: configuration cards, control cards, final agent replies, approval messages, explicit errors, and necessary command results.

## Repository Map

- `apps/vscode-extension`: desktop frontend for tasks, approvals, diffs, and image inputs
- `apps/bridge-daemon`: daemon runtime that owns Codex sessions and Feishu routing
- `packages/protocol`: shared bridge task, event, approval, and transport contracts
- `packages/shared`: shared config, filesystem, and transport helpers
- `docker/`: compose, images, and environment templates
- `docs/`: agent-facing product, architecture, status, plan, and decision records
- `.agent/`: future agent templates and checkpoints
