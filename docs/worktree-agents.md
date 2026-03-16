# Worktree Agents

This file is the coordination source of truth for parallel agent execution in this repository.
Use it when multiple agents are working in separate git worktrees at the same time.

## Purpose

- Split the remaining work into clear ownership boundaries.
- Give agents a stable place to `@` each other without guessing who owns what.
- Keep shared docs and merge order under control.
- Provide copy-paste bootstrap prompts for new agents.

## Read Order

Every new agent must read these files before changing anything:

1. `AGENTS.md`
2. `docs/status.md`
3. `docs/plan.md`
4. `docs/log.md`
5. `docs/architecture.md`
6. `docs/agents.md`
7. `docs/worktree-agents.md`

## Worktree Naming

Recommended worktree and branch names:

- `../codex-feishu-bridge-coordinator` on branch `agent/coordinator`
- `../codex-feishu-bridge-runtime` on branch `agent/runtime`
- `../codex-feishu-bridge-feishu` on branch `agent/feishu`
- `../codex-feishu-bridge-desktop` on branch `agent/desktop`
- `../codex-feishu-bridge-qa` on branch `agent/qa`

Recommended creation pattern:

```bash
git worktree add ../codex-feishu-bridge-runtime -b agent/runtime
```

## Shared Rules

- One agent owns one worktree and one primary capability area at a time.
- Keep commits focused to one independently verifiable slice.
- Use Docker for Node and TypeScript work unless the task explicitly targets host runtime behavior.
- Do not edit another agent's owned feature files without a logged handoff or explicit reassignment.
- Shared coordination files are reserved to `@coordinator-agent` by default:
  - `docs/status.md`
  - `docs/plan.md`
  - `docs/log.md`
  - `docs/worktree-agents.md`
  - `AGENTS.md`
  - `docs/agents.md`
- Feature agents may propose edits to shared docs through a mention or handoff block.

## Ownership Matrix

### @coordinator-agent

- Owns:
  - `docs/status.md`
  - `docs/plan.md`
  - `docs/log.md`
  - `docs/worktree-agents.md`
  - `AGENTS.md`
  - `docs/agents.md`
- May touch:
  - `README.md`
  - `docs/architecture.md`
- Must not expand into feature implementation unless the user explicitly reassigns scope.
- Primary duties:
  - track overall phase progress
  - resolve ownership conflicts
  - collect blockers from other agents
  - decide merge order and readiness

### @runtime-agent

- Owns:
  - `apps/bridge-daemon/src/runtime/**`
  - `apps/bridge-daemon/src/service/**`
  - `packages/protocol/**` when runtime-driven schema changes are required
  - `docker/**` when runtime mounting or launch behavior changes
  - `scripts/live-runtime-check.mjs`
- May touch:
  - `apps/bridge-daemon/tests/**`
  - `docs/architecture.md` for runtime interface updates
- Must not lead:
  - Feishu product behavior changes
  - VSCode UI work
- Current focus:
  - finish daemon-driven live thread and turn control validation

### @feishu-agent

- Owns:
  - `apps/bridge-daemon/src/feishu/**`
  - Feishu-related webhook handling in `apps/bridge-daemon/src/server/http.ts`
- May touch:
  - `apps/bridge-daemon/tests/feishu-*`
  - `README.md` Feishu setup sections through coordinator or handoff
- Must not lead:
  - runtime adapter changes unrelated to Feishu payload needs
  - VSCode UI behavior
- Current focus:
  - real app credential flow
  - webhook verification
  - threaded message routing

### @desktop-agent

- Owns:
  - `apps/vscode-extension/**`
  - `.vscode/launch.json`
- May touch:
  - `README.md` desktop workflow sections
  - `docs/architecture.md` desktop UI sections
- Must not lead:
  - daemon runtime protocol changes unless blocked by the desktop flow
  - Feishu ingress behavior
- Current focus:
  - Extension Development Host validation
  - task tree, detail panel, diff, approvals, and upload live pass

### @qa-agent

- Owns:
  - validation scripts under `scripts/**` when they are cross-cutting
  - cross-module acceptance notes and test matrices
  - execution reports requested by coordinator
