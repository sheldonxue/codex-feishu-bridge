# codex-feishu-bridge

This file keeps the English README content. The primary repository entry is now the Chinese [README](../README.md).

`codex-feishu-bridge` is a CLI-first bridge that connects Codex tasks to a desktop VSCode surface and a mobile Feishu surface.
It is designed for developers who want to start, inspect, and control Codex work from multiple devices without making the editor plugin the runtime authority.

## Overview

The repository is built around three product surfaces:

- `Codex CLI + codex app-server` as the real task runtime and auth layer
- `VSCode extension` as a graphical monitor for Feishu-bound Codex tasks
- `Feishu` as the mobile conversation and control surface

The OpenAI VSCode extension is not required as the runtime authority for this project.

A common mobile handoff scenario is:

- start or continue a task on the host machine
- sync or bind that running task into a Feishu thread before leaving the desk
- keep watching replies, approvals, and interrupts from the phone
- resume desktop takeover in VSCode when back at the workstation

## Highlights

- CLI-first runtime with `codex app-server`
- Docker-first TypeScript development workflow
- VSCode monitor editor tab, task highlighting, diff view, approvals, and desktop handoff messaging
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

- [prd.md](./prd.md)
- [architecture.md](./architecture.md)

## Quick Start

Use the one-click bootstrap entry by default:

```bash
./scripts/dev-stack.sh up
```

If you prefer npm commands, you can run:

```bash
npm run start:all
```

This path now handles:

- creating `docker/.env` when it is missing
- starting `workspace-dev`
- installing npm dependencies in Docker
- building `shared`, `protocol`, `bridge-daemon`, and `vscode-extension`
- recreating `bridge-runtime`
- waiting for `/health`

Before the first real run, edit `docker/.env` if you need real Feishu credentials or real `stdio` runtime settings.

Then:

1. Open the repository in VSCode.
2. Press `F5` on `Codex Feishu Bridge Extension`.
3. The launch target now runs the same one-click bootstrap as a VSCode `preLaunchTask`.
4. In the Extension Development Host, run `Codex Bridge: Open Monitor`.

Companion commands:

```bash
npm run status:all
npm run logs:all
npm run stop:all
```

If you prefer explicit low-level Docker commands, they still work, but the repository now documents the one-click path as the primary workflow.

## One-Click Bootstrap

The root script [scripts/dev-stack.sh](../scripts/dev-stack.sh) exposes:

- `up` for environment preparation, install, build, runtime start, and health wait
- `down` for stopping the stack
- `status` for compose status and `/health`
- `logs` for following the bridge runtime logs

The VSCode launch entry in [`.vscode/launch.json`](../.vscode/launch.json) reuses the same bootstrap flow.

## Manual Path

For real `stdio` and Feishu runs, or if you want full manual control, prefer calling `docker compose` directly with `--env-file docker/.env`.

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

## VSCode Monitor

Open the repository in VSCode and run the `Codex Feishu Bridge Extension` launch target from [`.vscode/launch.json`](../.vscode/launch.json).
It now runs `Codex Bridge: One Click Start` first, then opens the Extension Development Host.

The extension is positioned as a **graphical monitor for Feishu task threads**. The recommended desktop workflow is:

1. Run `./scripts/dev-stack.sh up`, or simply press `F5`.
2. Confirm that `http://127.0.0.1:8787/health` is reachable.
3. Start or continue the task from Feishu.
4. Use `Codex Bridge: Open Monitor` to open the monitor editor page.
5. Inspect:
   - task status, workspace, thread id, and Feishu binding
   - conversation timeline with `feishu` / `vscode` / `runtime` source tags
   - pending approvals
   - diff summaries
6. Continue the task from the monitor's persistent composer instead of a popup input box.
7. Handle interrupt, retry, approvals, diff opening, and unbind actions from the same page.

Desktop-origin messages are not mirrored back into Feishu as user text. For Feishu-bound tasks, the monitor exposes a task-level toggle that controls whether the resulting agent reply should continue syncing back to the Feishu thread.

## Feishu Usage

The recommended mobile path is the official SDK long-connection client.

Set:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- either `FEISHU_DEFAULT_CHAT_ID` or `FEISHU_DEFAULT_CHAT_NAME`

