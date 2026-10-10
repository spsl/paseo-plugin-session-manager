# 仓库规则

## 改完代码必须 reload 插件

Paseo daemon 以子进程加载本插件，**源码改动不会自动生效**。改完必须执行：

```sh
npx tsc --noEmit && npm test
paseo plugin reload session-manager
```

- 不需要重启 Paseo，也不会中断正在运行的 Agent。
- reload 只重载服务端；**已经打开的设置页和看板仍是旧代码，需要关掉重开**。
- reload 后确认新 RPC 已注册：`grep "Loaded plugin" ~/.paseo/daemon.log | grep session-manager | tail -1`，看 `methods` 数量和内容。
- reload 失败时查 `paseo plugin ls`（加载错误）和 `paseo plugin logs session-manager`（子进程输出）。

## 验证命令

- `npm run typecheck`：`tsc --noEmit`
- `npm test`：`vitest run`

## 客户端代码约束

设置页和看板跑在 Hermes 上。`shared/` 和 `client/` 中不要使用异步箭头函数，不要在 `for...of` 里写闭包。UI 文案用中文。

## 客户端 effect 注意事项

设置页和看板跑在 Hermes 上，React effect 的清理函数和依赖数组要特别小心：

- **清理函数不要在 effect 因自身 state 更新而重跑时取消进行中的请求**。请求发出后若 `setState` 改变了依赖项，effect 会重跑并执行旧清理函数，把结果静默丢掉。只在组件卸载时取消。
- **请求类 effect 的依赖数组只放真正的外部输入**（如 `config.agent`），不要放自己写入的 state（如 `catalog.loaded`），否则形成自触发循环。
- 排查"数据到了但界面不更新"时，先在服务端打日志确认请求是否到达，再查客户端，不要先猜渲染层。

## 本机分析器

- `codex` / `claude` / `pi` 三个 CLI 已安装，分析器通过起子进程调用。
- Magpie 是 OpenAI 兼容的本地代理：`http://127.0.0.1:3425/v1`，分析器直连它，一次 chat completion，不经过 Agent 循环。
- 排查 analyzer 问题时优先用 `pi --list-models`、`curl http://127.0.0.1:3425/v1/models` 确认真实目录。
