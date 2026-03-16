# Lessons

## 2026-03-17

- Defining the project memory layer early reduces future agent context loss.
- Docker-first is not optional for this repository because the host currently does not provide the Node toolchain.
- Keeping root `AGENTS.md` plus `docs/agents.md` gives both an automatic entrypoint and a fuller operating manual.
- Once Codex CLI and app-server cover the runtime needs, it is safer to build around them than around a private IDE integration.
- Mock runtimes need an explicit “external thread seed” path, otherwise manual-import tests accidentally exercise the already-attached code path instead of a true import flow.
- State-file writes must be serialized; concurrent async writes can silently roll the daemon back to an older snapshot and break restart recovery.
- Inside `workspace-dev`, local daemon access should use the Compose service name `bridge-runtime`, not host loopback, for CLI validation.
- Feishu bridge tests need to keep the fetch stub alive until all async task-event replies are drained, or they will leak real network calls after the assertion phase.
