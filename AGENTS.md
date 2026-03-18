# codex-feishu-bridge Agent Guide

## Mission

This repository hosts a CLI-first Codex, VSCode, and Feishu bridge.
The runtime truth is `codex app-server` and Codex CLI, not the OpenAI VSCode extension.
Agents must preserve a resumable project memory and keep implementation slices independently testable.

## Mandatory Read Order

Before changing code or docs, agents must read these files in order:

1. `README.md`
2. `docs/prd.md`
3. `docs/architecture.md`
4. local-only process docs when they are present and the task explicitly depends on them

## Working Rules

- Docker is the only default development environment for Node and TypeScript work.
- Do not reintroduce the OpenAI VSCode extension as the primary runtime dependency.
- Keep the monorepo layout stable: `apps/`, `packages/`, `docker/`, `docs/`, `.agent/`.
- Record public architecture decisions in `docs/architecture.md`.
- Prefer deleting weak or misleading compatibility paths over keeping them alive.
- Keep public repository docs suitable for open-source readers by default.

## Documentation Update Policy

- `README.md`: public project description, quick start, and user-facing workflow
- `docs/prd.md`: public product scope and non-goals
- `docs/architecture.md`: public system structure and interfaces
- local-only process docs may exist under `docs/`, but do not rely on them for public-facing changes unless the task explicitly targets internal workflow

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