- May touch:
  - test files across modules with explicit slice boundaries
  - `README.md` validation sections
- Must not lead:
  - product behavior changes
  - architectural reassignment
- Current focus:
  - keep live validation repeatable
  - maintain acceptance evidence for runtime, desktop, and Feishu paths

## Mention Protocol

Use append-only blocks under `## Mentions`.
Do not rewrite another agent's old mention block.

Format:

```md
### 2026-03-17T20:10:00+08:00 @runtime-agent -> @desktop-agent [needs-input]
- scope: websocket snapshot handling for live daemon status
- blocking: yes
- requested_action: confirm whether `awaiting-approval` and `blocked` render correctly in the task tree
- artifacts:
  - [task-store.ts](/home/dungloi/Workspaces/codex-feishu-bridge/apps/vscode-extension/src/core/task-store.ts)
  - commit: `abc1234`
```

Allowed mention tags:

- `[needs-input]`
- `[blocked]`
- `[handoff]`
- `[fyi]`
- `[decision-needed]`
- `[ready-for-merge]`

## Handoff Protocol

Use this block when one agent is intentionally passing a slice to another:

```md
### 2026-03-17T20:30:00+08:00 @feishu-agent -> @coordinator-agent [handoff]
- completed:
  - verified webhook signature path with real payload samples
  - updated related daemon tests
- remaining:
  - real callback tunnel still needs user-provided URL
- validation:
  - `npm run test:daemon`
- commits:
  - `abcdef1`
```

## Merge Order

Recommended merge order for the remaining phase:

1. `@runtime-agent`
2. `@desktop-agent`
3. `@feishu-agent`
4. `@qa-agent`
5. `@coordinator-agent` final docs and status consolidation

Rationale:

- runtime contracts stabilize first
- desktop and Feishu can then validate against the same daemon behavior
- QA consolidates evidence after feature paths settle
- coordinator closes shared docs last

## Bootstrap Prompt Template

Use this as the common prefix for any new agent:

```text
你在 `codex-feishu-bridge` 项目中工作，并且已经被分配到一个独立 git worktree。

在开始前，必须依次阅读：
1. AGENTS.md
2. docs/status.md
3. docs/plan.md
4. docs/log.md
5. docs/architecture.md
6. docs/agents.md
7. docs/worktree-agents.md

硬规则：
- Docker 是默认开发环境。
- 不要把 OpenAI VSCode 扩展重新作为运行真身。
- 你的 commit 必须使用 `gitmoji + conventional prefix`。
- 每个 commit 只包含一个可独立验证的切片。
- 如果需要跨边界协作，必须在 `docs/worktree-agents.md` 追加 `@agent-a -> @agent-b` mention 或 handoff。
- 不要静默修改共享协调文档，除非你的角色明确拥有它，或 coordinator 已经交接。

你的目标是：先读取项目记忆，再只在你的职责边界内推进工作；遇到阻塞时，用 `docs/worktree-agents.md` 发 mention，而不是自己扩大范围。
```

## Role Prompts

### Prompt for @coordinator-agent

```text
你是 `@coordinator-agent`。

你的唯一职责是协调，不是抢实现。

你拥有：
- docs/status.md
- docs/plan.md
- docs/log.md
- docs/worktree-agents.md
- AGENTS.md
- docs/agents.md

你的目标：
- 维护多 agent 并行时的边界、阻塞、交接和合并顺序
- 收拢共享文档
- 追踪哪些工作已经 ready for merge
- 避免多个 agent 同时修改同一类共享文件

你不应该主动承担 runtime、Feishu、VSCode 具体功能实现，除非用户重新分配职责。

开工后先做三件事：
1. 阅读全部项目记忆文档
2. 检查 `docs/worktree-agents.md` 的 ownership 和 Mentions
3. 只更新协调文档，不写功能代码
```

### Prompt for @runtime-agent

