# codex-feishu-bridge

`codex-feishu-bridge` 是一个以 CLI 为核心运行时的桥接项目，用来把 Codex 任务同时接到桌面端 VSCode 和移动端飞书上。
它的核心目标是：**让 `codex app-server` 成为真实运行时，而不是把编辑器插件当作任务权威来源。**

英文版说明保留在 [docs/README.en.md](./docs/README.en.md)。

## 项目概览

整个仓库围绕三个产品面展开：

- `Codex CLI + codex app-server`：真实任务运行时与认证层
- `VSCode extension`：飞书对话任务的图形化监视器，用于桌面端持续监控、接管与审批
- `Feishu`：移动端对话、控制与任务配置入口

当前推荐的移动端工作流是：

- 在飞书线程里发送第一条普通文本
- 由桥接器回复一张配置卡片
- 在卡片里选择模型、reasoning effort、sandbox、approval policy
- 点击 `Create Task`
- 之后继续在同一线程里用普通文本和 agent 对话

另一个常见场景是：

- 你在主机上已经启动了工作任务，但准备离开工位
- 把这个任务同步或绑定到 Feishu 线程
- 之后在手机上继续看回复、处理审批、必要时 interrupt 或补一句 steer
- 回到工位后，再在 VSCode 里无缝接管同一条线程

## 核心特性

- 基于 `codex app-server` 的 CLI-first 运行时
- Docker-first 的 TypeScript 开发方式
- VSCode 常驻监视器视图、任务树高亮、diff 查看、审批与桌面接管输入
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

推荐默认入口：

```bash
./scripts/dev-stack.sh up
```

也可以用 npm 包一层：

```bash
npm run start:all
```

这条命令会自动完成：

- 不存在时创建 `docker/.env`
- 构建并启动 `workspace-dev`
- 在容器里安装依赖
- 构建 `shared`、`protocol`、`bridge-daemon`、`vscode-extension`
- 重建并启动 `bridge-runtime`
- 等待 `/health` 就绪

首次使用前，如果你要接真实 Feishu 或真实 `stdio`，请先编辑：

```bash
docker/.env
```

启动后：

1. 在 VSCode 打开仓库
2. 直接按 `F5` 运行 `Codex Feishu Bridge Extension`
3. 新开的 `Extension Development Host` 会连接本地 bridge
4. 运行命令 `Codex Bridge: Open Monitor`

常用配套命令：

```bash
npm run status:all
npm run logs:all
npm run stop:all
```

如果你更想看底层手工步骤，仍然可以直接使用 `docker compose`，但 README 现在默认推荐上面的“一键启动”路径。

## 一键启动做了什么

根脚本 [scripts/dev-stack.sh](./scripts/dev-stack.sh) 提供：

- `up`：准备环境、安装依赖、构建产物、启动 runtime、等待健康检查
- `down`：停止整套容器
- `status`：查看 compose 状态和 `/health`
- `logs`：跟随 `bridge-runtime` 日志

VSCode 的 [`.vscode/launch.json`](./.vscode/launch.json) 也已经挂上同一条启动任务，所以在仓库里按 `F5` 时，会先自动准备好本地 bridge 开发环境。

## 手工路径

如果你要跑真实 `stdio` 与真实飞书，或者想跳过一键脚本直接控制 compose，请优先直接使用：

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

## VSCode 图形化监视器

在 VSCode 打开仓库后，直接运行 [`.vscode/launch.json`](./.vscode/launch.json) 中的 `Codex Feishu Bridge Extension` 即可。
这个启动项现在会先自动执行 `Codex Bridge: One Click Start` 任务，再打开新的 `Extension Development Host` 窗口。
这会启动一个新的 `Extension Development Host` 窗口；扩展当前默认在这个测试窗口里运行，而不是直接注入你正在编辑代码的主窗口。

扩展现在定位为 **Feishu 对话任务的图形化监视器**。推荐桌面工作流是：

1. 先运行 `./scripts/dev-stack.sh up`，或者直接按 `F5`
2. 确认：
   - `curl http://127.0.0.1:8787/health`
   - 返回 `backend=stdio` 或 `backend=mock`
3. 切到新打开的 `Extension Development Host`
4. 通过命令面板运行 `Codex Bridge: Open Monitor`
5. 先在监视器页里点击：
   - `Refresh`
   - 如果你想把宿主机最近的 Codex 历史线程拉进监视器，再点击 `Import Recent Host Threads`
6. 在飞书里发起或推进任务线程
7. 在监视器页面的 `Tasks` 列表里观察全部任务，并优先关注已绑定飞书线程的任务
8. 在 `Codex Feishu Monitor` 编辑器页面里查看：
   - 任务状态、workspace、threadId、Feishu 绑定信息
   - 会话消息流与消息来源（`feishu` / `vscode` / `runtime`）
   - pending approvals
   - diff 摘要
9. 直接在页面底部的常驻输入框里发消息，不再依赖弹窗输入框
10. 在同一页里处理中断、重试、审批、diff 打开、解绑，以及 TASK 多选批量清理本地任务

桌面端发起的消息默认不会被镜像成飞书里的用户原文；但对于已经绑定飞书线程的任务，你可以在监视器里切换“桌面回复继续同步回飞书”的任务级开关。

### 监视器里会看到什么

- `Codex Feishu Monitor`
  - 这是以 VSCode 编辑器页形式打开的主交互面
  - 页面顶部显示 daemon 连接、账号、限流和导入入口
  - `Tasks` 列表展示当前 bridge 已知的全部任务，并区分 `FEISHU`、`VSCODE`、`CLI` 等启动来源与绑定标签
  - 会显示当前选中任务的消息流、审批、diff、飞书绑定信息和桌面同步开关
  - 底部有常驻输入框，适合桌面端持续接管任务
  - 本地未绑定任务支持多选后批量 `Forget Selected` 或 `Delete Selected`

### `Import Recent Host Threads` 是什么

这个按钮的用途是把宿主机 `~/.codex` 中**最近的、尚未进入 bridge 的线程**显式拉进监视器。

它的设计目标是：

- 默认不把所有历史线程都灌进任务列表
- 保持监视器聚焦于当前桥接任务和最近活动
- 需要时再把最近的宿主机线程导入

需要注意：

- 它主要导入最近的 `notLoaded` 宿主机线程
- 如果宿主机当前确实有正在运行的活跃线程，bridge 也会自动发现并显示
- 如果你只看到了 VSCode/OpenAI 扩展自己的 `codex app-server` 进程，但监视器里还是空，通常意味着当前没有活跃线程，只有历史线程；这时就应使用 `Import Recent Host Threads`

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

如果你已经在主机上跑着任务，另一个推荐路径是：

1. 在桌面端先让任务继续运行
2. 离开工位前，把这个任务导入或绑定到同一个飞书线程
3. 在手机上继续收回复、看进度、处理审批
4. 需要时在飞书里 interrupt、retry 或补一句 steer
5. 回到工位后，再在 VSCode 里继续接管这条线程

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
- VSCode 监视器通过 localhost HTTP/WebSocket 与 daemon 通信
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

- `apps/vscode-extension`：飞书任务图形化监视器与桌面接管入口
- `apps/bridge-daemon`：daemon 运行时与 Feishu 路由
- `packages/protocol`：共享任务、事件、审批与传输协议
- `packages/shared`：共享配置、文件系统与传输工具
- `docker/`：compose、镜像与环境模板
- `docs/`：产品、架构与补充文档
