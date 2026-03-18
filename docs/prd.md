# PRD

## 产品定位

`codex-feishu-bridge` 是一个以 `Codex CLI + codex app-server` 为真实运行后端的多端桥接工程。
它让同一个 Codex 线程可以被桌面端的 VSCode 前端和手机端的 Feishu 线程同时监视与控制。

## 目标用户

- 在 Linux 或其他桌面环境中使用 Codex CLI 的开发者
- 需要不在工位时，也能直接用手机远程启动 Codex 任务的开发者
- 需要离开工位后，继续在手机端监工主机长任务的开发者
- 需要在手机端跟进多任务执行状态并进行远程协作的个人或小团队
- 需要把任务状态、审批、diff 和对话沉淀为标准化桥接协议的工程团队

## 核心功能

- 多任务同步：按 `Codex thread = bridge task = Feishu thread` 的方式同步多个任务
- 双端交互：桌面端用 VSCode 前端处理 diff、图片输入和审批，手机端用 Feishu 处理监视和控制
- 运行时桥接：通过 `codex app-server` 暴露认证、线程、turn、审批和事件流
- 多模态支持：桌面端支持本地图片输入并将其转成 Codex 本地图片资产
- 手工 CLI 接管：允许导入和恢复用户手工运行产生的 Codex 线程
- Docker-first 开发：Node、TypeScript 和 bridge runtime 默认在 Docker 内运行

## 非目标

- 一期不自建公网 relay
- 一期不保证实时附着任意外部正在运行的裸 `codex` 进程
- 一期不依赖 OpenAI VSCode 扩展内部实现
- 一期不提供 Linux 原生 ChatGPT 桌面 app

## 技术栈

- Codex CLI
- codex app-server
- TypeScript monorepo
- npm workspaces
- Docker Compose
- VSCode extension API
- Feishu bot or app callbacks

## 用户流程

1. 用户在宿主机完成 Codex CLI 的 ChatGPT 账号登录。
2. `bridge-daemon` 启动 `codex app-server` 并接管认证和线程生命周期。
3. 用户可以在 VSCode 前端创建、恢复或导入任务，也可以直接在飞书里远程发起新任务。
4. daemon 将任务状态、审批和 diff 更新同步到 Feishu 线程。
5. 用户离开工位后，仍可在手机端继续监工主机任务，查看回复、处理审批，必要时 steer 或 interrupt。
6. VSCode 前端同步展示任务详情、diff 和待处理动作。

## 成功标准

- 在 Ubuntu 上可用 ChatGPT 账号登录 Codex CLI 并读取账户状态
- 能同时管理多个 bridge-managed 任务，并同步到 Feishu 线程
- 桌面端能查看任务详情、diff、审批和图片输入结果
- Feishu 线程中的控制命令能正确路由到目标任务
- 项目文档足够让 agent 在下一次会话快速恢复上下文