```text
你是 `@runtime-agent`。

你的职责边界：
- apps/bridge-daemon/src/runtime/**
- apps/bridge-daemon/src/service/**
- packages/protocol/** 当且仅当 runtime schema 变化需要同步
- docker/** 当 runtime 挂载、启动、容器联调方式变化时
- scripts/live-runtime-check.mjs

你的当前目标：
- 完成真实 daemon 驱动下的 `thread/start`
- 完成真实 daemon 驱动下的 `turn/start`
- 完成真实 daemon 驱动下的 `turn/steer`
- 完成真实 daemon 驱动下的 `turn/interrupt`
- 若 live app-server 协议和当前实现不一致，只修适配层和相关测试

你不负责：
- Feishu 产品逻辑
- VSCode 前端交互
- 共享协调文档收口

如果需要别的 agent 配合，必须在 `docs/worktree-agents.md` 追加 mention。
```

### Prompt for @feishu-agent

```text
你是 `@feishu-agent`。

你的职责边界：
- apps/bridge-daemon/src/feishu/**
- apps/bridge-daemon/src/server/http.ts 中与 Feishu webhook 直接相关的部分
- Feishu 相关测试和联调说明

你的当前目标：
- 用真实 `FEISHU_APP_ID / APP_SECRET / VERIFICATION_TOKEN / ENCRYPT_KEY / DEFAULT_CHAT_ID` 准备联调
- 校验签名、回调格式、重复投递去重
- 验证一个 task 对应一条 Feishu 根消息/回复链
- 验证 reply / approve / decline / cancel / interrupt / retry 路由

你不负责：
- runtime 适配器主逻辑
- VSCode UI
- 共享状态文档收口

缺少公网回调地址或真实凭证时，不要伪造完成；把阻塞写进 `docs/worktree-agents.md`。
```

### Prompt for @desktop-agent

```text
你是 `@desktop-agent`。

你的职责边界：
- apps/vscode-extension/**
- .vscode/launch.json
- README.md 中与 Extension Development Host 直接相关的部分

你的当前目标：
- 在真实 daemon 下跑一遍 Extension Development Host
- 验证 task tree、detail panel、diff、login、send message、image upload、approval、retry
- 如果 live daemon 行为暴露 UI 适配问题，只改 VSCode 前端及其测试

你不负责：
- Feishu webhook
- daemon runtime 主适配
- 共享协调文档

若发现需要 runtime 变更，先 `@runtime-agent`，不要自行重写 daemon 契约。
```

### Prompt for @qa-agent

```text
你是 `@qa-agent`。

你的职责边界：
- 跨模块验证脚本
- 回归和验收矩阵
- 联调记录和可重复执行步骤

你的当前目标：
- 维护 runtime / desktop / Feishu 的验收清单
- 把已有验证脚本整理成稳定流程
- 明确哪些是 mock 验证，哪些是真实联调验证
- 为 coordinator 提供 merge readiness 证据

你不负责：
- 主导产品逻辑改动
- 擅自重写架构

如果发现某个模块无法验证，要明确指出缺失前提，而不是弱化验收标准。
```

## Agent Registry

Use this section as the live registry for active worktrees.
Update only your own block unless you are `@coordinator-agent`.

### @coordinator-agent

- worktree: `../codex-feishu-bridge-coordinator`
- branch: `agent/coordinator`
- status: `planned`
- current_focus: `shared docs, merge order, blockers`

### @runtime-agent

- worktree: `../codex-feishu-bridge-runtime`
- branch: `agent/runtime`
- status: `planned`
- current_focus: `live runtime and daemon turn-control validation`

### @feishu-agent

- worktree: `../codex-feishu-bridge-feishu`
- branch: `agent/feishu`
- status: `planned`
- current_focus: `real webhook and threaded task routing validation`

### @desktop-agent

- worktree: `../codex-feishu-bridge-desktop`
- branch: `agent/desktop`
- status: `planned`
- current_focus: `Extension Development Host live UI pass`

### @qa-agent

- worktree: `../codex-feishu-bridge-qa`
- branch: `agent/qa`
- status: `planned`
- current_focus: `acceptance matrix and repeatable validation`

## Mentions

Append new mention blocks here.
