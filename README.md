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

7. Use the bridge CLI wrapper from the development container:

```bash
BRIDGE_BASE_URL=http://bridge-runtime:8787 npm run bridge:cli -- list
BRIDGE_BASE_URL=http://bridge-runtime:8787 npm run bridge:cli -- import
BRIDGE_BASE_URL=http://bridge-runtime:8787 npm run bridge:cli -- resume <task-id>
```

8. Load `apps/vscode-extension` as an unpacked extension project in VSCode to use the desktop task view and commands.

## Runtime Notes

- `bridge-daemon` is the local bridge orchestrator.
- `codex app-server` is managed by the daemon and provides the thread runtime.
- VSCode connects to the daemon over localhost HTTP and WebSocket.
- Feishu callbacks enter through a user-provided public URL, typically exposed with a local tunnel such as `frp`.
- The daemon now exposes `/tasks`, `/tasks/import`, `/tasks/:id/resume`, `/tasks/:id/messages`, `/tasks/:id/uploads`, `/tasks/:id/approvals/*`, and `/feishu/webhook`.
- The daemon persists task state under `.tmp/` and reconciles recovered tasks on restart.

## Feishu Notes

- Set `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN`, `FEISHU_ENCRYPT_KEY`, and `FEISHU_DEFAULT_CHAT_ID` in `docker/.env`.
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
