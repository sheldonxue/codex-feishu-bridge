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
- 当 `CODEX_RUNTIME_BACKEND=socket-proxy` 时，真正执行任务的 `codex app-server` 由一个宿主机 sidecar 托管，并通过项目 `.tmp/` 下的 Unix socket 暴露给容器内 daemon
- 这个 socket-proxy 模式用于 imported host threads：绑定 Feishu 后仍保留宿主机原始文件视野，而不需要把整个 daemon 裸跑到宿主机

### Bridge Daemon

- 容器内常驻服务
- 在默认 `stdio` 模式下直接管理 `codex app-server` 子进程
- 在 `socket-proxy` 模式下改为连接宿主机 sidecar 暴露的 Unix socket，但 Feishu、HTTP、WebSocket、状态持久化仍然留在容器里
- 负责任务镜像、事件广播、审批状态机、uploads、Feishu 路由
- 负责状态文件持久化、重启恢复对账、过期审批清理
- 对外暴露 localhost HTTP 和 WebSocket

### VSCode Frontend

- 负责任务列表、编辑器页监视器、任务详情、diff 面板、审批队列、登录状态页
- 负责桌面文本、图片、文件输入和 daemon 交互
- 主监视器通过 `Open Monitor` 命令以 Webview editor tab 打开，而不是常驻侧栏
- VSCode 调试启动项通过 `preLaunchTask` 复用根脚本的一键启动流程，并在 Extension Development Host 里自动打开 monitor
- 监视器页内置任务列表、Conversation、Desktop Composer，以及本地任务多选批量清理
- Desktop Composer 可直接设置后续 turn 的 `model`、`effort`、`planMode`，并附加本地照片或文件
- 监视器页支持对未绑定任务一键 `Bind to New Feishu Topic`，在默认飞书群里创建新话题并立刻绑定当前任务
- 监视器页支持直接重命名任务；这会更新 bridge task 标题，并同步到任何已绑定的 Feishu 主任务卡
- 任务卡片同时显示任务启动来源标签和当前 Feishu 绑定标签，例如 `VSCODE + FEISHU`、`CLI + FEISHU`
- 监视器页可切换“Feishu 在运行中发来的消息是直接 steer 当前 turn，还是 queue 到下一轮”
- 暴露 `openMonitor`、`newTask`、`resumeTask`、`importThreads`、`sendMessage`、`interruptTask`、`approve*`、`retryTurn`、`openDiff`
- 只与本地 daemon 通信，不依赖 OpenAI VSCode 扩展私有实现

### Feishu Frontend

- 一个工作群作为入口
- 每个 bridge task 绑定一个 Feishu 线程或回复链
- 负责移动端对话、审批和控制命令
- 未绑定线程先进入 draft card；draft 与已绑定任务卡都可设置 `model`、`effort`、`planMode`
- Feishu 的文本、图片、文件消息都可以进入同一个 task；图片走原生图像输入，文件作为本地路径附件交给 Codex
- 已绑定任务卡提供 `View Status`、`Stop Turn`、`Retry Last Turn`、`Rename Task`、`Archive Task`、`Unbind Thread`
- `Rename Task` 会先下发一张独立的重命名卡；提交后会更新共享 task 标题，并同步回 VSCode monitor 与 Feishu 主任务卡
- 已绑定任务卡可切换“Feishu 在运行中发来的消息是 steer 当前 turn，还是 queue 到下一轮”
- `Archive Task` 会终结当前 Feishu 话题的 bridge 绑定能力；后续同话题里的文本、图片、文件不会再继续同步到主机任务

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
- 手动重命名后的 `title` 会被 bridge 持久化，并优先于后续 runtime thread name 同步结果，直到再次显式重命名

## 核心数据结构

- `BridgeTask`
  - `taskId`, `threadId`, `mode`, `taskOrigin`, `title`, `titleLocked`, `workspaceRoot`, `status`, `activeTurnId`, `feishuBinding`, `feishuRunningMessageMode`, `queuedMessageCount`
- `BridgeEvent`
  - `seq`, `taskId`, `kind`, `timestamp`, `payload`
- `QueuedApproval`
  - `requestId`, `taskId`, `turnId`, `kind`, `reason`, `state`
- `TaskAsset`
  - `assetId`, `kind`, `displayName`, `localPath`, `mimeType`, `createdAt`
- `DesktopClientState`
  - `clientId`, `kind`, `connectedAt`, `lastSeenAt`

## 输入输出边界

### Daemon HTTP

- `/health`
- `/auth/login/start`
- `/auth/account`
- `/auth/rate-limits`
- `/models`
- `/tasks`
- `/tasks/:id`
- `/tasks/:id/resume`
- `/tasks/:id/messages`
- `/tasks/:id/title`
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

## 附件与 uploads 流程

1. VSCode frontend or Feishu bridge receives a local image/file input.
2. Frontend posts the base64 payload to `/tasks/:id/uploads`.
3. Daemon writes the file into a persistent uploads directory.
4. 图片附件会作为 `localImage` 输入项直接传给 Codex。
5. 通用文件附件会记录为 task asset，并在用户消息里附带本地文件路径提示，让 Codex 通过工具从磁盘读取。

## 恢复与持久化

- `BridgeService` 将任务状态持久化到 `stateDir/tasks.json`
- 重启时先加载持久化快照，再用 runtime 当前线程列表对账
- 若 runtime 已回到 `idle/completed/failed/interrupted` 而本地仍有 `pending` approval，会自动转成 `expired`
- Feishu webhook event id 持久化到 `stateDir/feishu-events.json`，用于重复回调去重
- Feishu draft card、任务控制卡和 archived thread 状态也持久化到 `stateDir/feishu-events.json`

## CLI 包装器

- 根脚本 `scripts/bridge-cli.mjs` 提供 `list`、`import`、`resume`、`send`
- 根脚本 `scripts/dev-stack.sh` 提供 `up`、`monitor`、`down`、`status`、`logs` 的一键开发环境启动入口，并会在首次运行时自动创建、补齐 `docker/.env`
- `scripts/dev-stack.sh up|monitor` 可选附带 `stdio` 或 `socket-proxy` 参数，用来显式切换 Docker-host 权限模式
- 根 `package.json` 提供 `start:socket-proxy`、`monitor:socket-proxy` 等 npm 包装命令，用于不手改 `.env` 的一键启动
- 当 `CODEX_RUNTIME_BACKEND=socket-proxy` 时，`scripts/dev-stack.sh up` / `monitor` 会先在宿主机启动一个薄的 `codex app-server` socket proxy，再拉起容器内 `bridge-runtime`
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
- `socket-proxy` validation should keep `bridge-daemon` in Docker, set `CODEX_RUNTIME_BACKEND=socket-proxy`, and let the host sidecar expose `codex app-server` through `.tmp/codex-runtime-proxy.sock`
- Host-native Node and TypeScript are optional; container is the default path

## 代码规范

- 默认使用 ASCII
- 包名统一使用 `@codex-feishu-bridge/*`
- 公共接口变更同步更新本文档
- 不把 OpenAI VSCode 扩展私有实现重新引入主路径
