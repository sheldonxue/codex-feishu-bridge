# Development Summary

## Overview

This project started as a new repository for a Docker-first bridge between Codex, VSCode, and Feishu.
It finished as a CLI-first local orchestration system with:

- `Codex CLI + codex app-server` as the real runtime
- a self-owned VSCode extension as the desktop UI
- Feishu as the mobile task and control surface
- a shared multi-agent hub for cross-worktree coordination

The overall development path was not a single straight implementation pass.
It went through several architecture clarifications, an agent-coordination redesign, and a final curated closeout on `master`.

## Development Timeline

### Phase 0: Repository and Project Memory Bootstrap

- created the repository under `/home/dungloi/Workspaces/codex-feishu-bridge`
- fixed the project shape to a Docker-first monorepo
- established root `AGENTS.md` plus the `docs/` project-memory layer
- defined early documentation for PRD, architecture, plan, status, logs, lessons, and agent operation

### Phase 1: Runtime Direction Reset

The project first explored a VSCode-plugin-centered bridge idea, then clarified a stronger foundation:

- do not depend on the OpenAI VSCode extension as the runtime authority
- use official `Codex CLI + codex app-server` instead
- keep VSCode as a frontend and Feishu as a parallel mobile interface

This was a key architectural simplification.
It moved the repository away from private integration assumptions and toward public, controllable interfaces.

### Phase 2: Core Implementation

The repository then implemented the full local product skeleton:

- runtime and auth adapter
- shared protocol package
- daemon orchestration
- VSCode extension
- Feishu bridge
- manual import/resume
- recovery handling

At this point the repository had full local feature coverage, but still required real-environment validation.

### Phase 3: Real Validation Preparation

The project next shifted from “can it work in mocks?” to “can it hold in the real loop?”:

- aligned the `stdio` runtime adapter to the live app-server schema
- mounted host `codex` state and host binaries into Docker
- added runtime validation helpers
- added checked-in VSCode launch support
- prepared real Feishu validation assumptions

### Phase 4: Multi-Agent Execution

To accelerate live validation, the project was split into five parallel agent lanes:

- `coordinator-agent`
- `runtime-agent`
- `desktop-agent`
- `feishu-agent`
- `qa-agent`

At first, branch-local docs were treated like message boards, but that model failed because each worktree saw only its own file state.
The project then introduced a sibling shared hub:

- `scripts/hub-cli.mjs`
- JSONL append-only mailboxes
- rendered inbox views
- broadcast and handoff threads

That redesign fixed cross-worktree communication and became one of the most important process improvements in the whole effort.

### Phase 5: Live Closeout

The worker lanes converged on a selected live-validation path:

- runtime on the authoritative `stdio` daemon at `http://127.0.0.1:8891`
- desktop against the same daemon in the Extension Development Host path
- Feishu via the official SDK long-connection client

The project then used curated cherry-picks, not raw branch merges, to bring only the validated slices onto `master`.

### Phase 6: Final Closeout and Archive

After worker integration:

- coordinator produced a clean docs-only closeout
- QA issued a final `conditional go`
- mainline docs were synchronized
- the project was tagged
- agent worktrees were archived and removed
- containers were stopped
- the shared hub was fully closed out

## Key Architecture Decisions

### 1. CLI-First Runtime

The most important product decision was to treat `Codex CLI + codex app-server` as the real runtime and auth layer.
This kept the repository grounded in official, inspectable, automatable surfaces.

### 2. VSCode as Frontend Only

The desktop surface was intentionally limited to presentation and operator workflow:

- task tree
- task details
- diff view
- approvals
- uploads

That separation prevented desktop code from becoming the runtime authority.

### 3. Feishu Long-Connection as the Selected Live Path

The project implemented both webhook compatibility and long-connection capability, but the final selected live path became the official SDK long-connection client.
Webhook/public callback remains a compatibility path, not the main validated one.

### 4. Shared Hub Instead of Branch-Local Handoffs

This process decision mattered almost as much as the product architecture.
Using branch-local docs as a message bus did not work across independent worktrees.
The sibling shared hub solved that by separating:

- stable repository docs
- dynamic agent traffic

### 5. Curated Mainline Intake

The final integration was done by curated `cherry-pick`.
This avoided pulling stale worktree coordination artifacts, incomplete closeout docs, or duplicated coordinator code into `master`.

## Testing and Validation Strategy

The project used multiple layers of validation:

- package builds
- daemon and extension tests
- targeted Feishu ingress tests
- runtime helper probes
- live `stdio` daemon validation
- live Feishu long-connection validation
- desktop live smoke with a bounded diff recheck

One important closeout discovery was that “all suites pass” is not the same as “the test runner exits cleanly”.
That distinction is why the final gate stayed at `conditional go`.

## Multi-Agent Collaboration Model

The collaboration model eventually stabilized into:

- one coordinator
- four execution/verification lanes
- one shared hub for dynamic coordination
- one mainline repository for stable truth

What worked well:

- clear role boundaries
- independently testable commit slices
- cherry-pick based mainline intake
- explicit shared-hub handoffs
- coordinator-owned docs closeout

What needed redesign:

- branch-local doc-based communication
- assuming all worktrees could “see” the same live handoff state
- conflating worker branches with release-ready mainline input

## Notable Technical Fixes During Closeout

- runtime startup race around immediate `turn/steer` and `turn/interrupt`
- approval payload alignment between runtime and Feishu tests
- structured diff recovery when live `fileChange` items were missing
- worktree-aware Docker bootstrap behavior
- Feishu reply routing by `thread_id`
- startup sync collapse to one Feishu root thread

These were not just polish items.
They were the difference between a repository that “mostly works” and one that can survive a real integrated closeout.

## Quality and Risk Outcome

The final result is strong enough to serve as a stable baseline.
However, the final state is intentionally documented as `conditional go`, not unconditional release-ready.

The remaining gaps are narrow and explicit:

- runtime manual import/resume as a separate real closeout slice
- desktop `login` and `retry` as separate live slices
- Feishu webhook/public-callback live compatibility path
- test-runner exit stability for `test:daemon`

That is a healthy final state because the unknowns have been converted into named, bounded follow-up tasks.

## Lessons From the Process

The biggest process lessons were:

- establish project memory before implementation depth grows
- lock architecture early when runtime authority is ambiguous
- treat dynamic coordination as infrastructure, not an afterthought
- never assume “whole branch merge” is the right final intake mechanism
- separate “proof complete for the selected path” from “every optional path is now validated”

## Recommended Reuse

If this repository pattern is reused for another project, keep these parts almost unchanged:

- Docker-first local development
- root `AGENTS.md` plus structured `docs/`
- one-agent-one-boundary worktree model
- shared hub for dynamic cross-agent traffic
- curated mainline intake by validated commit slices
- explicit QA gate language such as `go`, `conditional go`, and `no-go`

This development cycle shows that a multi-agent coding workflow can stay coherent on a nontrivial codebase, but only when communication, ownership, and final intake are designed as carefully as the code architecture itself.
