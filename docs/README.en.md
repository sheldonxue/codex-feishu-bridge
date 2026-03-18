# codex-feishu-bridge

This file keeps the English README content. The primary repository entry is now the Chinese [README](../README.md).

`codex-feishu-bridge` gives a single Codex task two fully connected control surfaces: VSCode on the desktop and Feishu on the phone.
Start, steer, review, and take over work from the workstation, then leave the desk and keep launching tasks, tracking progress, handling approvals, and resuming the exact same thread from Feishu.

## Overview

The repository is built around three product surfaces:

- `Codex CLI + codex app-server` as the real task runtime and auth layer
- `VSCode extension` as a graphical monitor for Feishu-bound Codex tasks
- `Feishu` as the mobile conversation and control surface

The OpenAI VSCode extension is not required as the runtime authority for this project.

Common mobile scenarios include:

- create a new topic or post a plain-text message in a bot-enabled Feishu group while away from the desk
- start a new remote Codex thread from that conversation
- keep pushing the work forward through plain-text conversation on the phone
- get the result without first returning to the workstation

- start or continue a task on the host machine
- open the VSCode monitor and use `Bind to New Feishu Topic` to create a fresh Feishu topic for that running task before leaving the desk
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

Before the first real Feishu run, make sure the target group has topic mode enabled in the group settings.

### 1. Fill the minimum Feishu config

Edit `docker/.env` and at least set:

```env
FEISHU_APP_ID=your App ID
FEISHU_APP_SECRET=your App Secret
FEISHU_DEFAULT_CHAT_NAME=your Feishu group name
```

If you already know the chat id, you can use `FEISHU_DEFAULT_CHAT_ID=oc_xxx` instead.

### 2. Choose the Docker-host permission mode

Both modes keep `bridge-daemon` inside Docker. The difference is where later turns execute.

Set these shared values first:

```env
HOST_CODEX_HOME=/home/you/.codex
HOST_CODEX_BIN_DIR=/path/to/codex-package
```

Mode A: `stdio`

- recommended default for most users
- best for normal bridge tasks, fresh Feishu tasks, and desktop takeover
- later turns are handled by the Docker-side daemon directly managing `codex app-server`

```env
BRIDGE_CODEX_HOME=/codex-home
CODEX_RUNTIME_BACKEND=stdio
CODEX_APP_SERVER_BIN=/opt/host-codex-bin/bin/codex.js
```

Mode B: `socket-proxy`

- best when you started a full-access thread in the host CLI first, then imported and bound it to Feishu later
- keeps the real executing `codex app-server` on the host side, so later turns keep the host file visibility
- Docker still owns the daemon, Feishu bridge, HTTP, and WebSocket surfaces

```env
CODEX_RUNTIME_BACKEND=socket-proxy
CODEX_RUNTIME_PROXY_SOCKET=/workspace/codex-feishu-bridge/.tmp/codex-runtime-proxy.sock
```

If this is your first run, choose `stdio`.

### 3. One-click startup path A: start from the terminal and open the monitor

```bash
./scripts/dev-stack.sh monitor
```

If you prefer npm commands, you can run:

```bash
npm run monitor:all
```

This path handles:

- creating `docker/.env` when it is missing
- starting `workspace-dev`
- installing npm dependencies in Docker
- building `shared`, `protocol`, `bridge-daemon`, and `vscode-extension`
- recreating `bridge-runtime`
- waiting for `/health`
- opening the monitor automatically

### 4. One-click startup path B: open the repo in VSCode and press `F5`

1. Open the repository in VSCode.
2. Press `F5` on `Codex Feishu Bridge Extension`.
3. The launch target now runs the same one-click bootstrap as a VSCode `preLaunchTask`.
4. The Extension Development Host opens the monitor automatically.

### 5. Start using Feishu

1. Confirm the target Feishu group already has topic mode enabled.
2. Create a topic or send a plain-text message in the bot-enabled group.
3. Let bridge reply with a configuration card.
4. Press `Create on Host`.
5. Continue the work in the same thread.

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
- `monitor` for the same bootstrap flow plus auto-opening the VSCode monitor
- `down` for stopping the stack
- `status` for compose status and `/health`
- `logs` for following the bridge runtime logs

The VSCode launch entry in [`.vscode/launch.json`](../.vscode/launch.json) reuses the same bootstrap flow.
It also auto-opens the monitor in the Extension Development Host.

## Manual Path

For real `stdio` and Feishu runs, or if you want full manual control, prefer calling `docker compose` directly with `--env-file docker/.env`.

## Runtime and Validation

This section expands the same two Docker-host permission modes from Quick Start.

Mode A: `stdio`

