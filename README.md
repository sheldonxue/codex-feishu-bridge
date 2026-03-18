# codex-feishu-bridge

`codex-feishu-bridge` 是一个以 CLI 为核心运行时的桥接项目，用来把 Codex 任务同时接到桌面端 VSCode 和移动端飞书上。
它的核心目标是：**让 `codex app-server` 成为真实运行时，而不是把编辑器插件当作任务权威来源。**

英文版说明保留在 [docs/README.en.md](./docs/README.en.md)。

## 项目概览

整个仓库围绕三个产品面展开：

- `Codex CLI + codex app-server`：真实任务运行时与认证层
- `VSCode extension`：桌面端任务列表、diff、审批、图片上传与状态视图
- `Feishu`：移动端对话、控制与任务配置入口

当前推荐的移动端工作流是：

- 在飞书线程里发送第一条普通文本
- 由桥接器回复一张配置卡片
- 在卡片里选择模型、reasoning effort、sandbox、approval policy
- 点击 `Create Task`
- 之后继续在同一线程里用普通文本和 agent 对话

## 核心特性

- 基于 `codex app-server` 的 CLI-first 运行时
- Docker-first 的 TypeScript 开发方式
- VSCode 任务树、详情面板、diff 查看、审批与图片上传
- 飞书 long-connection 接入
- 飞书 card-first 任务创建与控制
- 已有 Codex 线程的导入与恢复能力

## 仓库结构

- `apps/bridge-daemon`：运行时桥、HTTP/WebSocket 服务、Feishu 集成
- `apps/vscode-extension`：桌面端扩展
- `packages/protocol`：共享任务、事件、审批与传输协议
- `packages/shared`：共享配置与文件系统工具
- `docker/`：开发镜像、compose 文件、启动脚本
- `docs/`：公开产品文档与架构说明

## 公开文档

- [产品说明](./docs/prd.md)
- [架构说明](./docs/architecture.md)
- [English README](./docs/README.en.md)

## 快速开始

1. 复制环境文件：

```bash
cp docker/.env.example docker/.env
```

2. 启动开发容器：

```bash
docker compose -f docker/compose.yaml --env-file docker/.env.example up -d workspace-dev
```

3. 进入容器并安装依赖：

```bash
docker compose -f docker/compose.yaml --env-file docker/.env.example exec workspace-dev bash
npm install
```

4. 启动 bridge runtime：

```bash
docker compose -f docker/compose.yaml --env-file docker/.env.example up -d bridge-runtime
```

5. 构建并运行主要测试：

```bash
npm run build:daemon
npm run test:daemon
npm run build:extension
npm run test:extension
```

如果你要跑真实 `stdio` 与真实飞书，请优先直接使用：

```bash
docker compose -f docker/compose.yaml --env-file docker/.env ...
```

## 真实 Runtime 与验证

要复用宿主机上的 Codex 登录态和二进制，请在 `docker/.env` 中设置：

```bash
HOST_CODEX_HOME=/home/you/.codex
HOST_CODEX_BIN_DIR=/path/to/codex-package
BRIDGE_CODEX_HOME=/codex-home
CODEX_RUNTIME_BACKEND=stdio
CODEX_APP_SERVER_BIN=/opt/host-codex-bin/bin/codex.js
```

然后启动 runtime 并检查认证接口：

```bash
docker compose -f docker/compose.yaml --env-file docker/.env up -d bridge-runtime
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/auth/account
curl http://127.0.0.1:8787/auth/rate-limits
```

你也可以运行运行时验证脚本：

```bash
npm run validate:runtime
```

在 `workspace-dev` 容器内可使用：

```bash
BRIDGE_BASE_URL=http://bridge-runtime:8787 npm run validate:runtime:container
```

## VSCode 使用方式

先构建扩展：

```bash
npm run build:extension
```

然后在 VSCode 打开仓库，并运行 [`.vscode/launch.json`](./.vscode/launch.json) 中的 `Codex Feishu Bridge Extension`。

扩展当前提供：

- 任务树
- 任务详情面板
- diff 打开
- 状态视图
- 桌面端审批处理
- 图片上传

## 飞书使用方式

推荐的移动端路径是官方 SDK 的 long-connection 客户端。

至少设置：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_DEFAULT_CHAT_ID` 或 `FEISHU_DEFAULT_CHAT_NAME`

如果你只知道群名，可以先解析可见群：

```bash
node --env-file=docker/.env --import tsx scripts/resolve-feishu-chat.ts --list
node --env-file=docker/.env --import tsx scripts/resolve-feishu-chat.ts --name "你的飞书群名"
```

如果设置了 `FEISHU_DEFAULT_CHAT_NAME`，`bridge-daemon` 会在启动时自动解析精确的 `chat_id`。

### 从飞书后台提取配置

按下面的顺序取值，基本就能把 `docker/.env` 配齐：

1. 打开飞书开放平台并创建或进入一个自建应用
   控制台入口：
   `https://open.feishu.cn/app`

