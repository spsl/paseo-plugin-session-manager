# 会话看板（Paseo 插件）

把 Paseo 里的 Agent 会话按状态排成看板。每轮对话结束后，插件用一次只读的 LLM 分析给会话生成中文标题、摘要、当前目标、进展和下一步建议，并判断是否需要你介入。

## 功能

- **六列看板**：不明确、需要处理、进行中、已完成、延迟队列、已关闭。侧边栏入口显示需要处理的会话数量，也可以在独立窗口里打开看板。
- **按项目筛选**：顶部的项目标签显示各项目的会话数，可以多选筛选、搜索项目，点标签旁的跳转按钮在 Paseo 中打开该项目的工作区（有多个工作区时先弹出选择）。
- **新建会话**：看板上的「新建会话」按钮或命令面板里的「新建会话（选择工作区）」打开对话框，搜索并选择工作区，选预设（Agent profile）或提供方、模型、思考强度和权限模式，写好第一条消息后创建。会记住上次用的工作区和每个提供方的选择。
- **状态判断**：优先级依次是手工指定的状态、待授权请求、Agent 正在运行、LLM 分析结论。宽屏下长按卡片拖到其他列可以手工覆盖，也可以在详情里选择或恢复自动状态。
- **稍后处理**：卡片可以推迟一段时间（1 分钟到 4 小时，或今天 / 明天的固定时间点），也可以移入「延迟队列」列，到期自动回到原来的列。
- **会话详情**：「之前 / 现在 / 下一步」概览、每次分析的记录，以及按轮次绘制的 mermaid 流程图（子 Agent 单独成节点）和每轮摘要。
- **会话内操作**：在弹窗里直接对话、回答提问、处理授权，重新打开已关闭的会话。
- **代码审查**：Agent 完成一项代码改动后，插件可以建议或自动发起独立审查。插件只往原会话追加一段可编辑的消息，由原会话用 Paseo 起审查 Agent、逐条复核结果，不会自动修复。
- **语音播报**：会话完成、等待输入、请求授权或出错时播报。可以用 daemon 所在 Mac 的 `say`，也可以用客户端的网页语音；手机上可以改为振动。
- **重启恢复**：Paseo 重启后，按设置自动恢复需要处理的（或全部）会话；`/dev-team` 协调者会收到通知，告诉它哪些带 `team` 标签的子 Agent 被中断了。
- **标题写回**（可选）：把生成的标题写回 Paseo 的 Agent 名称，不会覆盖你手动起的名字。
- **排除会话**：带指定标签的 Agent 不显示也不分析（默认排除 `herald.role`）。

## 分析器

| 分析器 | 调用方式 |
| --- | --- |
| `codex` / `claude` / `pi` | 起本机 CLI 子进程 |
| `magpie` | 直连本机 OpenAI 兼容代理（默认 `http://127.0.0.1:3425/v1`），一次 chat completion，不走 Agent 循环 |

可以在设置页配置模型、思考强度、自定义提示词、可执行文件路径（Magpie 为代理地址和 API Key）、并发数和超时。同一页还有代码审查、重启恢复、语音播报、看板列宽、已关闭会话保留天数等设置。打开设置页时，Pi 和 Magpie 的模型列表会分别从本机 CLI 和代理实时读取。

**隐私**：会话文本只发给你选的分析器，也就是本机 CLI 或本机代理。插件数据保存在 `$PASEO_HOME/plugin-data/session-manager/`。

## 安装

要求：

- Paseo 0.11 以上
- 至少一个已登录的分析器 CLI，或者一个正在运行的 Magpie 代理

```sh
# 从 GitHub 安装
paseo plugin install https://github.com/spsl/paseo-plugin-session-manager.git

# 或者从本地目录安装
git clone https://github.com/spsl/paseo-plugin-session-manager.git
cd paseo-plugin-session-manager
npm install
paseo plugin install .
```

安装后，在 Paseo 侧边栏打开「会话看板」，然后到设置页选分析器。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
paseo plugin reload session-manager
```

- Paseo daemon 以子进程加载插件，改完源码要执行 `reload` 才生效。reload 不会中断正在运行的 Agent。已经打开的设置页和看板还是旧代码，要关掉重开。
- reload 失败时，用 `paseo plugin ls` 看加载错误，用 `paseo plugin logs session-manager` 看子进程输出。
- `client/` 和 `shared/` 跑在 Hermes 上：不要用异步箭头函数，也不要在 `for...of` 循环体里创建闭包。
- 运行时代码不能引用 `@getpaseo/client` 或 `@getpaseo/protocol`，类型要从 `@getpaseo/plugin` 推导，详见 [NOTES-SDK.md](NOTES-SDK.md)。

## 目录结构

```
index.server.ts   服务端入口：生命周期钩子、RPC 注册
index.client.tsx  客户端入口：看板页、设置页、侧边栏、命令
server/           分析器、会话状态存储、流程图、审查、标题写回等
client/           看板、会话弹窗、对话区、设置页等 UI
shared/           前后端共用的类型、RPC 契约和纯逻辑
docs/             技术方案（代码审查、会话流程图）和调研（research/）
```