If only the group name is known, resolve visible chats with:

```bash
node --env-file=docker/.env --import tsx scripts/resolve-feishu-chat.ts --list
node --env-file=docker/.env --import tsx scripts/resolve-feishu-chat.ts --name "Your Feishu Group Name"
```

When `FEISHU_DEFAULT_CHAT_NAME` is present, `bridge-daemon` resolves the exact chat automatically at startup.

### Feishu Console Setup

Use this checklist to collect the values required by `docker/.env`.

1. Create or open a self-built app in the Feishu Open Platform console.
   Console entry:
   `https://open.feishu.cn/app`

2. Copy the application credentials.
   In the app console, open the basic information page and copy:
   - `App ID` -> `FEISHU_APP_ID`
   - `App Secret` -> `FEISHU_APP_SECRET`

3. Enable the bot capability and add the bot to the target group.
   The bridge can only receive group messages after the app bot has joined the chat you want to use.

4. Enable long-connection event subscription.
   In the event subscription section, choose the long-connection mode and enable at least:
   - `im.message.receive_v1`
   - `card.action.trigger`

5. Decide how to identify the default group.
   Two supported options exist:
   - recommended: set `FEISHU_DEFAULT_CHAT_NAME`
   - fixed value: set `FEISHU_DEFAULT_CHAT_ID`

   In practice, `chat_id` is usually easiest to resolve after the bot has already joined the group:

   ```bash
   node --env-file=docker/.env --import tsx scripts/resolve-feishu-chat.ts --list
   node --env-file=docker/.env --import tsx scripts/resolve-feishu-chat.ts --name "Your Feishu Group Name"
   ```

   The first command lists visible chats, and the second resolves the exact `chat_id` for one group name.

6. Only configure webhook security values if you intentionally keep the compatibility path enabled.
   For the recommended long-connection path, these are not required:
   - `FEISHU_VERIFICATION_TOKEN`
   - `FEISHU_ENCRYPT_KEY`

   If you want `/feishu/webhook` compatibility as well, copy them from the event and callback security section:
   - `Verification Token` -> `FEISHU_VERIFICATION_TOKEN`
   - `Encrypt Key` -> `FEISHU_ENCRYPT_KEY`

### Minimal Feishu Environment Example

Long-connection with automatic group-name resolution:

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DEFAULT_CHAT_NAME=Your Feishu Group Name
```

Long-connection with a fixed group id:

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DEFAULT_CHAT_ID=oc_xxx
```

### Feishu Troubleshooting

If the bridge starts but nothing happens in the group, check these in order:

- the app bot has actually been added to the target group
- the target group matches `FEISHU_DEFAULT_CHAT_ID` or `FEISHU_DEFAULT_CHAT_NAME`
- long-connection event subscription is enabled
- `im.message.receive_v1` is enabled
- `card.action.trigger` is enabled if you want card-first interaction
- the bridge is reading the intended values from `docker/.env`

The current Feishu workflow is:

1. Start a new Feishu topic or thread.
2. Send the first plain-text message describing the task.
3. Let `bridge-daemon` create or refresh a draft and reply with a configuration card.
4. Use the card to choose model, reasoning effort, sandbox, and approval policy.
5. Press `Create Task`.
6. Continue the task with plain text in the same thread.
7. Use the control card for status, interrupt, retry, approvals, inspect, and unbind actions.

If a task is already running on the host machine, another recommended path is:

1. Leave the task running on the desktop.
2. Import or bind that task into the Feishu thread before leaving the desk.
3. Keep tracking replies and approvals from the phone.
4. Interrupt, retry, or steer from Feishu when needed.
5. Resume the same thread from VSCode after returning to the desk.

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
- The VSCode monitor connects to the daemon over localhost HTTP and WebSocket.
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

- `apps/vscode-extension`: graphical monitor and desktop handoff surface for Feishu task threads
- `apps/bridge-daemon`: daemon runtime that owns Codex sessions and Feishu routing
- `packages/protocol`: shared bridge task, event, approval, and transport contracts
- `packages/shared`: shared config, filesystem, and transport helpers
- `docker/`: compose, images, and environment templates
- `docs/`: agent-facing product, architecture, status, plan, and decision records
- `.agent/`: future agent templates and checkpoints