```bash
HOST_CODEX_HOME=/home/you/.codex
HOST_CODEX_BIN_DIR=/path/to/codex-package
BRIDGE_CODEX_HOME=/codex-home
CODEX_RUNTIME_BACKEND=stdio
CODEX_APP_SERVER_BIN=/opt/host-codex-bin/bin/codex.js
```

Use it when:

- you mostly create tasks from bridge, VSCode, or Feishu
- you want the Docker-side daemon to manage the real `codex app-server`
- you are on the default path and do not need imported host threads to preserve host-only file visibility

Mode B: `socket-proxy`

```bash
HOST_CODEX_HOME=/home/you/.codex
HOST_CODEX_BIN_DIR=/path/to/codex-package
CODEX_RUNTIME_BACKEND=socket-proxy
CODEX_RUNTIME_PROXY_SOCKET=/workspace/codex-feishu-bridge/.tmp/codex-runtime-proxy.sock
```

This mode does not move the whole `bridge-daemon` onto the host. It keeps:

- `bridge-daemon`, Feishu, and HTTP/WebSocket inside Docker
- only the real `codex app-server` execution layer exposed through a thin host-side sidecar
- `./scripts/dev-stack.sh up` and `./scripts/dev-stack.sh monitor` auto-managing that sidecar for you

Use it when:

- you started a full-access thread in the host CLI first
- later imported that thread into bridge and bound it to Feishu
- you want later Feishu or VSCode turns to keep seeing the real host paths instead of the Docker-limited filesystem view

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

This is the main desktop entry for watching, taking over, organizing, and syncing tasks.

Recommended way to open it:

1. Run `./scripts/dev-stack.sh monitor`.
2. Or run `npm run monitor:all`.
3. If you are already developing in VSCode, you can still press `F5`.

Read the monitor in this order:

### 1. Task list

- each task shows status, message count, and origin badges such as `FEISHU`, `VSCODE`, and `CLI`
- tasks can show multiple badges at once, for example `CLI + FEISHU`, when a host task is later bound to Feishu
- `Refresh Tasks` reloads daemon state and re-syncs host thread changes

### 2. Task detail

- `Conversation` shows the full conversation that bridge has synced for the task
- `Approvals` is collapsed by default and expands only when you need to handle approvals
- `Diffs` is also collapsed by default and is meant for desktop review
- the detail area also shows workspace, thread id, status, and Feishu binding state

### 3. Desktop Composer

- the composer at the bottom is the desktop input for continuing the same task
- you can send another message, choose model and reasoning effort, toggle plan mode, and attach local photos or files
- if the task is already bound to Feishu, desktop-side follow-up replies can continue syncing back to the same Feishu thread

### 4. Common actions

- `Bind to New Feishu Topic`: create a fresh Feishu topic in the default group and bind the current task to it
- `Import Recent Host Threads`: pull recent host-side `~/.codex` threads into the monitor
- `Forget Local Copy`: remove the local monitor record without deleting the underlying Codex thread
- `Delete Local`: remove the local thread data for real
- `Multi-select`: enter batch mode for local unbound tasks and run `Forget Selected` or `Delete Selected`

`Import Recent Host Threads` is most useful when:

- a host task already exists but has not appeared in the monitor
- you are about to leave the desk and want to sync a host task into bridge / Feishu before continuing mobile supervision

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

4. Enable topic mode in the target Feishu group.
   The recommended mobile workflow assumes you start from a group topic or thread, so topic mode should be turned on in the group settings.

5. Enable long-connection event subscription.
   In the event subscription section, choose the long-connection mode and enable at least:
   - `im.message.receive_v1`
   - `card.action.trigger`

6. Decide how to identify the default group.
   Two supported options exist:
   - recommended: set `FEISHU_DEFAULT_CHAT_NAME`
   - fixed value: set `FEISHU_DEFAULT_CHAT_ID`

   In practice, `chat_id` is usually easiest to resolve after the bot has already joined the group:

   ```bash
   node --env-file=docker/.env --import tsx scripts/resolve-feishu-chat.ts --list
   node --env-file=docker/.env --import tsx scripts/resolve-feishu-chat.ts --name "Your Feishu Group Name"
   ```

   The first command lists visible chats, and the second resolves the exact `chat_id` for one group name.

7. Only configure webhook security values if you intentionally keep the compatibility path enabled.
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
5. Press `Create on Host`.
6. Continue the task with plain text in the same thread.
7. Use the control card for status, interrupt, retry, approvals, inspect, and unbind actions.

Two card actions have intentionally different meanings:

- `Unbind Thread`: detach the current Feishu thread from the host task, but keep the topic reusable for drafting another task later
- `Archive Task`: archive and end the current Feishu topic, so later plain text, photos, and files in that topic no longer reach the workstation

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
- For imported host threads that must keep host path visibility after Feishu binding, prefer `CODEX_RUNTIME_BACKEND=socket-proxy`.
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
