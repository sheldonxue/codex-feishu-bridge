# Log

## 2026-03-17

- Initialized the `codex-feishu-bridge` repository under `/home/dungloi/Workspaces`.
- Chose a Docker-first setup with `docker/compose.yaml` and `.devcontainer/devcontainer.json`.
- Fixed `npm workspaces` as the monorepo package manager strategy.
- Created agent-facing project memory files under `docs/` and root `AGENTS.md`.
- Reserved `apps/vscode-extension`, `apps/bridge-daemon`, `packages/protocol`, and `packages/shared`.
- Rebased the architecture onto `Codex CLI + codex app-server` instead of the OpenAI VSCode extension runtime.
- Locked the desktop surface to a self-owned VSCode extension and the mobile surface to Feishu threads.
- Chose a user-provided public callback URL for Feishu ingress instead of a built-in public relay.
- Added a repository rule to auto-commit each independently testable major change slice using `gitmoji + prefix`.
- Committed `✨ feat: add codex app-server auth runtime`.
- Committed `✨ feat: define bridge task and event protocol`.
- Committed `✨ feat: add daemon session orchestration and event streaming`.
- Committed `✨ feat: add vscode task dashboard and multimodal input`.
- Committed `✨ feat: add feishu threaded task bridge`.
- Committed `✨ feat: support manual codex thread import and resume`.
- Committed `🐛 fix: harden task recovery and feishu action replay`.
- Implemented the daemon HTTP surface for auth, task lifecycle, uploads, approvals, and Feishu webhook ingress.
- Implemented the VSCode task tree, detail panel, diff opening, status panel, login trigger, and image upload flow.
- Implemented Feishu root-message binding, threaded updates, webhook reply routing, and duplicate event suppression.
- Added a CLI wrapper for `list`, `import`, `resume`, and `send` against the bridge daemon.
- Fixed a persistence race by serializing state-file writes before restart recovery was enabled.
