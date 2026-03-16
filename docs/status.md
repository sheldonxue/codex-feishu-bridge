# Status

## Current Snapshot

- Date: 2026-03-17
- Repository phase: v1 local workflow implemented, runtime live validation started
- Runtime mode: CLI-first Codex runtime with Docker-first development
- Implementation state: daemon, VSCode frontend, Feishu bridge, manual import, and recovery paths are implemented; real `stdio` runtime alignment is now in place and live ingress validation remains open

## Completed

- Created the repository and Docker-first monorepo skeleton
- Locked the product direction to `Codex CLI + codex app-server`
- Chosen VSCode as the desktop UI layer and Feishu as the mobile UI layer
- Defined the requirement to auto-commit each independently testable major change slice
- Implemented auth/runtime scaffolding for `codex app-server`
- Implemented shared task, event, approval, and image asset protocol
- Implemented daemon task orchestration, WebSocket snapshots, uploads, and approvals
- Implemented a VSCode desktop task dashboard with commands, diff viewing, status panel, and image upload flow
- Implemented Feishu root-message binding, reply routing, signature/token checks, and duplicate webhook suppression
- Implemented manual thread import/resume plus a small CLI wrapper
- Implemented recovery reconciliation and stale approval expiration on restart
- Aligned the `stdio` runtime adapter with the live app-server schema for `thread/list`, timestamp normalization, object-shaped thread status, and `turn/steer`
- Added Docker mounts for a host Codex binary directory and host Codex home during live validation
- Verified live daemon startup, `/health`, `/auth/account`, `/auth/rate-limits`, and task reconciliation against a real ChatGPT-backed Codex home

## Implemented But Not Yet Live-Validated

- Real Feishu app credentials and the user-provided public callback URL are still external runtime inputs
- VSCode extension behavior has been locally tested against mocks but still needs a live daemon validation pass
- A full daemon-driven live pass of `thread/start`, `turn/start`, `turn/steer`, and `turn/interrupt` is still pending

## Next Iteration Focus

- Revalidate Feishu root-message creation, reply routing, and duplicate suppression against live webhook traffic
- Add explicit live-loading guidance for the VSCode extension and bridge CLI workflow
- Finish the daemon-driven live thread and turn control pass on top of the now-aligned `stdio` adapter

## Deferred Decisions

- Whether to promote the CLI wrapper into a dedicated `apps/` package instead of keeping it under `scripts/`
- Whether to add stronger diagnostics for tunnel health and Feishu delivery failures
- Whether a future cloud relay or multi-user deployment path belongs in scope after live validation
