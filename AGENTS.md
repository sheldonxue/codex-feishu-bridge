# codex-feishu-bridge Agent Guide

## Mission

This repository hosts a CLI-first Codex, VSCode, and Feishu bridge.
The runtime truth is `codex app-server` and Codex CLI, not the OpenAI VSCode extension.
Agents must preserve a resumable project memory and keep implementation slices independently testable.

## Mandatory Read Order

Before changing code or docs, agents must read these files in order:

1. `docs/status.md`
2. `docs/plan.md`
3. `docs/log.md`
4. `docs/architecture.md`
5. `docs/agents.md`
6. `docs/worktree-agents.md` when the task is part of a multi-agent or multi-worktree effort

## Working Rules

- Docker is the only default development environment for Node and TypeScript work.
- Do not reintroduce the OpenAI VSCode extension as the primary runtime dependency.
- Keep the monorepo layout stable: `apps/`, `packages/`, `docker/`, `docs/`, `.agent/`.
- Treat `docs/log.md` and `docs/lessons.md` as append-only project memory.
- Update `docs/status.md` whenever the implementation state changes materially.
- Record architecture decisions in both `docs/architecture.md` and `docs/log.md`.
- Prefer deleting weak or misleading compatibility paths over keeping them alive.
- In multi-agent mode, use `docs/worktree-agents.md` as the coordination source of truth for ownership, mentions, and handoffs.

## Documentation Update Policy

- `docs/status.md`: overwrite the current snapshot, keep the heading structure stable.
- `docs/plan.md`: update phases, milestones, and next work when scope changes.
- `docs/log.md`: append dated entries only.
- `docs/lessons.md`: append dated lessons only.
- `docs/agents.md`: keep operational instructions current for future agents.
- `docs/worktree-agents.md`: keep ownership, mention templates, and bootstrap prompts current for multi-agent work.

## Commit Policy

- After every major, independently verifiable change slice, run the relevant test or self-check and commit immediately.
- A change slice must map to one behavior or one tightly related capability boundary.
- Do not mix unrelated docs, runtime, frontend, and bridge work in the same commit.
- Default commit title format is `<gitmoji> <prefix>: <precise summary>`.
- Preferred prefixes are `feat`, `fix`, `refactor`, `docs`, `test`, and `chore`.
- Docs-only updates may be committed after Markdown and structure self-checks pass.
- If no meaningful test exists yet, state that explicitly in the task record before committing.

## Delivery Defaults

- Keep code and config ASCII unless there is a clear reason not to.
- Prefer clear subsystem boundaries over minimal edits when the user asks for structural work.
- If a task requires Node, TypeScript, or Codex tooling, run it in Docker unless the task explicitly targets the host runtime.
- When adding or changing public interfaces, update `docs/architecture.md`.
