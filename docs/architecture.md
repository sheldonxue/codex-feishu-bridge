# Architecture

## 总体原则

- `Codex CLI + codex app-server` 是真实运行后端
- VSCode 扩展是桌面图形前端，不是运行真身
- Feishu 是手机端线程和远程控制入口
- Docker 是默认的 Node and TypeScript 开发环境

## 四层拓扑

### Codex Runtime

- `codex app-server` 由 `bridge-daemon` 管理
- 认证、线程、turn、审批和事件流都从这里读取和写入
- 共享的 Codex home 用于保存登录态和线程存储
- Live validation can mount a host Codex binary directory into `/opt/host-codex-bin`
- Live validation can mount a host Codex home into `/codex-home` to reuse an existing ChatGPT login state

### Bridge Daemon

- 容器内常驻服务
- 负责 `codex app-server` 子进程管理
- 负责任务镜像、事件广播、审批状态机、uploads、Feishu 路由
- 负责状态文件持久化、重启恢复对账、过期审批清理
- 对外暴露 localhost HTTP 和 WebSocket

### VSCode Frontend

- 负责任务列表、编辑器页监视器、任务详情、diff 面板、审批队列、登录状态页
- 负责桌面图片输入和 daemon 交互
- 主监视器通过 `Open Monitor` 命令以 Webview editor tab 打开，而不是常驻侧栏
- VSCode 调试启动项通过 `preLaunchTask` 复用根脚本的一键启动流程
- 监视器页内置任务列表、Conversation、Desktop Composer，以及本地任务多选批量清理
- 监视器页支持对未绑定任务一键 `Bind to New Feishu Topic`，在默认飞书群里创建新话题并立刻绑定当前任务
- 任务卡片同时显示任务启动来源标签和当前 Feishu 绑定标签，例如 `VSCODE + FEISHU`、`CLI + FEISHU`
- 暴露 `openMonitor`、`newTask`、`resumeTask`、`importThreads`、`sendMessage`、`interruptTask`、`approve*`、`retryTurn`、`openDiff`
- 只与本地 daemon 通信，不依赖 OpenAI VSCode 扩展私有实现

### Feishu Frontend

- 一个工作群作为入口
- 每个 bridge task 绑定一个 Feishu 线程或回复链
- 负责移动端对话、审批和控制命令

## 目录结构

- `apps/vscode-extension`: VSCode task dashboard and desktop actions
- `apps/bridge-daemon`: daemon runtime, Codex app-server adapter, Feishu bridge
- `packages/protocol`: shared bridge task, event, approval, and transport contracts
- `packages/shared`: config, filesystem, transport, and utility helpers
- `docker/`: runtime image, compose, env templates
- `docs/`: product, architecture, plan, status, logs, lessons, and agent manual
- `.agent/`: templates and checkpoints for long-running agent work

## 任务与线程模型

- `taskId` is the primary bridge identifier
- `threadId` is the Codex thread identifier
- `taskId = threadId` for bridge-managed tasks
- `manual-import` tasks retain the imported `threadId` and are normalized into the same task model
- One Feishu thread binds to one bridge task

## 核心数据结构

- `BridgeTask`
  - `taskId`, `threadId`, `mode`, `taskOrigin`, `title`, `workspaceRoot`, `status`, `activeTurnId`, `feishuBinding`
- `BridgeEvent`
  - `seq`, `taskId`, `kind`, `timestamp`, `payload`
- `QueuedApproval`
  - `requestId`, `taskId`, `turnId`, `kind`, `reason`, `state`
- `ImageAsset`
  - `assetId`, `localPath`, `mimeType`, `createdAt`
- `DesktopClientState`
  - `clientId`, `kind`, `connectedAt`, `lastSeenAt`

## 输入输出边界

### Daemon HTTP

- `/health`
- `/auth/login/start`
- `/auth/account`
- `/auth/rate-limits`
- `/tasks`
- `/tasks/:id`
- `/tasks/:id/resume`
- `/tasks/:id/messages`
- `/tasks/:id/interrupt`
- `/tasks/:id/uploads`
- `/tasks/:id/approvals/*`
- `/tasks/:id/feishu/bind`
- `/tasks/:id/feishu/topic`
- `/tasks/import`
- `/feishu/webhook`

### Daemon WebSocket

- `snapshot` frame: full daemon snapshot for tasks, account, and rate limits
- `event` frame: bridge event delta with `kind`, `taskId`, `payload`, `seq`, and `timestamp`

## 图片与 uploads 流程

1. VSCode frontend receives a local image input.
2. Frontend posts the base64 payload to `/tasks/:id/uploads`.
3. Daemon writes the file into a persistent uploads directory.
4. Daemon passes the resulting local image reference into the target Codex thread.

## 恢复与持久化

- `BridgeService` 将任务状态持久化到 `stateDir/tasks.json`
- 重启时先加载持久化快照，再用 runtime 当前线程列表对账
- 若 runtime 已回到 `idle/completed/failed/interrupted` 而本地仍有 `pending` approval，会自动转成 `expired`
- Feishu webhook event id 持久化到 `stateDir/feishu-events.json`，用于重复回调去重

## CLI 包装器

- 根脚本 `scripts/bridge-cli.mjs` 提供 `list`、`import`、`resume`、`send`
- 根脚本 `scripts/dev-stack.sh` 提供 `up`、`down`、`status`、`logs` 的一键开发环境启动入口
- 在 `workspace-dev` 容器里使用时，daemon 地址默认应设为 `BRIDGE_BASE_URL=http://bridge-runtime:8787`

## Optional Coordination Utilities

- 根脚本 `scripts/hub-cli.mjs` 提供一个本地多-agent 协调工具集
- 默认 hub 目录可由 `CODEX_FEISHU_BRIDGE_HUB_ROOT` 覆盖
- 这些工具不是 bridge 运行时的必需部分，也不是公开产品主路径

## 容器规范

- Compose services stay `workspace-dev` and `bridge-runtime`
- Devcontainer default workspace stays `/workspace/codex-feishu-bridge`
- `bridge-runtime` mounts a shared Codex home path and an uploads directory
- `bridge-runtime` can also mount `${HOST_CODEX_HOME}` to `/codex-home` and `${HOST_CODEX_BIN_DIR}` to `/opt/host-codex-bin`
- Live `stdio` validation should set `BRIDGE_CODEX_HOME=/codex-home`, `CODEX_RUNTIME_BACKEND=stdio`, and `CODEX_APP_SERVER_BIN=/opt/host-codex-bin/bin/codex.js`
- Host-native Node and TypeScript are optional; container is the default path

## 代码规范

- 默认使用 ASCII
- 包名统一使用 `@codex-feishu-bridge/*`
- 公共接口变更同步更新本文档
- 不把 OpenAI VSCode 扩展私有实现重新引入主路径
