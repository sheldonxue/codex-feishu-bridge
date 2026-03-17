# Release Note

## Snapshot

- Date: 2026-03-18
- Release state: `conditional go`
- Mainline branch: `master`
- Mainline closeout tag: `closeout-2026-03-18-conditional-go`
- Mainline closeout commit: `01e65fa` `📝 docs: close out live validation and merge readiness`

This release closes the `v1` local workflow for the `codex-feishu-bridge` repository.
The repository now ships a CLI-first Codex runtime, a VSCode desktop frontend, a Feishu mobile bridge, a manual import path, a shared multi-agent hub workflow, and the supporting recovery and validation utilities.

## Included Scope

### Runtime

- `codex app-server` runtime integration inside `bridge-daemon`
- auth endpoints, task lifecycle endpoints, approvals, uploads, and recovery
- live `stdio` compatibility fixes for:
  - `thread/list`
  - timestamp normalization
  - object-shaped thread status
  - `turn/steer expectedTurnId`
- worktree-aware Docker bootstrap and live diff backfill fixes

### Desktop

- VSCode task tree
- task detail panel
- diff opening
- approval resolution
- image upload flow
- live daemon smoke hardening

### Feishu

- webhook verification and compatibility path
- official SDK long-connection ingress
- root-message binding and thread continuity
- reply routing by `thread_id` and root message identity
- control-command routing for:
  - `interrupt`
  - `retry`
  - `cancel`
  - `approve`
  - `decline`
- startup sync collapse into a single task root thread
- ingress diagnostics

### Coordination and Tooling

- shared hub CLI at `scripts/hub-cli.mjs`
- sibling hub path at `/home/dungloi/Workspaces/codex-feishu-bridge-hub`
- multi-agent worktree protocol
- live runtime validation helper
- checked-in Extension Development Host launch configuration

## Mainline Integration Summary

Selected worker commits were integrated onto `master` by curated `cherry-pick`, not whole-branch merges.

### Runtime Intake

- `5b4aea9` `🐛 fix: harden live turn control during stdio startup`
- `789ef08` `🧪 test: expand live runtime validation helper`
- `da314ca` `🧪 test: use worktree path in turn control test`
- `a20f3ff` `🐛 fix: align stdio approval request handling`
- `f585034` `🐛 fix: mirror worktree gitdir paths in docker`
- `4450f01` `🐛 fix: backfill structured diffs from agent summaries`

### Desktop Intake

- `8d458ac` `🐛 fix: harden vscode extension live daemon smoke`
- `36ce6c7` `🐛 fix: stabilize vscode live smoke against real daemon`

### Feishu Intake

- `7e65787` `🐛 fix: require full feishu webhook configuration`
- `cffeeb0` `✨ feat: add feishu long connection ingress`
- `3e7e1b3` `✅ test: localize feishu ingress fixtures`
- `f81ca4a` `✨ feat: wire feishu daemon to long connection sdk`
- `940f0de` `🐛 fix: route feishu thread replies by thread id`
- `8f45dea` `🪵 chore: add feishu ingress diagnostics`
- `0cbe621` `🐛 fix: collapse feishu startup sync into one thread`

### Integration Follow-Ups

- `9e38e0a` `🐛 fix: skip worktree bootstrap for git directories`
- `4f83668` `✅ test: align feishu webhook approvals with runtime payloads`

## Validation Summary

### Completed Live Path

The selected live-validation path is complete for all three main product lanes.

- Runtime:
  - real `thread/start`
  - real `turn/start`
  - immediate `turn/steer`
  - immediate `turn/interrupt`
  - approval accept flow
  - structured diff recovery
- Desktop:
  - task tree
  - detail panel
  - diff opening
  - approval resolution
  - image upload
  - bounded post-fix diff recheck
- Feishu:
  - official SDK long-connection ingress
  - thread continuity
  - live command routing for `interrupt`, `retry`, `cancel`, `approve`, and `decline`

### Regression and Build Coverage

The closeout process re-ran or re-confirmed these core checks on the integrated mainline:

- `npm run build:protocol`
- `npm run build:shared`
- `npm run build:daemon`
- `npm run build:extension`
- `npm run test:extension`
- Feishu targeted tests:
  - `apps/bridge-daemon/tests/feishu-webhook.test.ts`
  - `apps/bridge-daemon/tests/feishu-long-connection.test.ts`
  - `apps/bridge-daemon/tests/feishu-sdk-long-connection.test.ts`

## Release Verdict

QA's final gate is `conditional go`.

There is no active blocker on the selected live path, but the release is intentionally not labeled unconditional because the following non-gating items remain outside the final proof boundary:

- runtime manual import and resume were not re-proven as separate real-stdio closeout slices
- desktop `login` entry and `retry` action were not preserved as standalone final live-evidence slices
- Feishu webhook/public-callback ingress remains implemented, but it was not the selected live-validation path for this round
- `test:daemon` still has a residual runner-stability caveat: suites can go green while the runner may not exit cleanly under some Docker execution patterns

## Archive Summary

The project has been closed out and archived to a stable local state:

- the five agent worktrees were removed
- the temporary closeout clone was removed
- the development containers for this project were stopped
- all shared-hub closeout threads were marked done

What remains on disk as the durable archive:

- main repository: `/home/dungloi/Workspaces/codex-feishu-bridge`
- tag: `closeout-2026-03-18-conditional-go`
- local branch references:
  - `agent/coordinator`
  - `agent/runtime`
  - `agent/feishu`
  - `agent/desktop`
  - `agent/qa`
- shared hub data:
  - `/home/dungloi/Workspaces/codex-feishu-bridge-hub`

## Recommended Next Step

Treat this release as the stable baseline for future work.
If the release bar needs to rise from `conditional go` to a stronger standard, the next slices should be:

1. runtime manual import/resume real-stdio closeout
2. standalone desktop `login` and `retry` live evidence
3. Feishu webhook/public-callback compatibility validation
4. `test:daemon` runner-exit stability hardening