2. 复制应用凭证
   在应用基础信息页中获取：
   - `App ID` -> `FEISHU_APP_ID`
   - `App Secret` -> `FEISHU_APP_SECRET`

3. 开启机器人能力，并把机器人拉进目标群
   如果机器人没进群，bridge 无法接收该群的消息。

4. 开启长连接事件订阅
   在事件订阅中选择 long-connection，并至少开启：
   - `im.message.receive_v1`
   - `card.action.trigger`

5. 确定默认群的识别方式
   支持两种：
   - 推荐：`FEISHU_DEFAULT_CHAT_NAME`
   - 固定值：`FEISHU_DEFAULT_CHAT_ID`

   如果你想从后台配置完后再确定 `chat_id`，通常最方便的方式是先让机器人进群，然后运行：

   ```bash
   node --env-file=docker/.env --import tsx scripts/resolve-feishu-chat.ts --list
   node --env-file=docker/.env --import tsx scripts/resolve-feishu-chat.ts --name "你的飞书群名"
   ```

6. 只有在你明确启用 webhook 兼容路径时，才需要额外配置：
   - `FEISHU_VERIFICATION_TOKEN`
   - `FEISHU_ENCRYPT_KEY`

   如果需要 `/feishu/webhook` 兼容入口，请到事件与回调安全配置中复制：
   - `Verification Token` -> `FEISHU_VERIFICATION_TOKEN`
   - `Encrypt Key` -> `FEISHU_ENCRYPT_KEY`

### 最小环境示例

按群名自动解析：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DEFAULT_CHAT_NAME=你的飞书群名
```

按固定群 ID：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DEFAULT_CHAT_ID=oc_xxx
```

### 飞书排错清单

如果 bridge 启动了，但群里没有任何反应，请依次检查：

- 机器人是否真的已经加入目标群
- 目标群是否和 `FEISHU_DEFAULT_CHAT_ID` 或 `FEISHU_DEFAULT_CHAT_NAME` 一致
- long-connection 事件订阅是否已开启
- `im.message.receive_v1` 是否已开启
- card-first 交互需要的 `card.action.trigger` 是否已开启
- bridge 是否真的在读取 `docker/.env` 中的目标值

### 当前飞书工作流

当前推荐的飞书端使用方式是：

1. 新开一个飞书话题或线程
2. 发第一条普通文本，描述你要做的事情
3. 让 `bridge-daemon` 回复一张配置卡片
4. 在卡片里选择模型、reasoning effort、sandbox、approval policy
5. 点击 `Create Task`
6. 在同一线程里继续用普通文本对话
7. 用控制卡处理状态、interrupt、retry、审批、解绑等动作

移动端线程会尽量保持纯净，只保留：

- 配置卡片
- 控制卡片
- agent 最终回复
- 审批消息
- 明确错误
- 必要命令结果

slash 命令仍然保留为兼容兜底，但不再是推荐主路径。

## 运行说明

- `bridge-daemon` 是本地桥接编排器
- `codex app-server` 由 daemon 托管，负责真实线程运行
- VSCode 通过 localhost HTTP/WebSocket 与 daemon 通信
- 当前推荐的飞书 live path 是官方 SDK long-connection，而不是公网回调 URL
- `/feishu/webhook` 仍可作为兼容入口保留
- daemon 会暴露 `/tasks`、`/tasks/import`、`/tasks/:id/resume`、`/tasks/:id/messages`、`/tasks/:id/uploads`、`/tasks/:id/approvals/*` 和 `/feishu/webhook`
- daemon 会把任务状态持久化到 `.tmp/`，并在重启时做恢复对账
- 真实联调建议使用 `CODEX_RUNTIME_BACKEND=stdio`
- 在 Docker 中复用宿主机登录态依赖 `HOST_CODEX_HOME -> /codex-home`
- 在 Docker 中复用宿主机 Codex 可执行入口依赖 `HOST_CODEX_BIN_DIR -> /opt/host-codex-bin`
- `npm run validate:runtime` 默认是只读检查
- `npm run validate:runtime -- --create-thread` 会创建并恢复真实线程，但不发送 prompt

## 仓库地图

- `apps/vscode-extension`：桌面端任务、审批、diff、图片输入
- `apps/bridge-daemon`：daemon 运行时与 Feishu 路由
- `packages/protocol`：共享任务、事件、审批与传输协议
- `packages/shared`：共享配置、文件系统与传输工具
- `docker/`：compose、镜像与环境模板
- `docs/`：产品、架构与补充文档
