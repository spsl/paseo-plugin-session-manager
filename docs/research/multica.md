# Multica 调研：任务管理与 AI 团队，对照我们的 Paseo 方案

- 调研对象：Multica main `691e5b4`（2026-10-13，最新 tag v0.6.1），浅克隆在 `/tmp/multica-research/multica`。只读，没有运行其中任何代码。
- 前提：单人、本地。凡是为多人协作、云端、多机设计的机制，都按这个前提评估。
- 我们的现状：
  - `/dev-team` skill：`~/SKILLS/dev-team/SKILL.md`（下文简称 SKILL）、`~/SKILLS/dev-team/references/prompts.md`（简称 prompts）；
  - 会话看板插件：本仓库；
  - Paseo 原生能力。
- 标注约定：
  - 【推断】：我的推断，源码里没有直接看到；
  - 【仅依据文档】：只查到 Multica 官方文档，没有核对到源码。
- 路径约定：Multica 路径相对仓库根目录。

  | 简称 | 实际路径 |
  |---|---|
  | `文档/x.mdx` | `apps/docs/content/docs/x.mdx`（随代码发布的官方文档） |
  | `brief` | `server/internal/daemon/execenv/runtime_config_sections.go`（每次 run 注入给 agent 的任务简报） |
  | `svc/` | `server/internal/service/` |
  | `hdl/` | `server/internal/handler/` |
  | `mig/` | `server/migrations/` |
  | `sql/` | `server/pkg/db/queries/` |

---

## 1. 摘要

1. **失败分级加一次自动续跑**（落地到 dev-team，成本低）。Multica 只自动重试基础设施类失败（中断、超时、网络），并续用原会话；会污染会话的失败（如上下文溢出）开新会话，但保留工作目录；限流、认证、配置类错误不重试，交给人处理（`svc/task.go:5256-5321`）。dev-team 现在对任何出错都是"汇报用户、等同意"，可以按这个思路分级。
2. **状态由 agent 显式声明，平台不靠推断**（落地到看板，成本低）。Multica 的 brief 要求 agent 自己写 `in_progress`、`in_review`、`blocked`（`brief:771-791`）。我们的子 agent 已经按约定在回复首行写「完成 / 阻塞 / 失败」，看板却没读这一行，状态全靠 LLM 推断。把这一行解析成确定性状态即可。
3. **中断要回流给协调者**（落地到看板插件，配合 dev-team，成本中低）。Multica 在 daemon 重启后，把丢失的 run 标为 `runtime_recovery` 并自动重试；被委派的任务最终失败时，用一条系统评论唤醒协调者（`svc/task.go:5985`、`6248-6262`）。Paseo 重启后，中断的子 agent 不会发完成通知，协调者会一直等。插件已经记录了 `interruptedAt`，可以替用户发出「继续 <ID>」。
4. **运行期间的追加输入合并成一次后续运行，并持久化**（落地到看板插件，成本中）。Multica 保证一个 agent 正在运行时最多再有一个待执行的后续 run，期间到达的评论都合并进这一个 run，运行完成后再对账补漏（`mig/150`、`hdl/daemon.go:4465`）。看板的排队消息目前只存在客户端，逐条发送、每条各起一轮，而且只在面板打开时才会发出。
5. **dev-team 的骨架方向是对的，不必重做**。Multica 的 squad leader 协议与我们的协调者几乎一致：只派活不干活、派完即停、每轮留下评估记录、成员回报后再被唤醒（`hdl/squad_briefing.go:33-108`）。Multica 其余大部分复杂度来自多人、云端、多机（领取锁、租约、评论路由、权限、归因），不适合单人本地场景。

---

## 2. Multica 功能地图

### 2.1 任务管理

- **Issue 和 Run 分开记录**
  - issue 保存目标、讨论、负责人和状态；run 是 agent 的一次执行。一个 issue 可以对应多个 run（`文档/tasks.mdx:12-20`）。
  - run 的 `completed` 不等于 issue 完成，是否完成看 issue 状态（`文档/tasks.mdx:140-144`）。
- **数据模型**
  - `issue` 表包含：status、priority（urgent / high / medium / low / none）、多态 assignee（member / agent / squad）、`parent_issue_id`、子 issue 的 `stage`、供 agent 存放流水线状态的 `metadata` JSONB（上限 8KB）、自定义 `properties`，以及用于乐观锁的 `revision`。
  - 出处：`mig/001_init.up.sql:52-72`、`mig/084_squad.up.sql:30-33`、`mig/123_issue_stage.up.sql`、`mig/105`、`mig/351`。
- **状态生命周期**
  - 7 个内置状态分属 4 个类别：unstarted（backlog、todo）、started（in_progress、in_review、blocked）、done、closed（cancelled）。
  - 自定义状态只继承类别的生命周期语义，不继承内置状态的特殊行为，例如 backlog 停车、blocked、in_progress 失败回滚（`docs/issue-status-lifecycle-rollout.md:5-16,37-41`、`文档/issues.mdx:41-97`）。
  - 没有强制的状态迁移矩阵。文档原话是 "This is not a workflow engine"（`rollout:40`）。
- **谁来写状态**
  - agent 按 brief 自己写：开工先写 `in_progress`，交付写 `in_review`，卡住写 `blocked` 并发评论说明，答疑类的回合不写，`done` 留给人（`brief:771-791`）。
  - 平台只在两种情况下自动改状态：
    - run 失败、没有其他活跃 run、也没有排队的重试时，把 `in_progress` 回滚为 `todo`（`svc/task.go:6079-6118`）；
    - 关联的 PR 全部合并后，把 issue 改为 `done`（`文档/issues.mdx:68-73`）。
- **什么写入会触发 agent 干活**
  - 所有规则都在同一个函数 `WillEnqueueRun` 里判断（`svc/issue_trigger.go:97`）：
    - backlog 视为停车，不触发；
    - Triage 状态下拒绝触发；
    - 派给 squad 时，实际触发的是 squad 的 leader。
  - 指派时有确认框，可选 "Don't start yet"，命令行对应 `--no-start`（`文档/assigning-issues.mdx:45-51,82`）。
  - 改派或改状态都不会中止已经开始的 run，只有删除 issue 才会取消（`hdl/issue.go:4080-4089`）。
- **评论与路由**
  - 评论按以下优先级决定唤醒谁（`hdl/comment.go:2700-2792`）：
    1. 以 `/note` 开头的评论不触发任何 agent；
    2. 显式 @agent 或 @squad 优先；
    3. 有 @all 或 @member 时，不再做隐式路由；
    4. agent 写的评论只回流给 squad leader；
    5. 回复某个 agent 的评论，唤醒该 agent；
    6. 否则唤醒该讨论串的发起者；
    7. 最后兜底给 assignee。
  - **连续评论会合并**：
    - 同一 (issue, agent, 讨论串) 最多只有一个待执行 run（`mig/452_agent_task_pending_thread_unique.up.sql:2-5`）；
    - 运行期间新来的评论合并进下一次后续 run，prompt 中写明 "also covers N earlier comment(s)"（`mig/150` 头注释、`server/internal/daemon/prompt.go:402`）；
    - run 完成时再对账，补发没被处理的评论（`hdl/daemon.go:4465`）。
- **子 issue 与阶段**
  - 子 issue 可以标 stage。某个 stage 全部关闭时，平台唤醒父 issue 的负责人推进下一阶段（`svc/issue_wakeup_condition.go:545-598`、`svc/issue_wakeup_system.go:44-52`）。
  - `issue_dependency` 表存在，但代码里没有读写它。【推断：功能未实现】
- **优先级**：入队时把 issue 优先级快照到任务上，领取时按 `priority DESC, created_at ASC` 排序（`sql/agent.sql:806`）。
- **视图**：list、board、table、gantt、swimlane 五种，支持保存视图（`文档/issues.mdx:111-113`）。
- **通知（Inbox）**
  - 只发给人，agent 不读 Inbox。同一个 issue 的多条通知合并成一条。
  - issue 交还给人（in_review、done 等）时，失败通知自动归档；blocked 例外，失败通知保留（`文档/inbox.mdx:8-48`）。【仅依据文档】
- **Wakeup（等待某个事实成立再唤醒）**
  - agent 或人在 issue 上存一条规则，类型可以是事件、条件或定时。规则存好后本 run 正常结束，输入到达时平台再起一次普通 run，期间没有挂起的进程（`docs/engineering/issue-wakeups.md:3-8`、`mig/509`、`mig/553`、`mig/557`）。
  - 防失控措施（`svc/issue_wakeup_activity.go:17-21`、`svc/issue_wakeup.go:1284-1318`）：
    - 一小时内最多 12 次；
    - 检测到触发链回环就暂停；
    - 默认最多触发 20 次（`max_fires`）。
  - 唤醒时的 prompt 强调 "the trigger reports a fact, not business completion"（`server/internal/daemon/prompt.go:216`）。
- **Autopilot**
  - 由 cron 或 webhook 触发，可以建 issue 后指派，也可以直接起 run（`文档/autopilots.mdx:26-35`）。
  - 过去 7 天失败率达到 90% 时自动暂停（`:127-131`）。【仅依据文档】

### 2.2 AI 团队

- **agent 即成员**
  - agent 可以被指派、被 @，由 instructions、模型、skills、运行时组成。
  - 权限分三级：仅自己、指定人、整个 workspace（`文档/agents.mdx:17`、`文档/assigning-issues.mdx:53-61`）。【仅依据文档】
- **Squad（leader 加成员）**
  - leader 必须是 agent，成员可以是人也可以是 agent。
  - 角色描述只给 leader 看，不授予任何权限。
  - 派给 squad 时只唤醒 leader（`文档/squads.mdx:8-38`）。
  - leader 协议是硬编码的（`hdl/squad_briefing.go:33-108`）：
    1. 只协调，不亲自干活；
    2. 用一条评论 @ 选中的成员，委派措辞要简短，不复述 issue；
    3. 每一轮都用 `multica squad activity <issue> action|no_action|failed --reason` 留下评估记录；
    4. 派完即停；
    5. 被重新唤醒后决定：继续委派、升级给人，或者收尾转 `in_review`。
- **什么情况会重新唤醒 leader**
  - 成员发了不带 @ 的进度更新，会唤醒；
  - 有人显式 @ 了别人，不唤醒；
  - leader 自己的评论不会唤醒自己。
  - 出处：`文档/squads.mdx:52-68`、`hdl/comment.go:2739-2760`。
- **交接**
  - @mention 会给对方起一个新 run，但不改变 assignee。
  - agent 之间互相 @ 时，平台只做去重，不判断协作何时结束。文档要求"把停止条件写进 instructions"（`文档/mentioning-agents.mdx:71-73`）。
- **委派失败回流**
  - 委派血缘记在 `delegated_from_task_id`（`mig/184_agent_task_attribution.up.sql:35-44`）。
  - 被委派的任务最终失败、且没有待执行的重试时，平台在协调者的 issue 上写一条系统评论："inspect the failed work, then reassign it, skip it, or end the workflow explicitly"，并派发一个恢复 run（`svc/task.go:6248-6262,6273-6300`）。
- **人工介入点**
  - 指派确认、`--no-start`、触发预览；
  - 交付进 `in_review`，`done` 留给人；
  - 运行中插话（steer）：注入文本固定为 "[ADDITIONAL GUIDANCE] … not as a replacement … no separate acknowledgement"（`server/internal/daemon/task_supplement.go:90-105`）；
  - 在执行日志里停止或重试 run。
  - **没有逐工具授权**：Claude 以 `--permission-mode bypassPermissions` 启动（`server/pkg/agent/claude.go:1084`），人的介入发生在 issue 层面。
- **阻塞与失败上报**
  - agent 写 `blocked` 并发评论说明（`brief:783`）。
  - run 失败时带 `failure_reason`，分为平台类和 `agent_error.*` 两组，共二十多种，每种附处理建议（`文档/tasks.mdx:88-124`）。
- **进度汇报与产出**
  - 结果必须通过 CLI 发成评论，终端输出不算交付（`brief:775`）。
  - agent 在本 run 中一条评论都没发时，平台把它的最终输出脱敏后发成兜底评论；超过 8000 字符则只发一条提示（`svc/task.go:156-175`）。
  - brief 禁止"把工作放到后台、然后结束本轮"：顶层回合一结束，task 即终结，后台的工作会丢失（`brief:102`）。
- **记忆与 skill 沉淀**
  - skills 由人创建或导入，再绑定到 agent，从后续 run 开始生效（`文档/skills.mdx:20-39,79-97`）。没有看到 agent 自动沉淀 skill 的机制。【仅依据文档】
  - 会话延续：同一 (agent, issue) 的后续 run 和重试，会恢复上一次的 session 和工作目录（`sql/agent.sql:1041`）。

### 2.3 运行时与可靠性

- **run 的状态**：deferred、queued、dispatched、waiting_local_directory、running、completed、failed、cancelled（`文档/tasks.mdx:35-46`）。
- **领取任务**
  - 服务端通过 WebSocket 推送唤醒，另有 30s 轮询兜底（`CLI_AND_DAEMON.md:302-308`）。
  - `ClaimAgentTask` 用 `FOR UPDATE SKIP LOCKED` 加锁：同一 (issue, agent) 串行，不同 agent 可以并行处理同一个 issue（`sql/agent.sql:749-810`）。
- **超时**
  - dispatched 状态超过 5 分钟判为失败（`server/cmd/server/runtime_sweeper.go:74`）。
  - running 状态没有时长上限，存活由以下机制判断（`CLI_AND_DAEMON.md:310-320`、`runtime_sweeper.go:24-47`）：
    - 15s 一次心跳；
    - 2h 无活动的看门狗；
    - 运行时失联后有 3h 宽限期。
- **重试**
  - 任务上记 `attempt` 和 `max_attempts`，默认 2（`mig/055_task_lease_and_retry.up.sql:7-24`）。
  - 只有以下原因会自动重试：runtime_offline、runtime_recovery、timeout、codex 长时间无有效输出、provider_network、skill 包下载失败（`svc/task.go:5256-5263`）。
  - 网络中断最多 3 次，最后一次延迟 5s 再试（`:5278-5301`）。
  - 判断是否允许重试的函数是 `retryEligible`（`:5392`）。
  - 会污染会话的失败（上下文溢出等），重试时开新 session，但保留工作目录（`:5321`、`文档/tasks.mdx:126-131`）。
- **恢复**
  - daemon 重启后，把它上报丢失的任务以 runtime_recovery 失败，然后走自动重试（`svc/task.go:5985`）。
  - 失败后按需回滚 issue 状态（`:6079-6118`）。

---

## 3. 对照表

| Multica 功能 | 实现要点（出处） | 我们的现状 | 是否借鉴 | 落地位置 | 成本 |
|---|---|---|---|---|---|
| Issue 与 Run 分离，run 完成不等于 issue 完成 | `文档/tasks.mdx:12-20,140-144` | dev-team 用需求 ID 加台账阶段表示事项，子 agent 各轮是执行；看板卡片对应一个会话 | 已有（理念一致） | — | — |
| agent 显式写状态，平台不推断 | `brief:771-791` | 子 agent 回复首行写「完成 / 阻塞 / 失败」（prompts:5-14），但看板不读这一行，靠 LLM 分析（`server/projection.ts:12-28`） | **借鉴** | session-manager 插件 | 低（R2） |
| 卡住时写 blocked 并说明原因 | `brief:783` | 子 agent 以「阻塞：」结束；协调者停下问用户（SKILL:27,77） | 已有 | — | — |
| 失败分类，基础设施类自动重试并续用会话 | `svc/task.go:5256-5321,5392`；`文档/tasks.mdx:78-131` | 没有分级；恢复时出错的一律先汇报再等同意（SKILL:130-137） | **借鉴** | dev-team skill | 低（R1） |
| 委派任务失败回流协调者 | `svc/task.go:6248-6300`；`mig/184:35-44` | 子 agent 出错时，Paseo 的 notifyOnFinish 会通知协调者；Paseo 重启造成的中断没有通知【推断】 | **借鉴**（补上重启中断这一路） | 插件 + dev-team | 中低（R3） |
| Squad leader 协议 | `hdl/squad_briefing.go:33-108` | 协调者硬规则 1-3（SKILL:22-24） | 已有（高度一致） | — | — |
| 每轮留下评估记录 | `squad_briefing.go:58-71` | 每次被唤醒先更新台账「记录」（SKILL:24,125） | 已有 | — | — |
| 子 issue 分 stage，整阶段关闭才唤醒 | `issue_wakeup_condition.go:545-598` | 并行子 agent 各自唤醒协调者，协调者记一行就结束本轮（SKILL:24） | 暂不借鉴 | （插件可做） | 中，收益低 |
| Wakeup：事件、条件、定时、截止 | `issue-wakeups.md:3-8`；`issue_wakeup.go` | Paseo 有 heartbeat 和 schedule；看板有延迟队列 | 只借鉴语义 | Paseo 原生（R1 中用一次性 heartbeat） | 低 |
| 防失控：12 次/时、回环检测、max_fires、leader 不自触发 | `issue_wakeup_activity.go:17-21`；`comment.go:2739-2760` | 流程步数有限：主笔回应 1 次，修复最多 2 轮（SKILL:68,98） | 不需要 | — | — |
| 运行期间的输入合并为一次后续 run，完成后对账补漏 | `mig/150`；`prompt.go:402`；`hdl/daemon.go:4465` | 排队消息只在客户端，逐条发、每条一轮，面板打开时才发，重启即丢（`client/conversation/queue.ts:1-6`、`conversation-pane.tsx:139-184`） | **借鉴** | 插件 | 中（R4） |
| 运行中插话（steer） | `task_supplement.go:90-105` | composer 已支持 steer（`client/conversation/composer.tsx:13`） | 已有；措辞可借鉴 | 插件 | 极低（R6） |
| 禁止后台挂起后结束本轮；没发结果时平台兜底 | `brief:102`；`svc/task.go:156-175` | prompts 回复约定刚加了同类规则；协调者先检查产物文件（SKILL:24） | 已有 | — | — |
| 指派确认、`--no-start`、backlog 停车、触发预览 | `svc/issue_trigger.go:97`；`文档/assigning-issues.mdx:45-51` | 两道用户门禁（SKILL:25） | 已有（门禁更强） | — | — |
| Inbox 只提醒需要人拍板的事 | `文档/inbox.mdx:8-48` | 「需要处理」列、侧栏计数、语音播报（OVERVIEW.md） | 已有 | — | — |
| Issue 页：执行日志、运行中标记、子 issue 进度 | `文档/tasks.mdx:56-72` | 子 agent 内嵌在父卡片里（commit c6b1127）；团队视图是二期候选 | 部分借鉴 | 插件 | 中高（R5，按需） |
| 会话延续：同一 agent 和 issue 恢复上次 session | `sql/agent.sql:1041` | 子 agent 不归档，返工发回原 agent（SKILL:28,96） | 已有 | — | — |
| Skills 绑定 agent | `文档/skills.mdx:79-88` | Paseo profile，加上 `~/SKILLS` 软链 | 已有 | — | — |
| Autopilot：cron / webhook | `文档/autopilots.mdx` | Paseo schedule | 只用原生 | Paseo 原生 | — |
| 子 issue 加 stage 分批 | `文档/issues.mdx:103-109` | 一个需求一个实施者 | 不借鉴 | — | — |
| 领取锁、租约、心跳、运行时离线判定、GC | `sql/agent.sql:749-810`；`runtime_sweeper.go` | Paseo 本机 daemon 直接起 agent，没有排队 | 不适合 | — | — |
| 评论串、@ 路由、订阅、权限、归因、消息渠道 | `hdl/comment.go:2700-2792` 等 | 单人使用，协调者居中转发 | 不适合 | — | — |
| 自定义状态、五种视图、优先级排队、自定义属性 | `rollout` 文档；`sql/agent.sql:806` | 看板五列加延迟队列 | 不适合 | — | — |

---

## 4. 推荐清单

按「价值 ÷ 成本」排序。R1 到 R4 给出设计草案，R5、R6 只给方向。

| # | 项目 | 落地位置 | 价值 | 成本 |
|---|---|---|---|---|
| R1 | 子 agent 失败分级，加一次自动续跑 | dev-team skill | 高 | 低（只改文字） |
| R2 | 回复首行解析为确定性卡片状态 | 插件 | 高 | 低 |
| R3 | Paseo 重启中断后回流协调者 | 插件，dev-team 补一句 | 高 | 中低 |
| R4 | 排队消息移到服务端、持久化，并合并为一轮 | 插件 | 中 | 中 |
| R6 | steer 消息加「补充而非替换」的包装 | 插件 | 小 | 极低 |
| R5 | 团队视图（二期） | 插件 | 中（并行多个需求时） | 中高 |

### R1 子 agent 失败分级，加一次自动续跑（dev-team skill）

**借鉴点**
- 只自动重试基础设施类失败（`svc/task.go:5256-5263`），重试时续用原会话；
- 会污染会话的失败换新会话，但保留产物（`:5321`）；
- 限流、额度、认证、配置类不自动重试（`文档/tasks.mdx:107-124,158-169`）；
- 每个步骤有尝试次数上限（`mig/055:7-24`）。

**本次调研的现成例子**：4 个调研子 agent 中有 2 个因 429「5 小时额度已用完，约 15 分钟后重置」中断。按下表这属于「限流 / 额度」类：不应立即重试，也不需要从头重来，等额度重置后续跑即可。

**改动**

1. 在 `SKILL.md` 的「## 5. 收尾」之前新增一节「## 子 agent 出错」：

   | 类别 | 判断依据：完成通知内容、`get_agent_status` 的 `lastError` 或活动记录【推断：Paseo 错误文本的格式需实测】 | 处理 | Multica 对应 |
   |---|---|---|---|
   | 中断 | Paseo 重启后 agent 为 closed；没有产物，也没有按约定格式的回复 | 自动续跑 1 次：用 `send_agent_prompt` 给**同一个** agent 发「续跑」模板 | runtime_recovery |
   | 临时故障 | 5xx、overloaded / 529、连接重置、流中断 | 自动续跑 1 次 | provider_network、timeout |
   | 上下文超限 | context length、prompt too long、压缩失败 | 不续原会话：新建同角色 agent（标题加 `#2`），告诉它已有产物和 commit，从文件接着做 | resume-unsafe 时开新 session，工作目录保留 |
   | 限流 / 额度 | 429、rate limit、quota、额度用完 | 不立即重试，向用户汇报。错误里给了重置时间的，经用户同意后用 `create_heartbeat`（`maxRuns: 1`）在重置后唤醒自己，再续跑 | provider_capacity_or_rate_limit 不在自动重试名单里 |
   | 认证 / 配置 / 模型 | 401 / 403、未登录、模型不存在、找不到可执行文件 | 停下汇报，不重试 | provider_auth、missing_config |
   | 主动失败 | 子 agent 回复首行是「失败：」 | 不重试，汇报用户 | agent_error |

   - 同一角色、同一步骤最多自动续跑 1 次；续跑后仍然失败，按「汇报用户」处理。
   - 并行步骤中一方出错时，另一方照常等，不要重派另一方。
2. 台账（SKILL「## 台账」）：
   - 角色表增加「尝试」列，取值 `1/2`、`2/2`；
   - 「记录」写失败类别，以及错误原文的前 80 个字。
3. SKILL「## 恢复」第 3 步改为：已关闭或出错的，按「子 agent 出错」分类处理。
4. `prompts.md` 新增模板「续跑」：

   ```
   你上一轮在 <时间> 被中断（<类别>：<错误摘要>）。工作目录和你已写的文件都还在。
   先检查 <产物路径> 和 git -C <WT> status，确认做到哪一步，从中断处继续，不要从头重做。
   ```
   末尾照常追加回复约定。

**待用户拍板**：「中断」和「临时故障」两类自动续跑 1 次、不先问用户。这是对现有「恢复」第 3 步「经同意后」的放宽。

### R2 回复首行解析为确定性卡片状态（session-manager 插件）

**借鉴点**：状态由 agent 显式写出，平台不靠推断（`brief:771-791`）。交付进入"待验收"，卡住进入"需要人"；blocked 保留在需处理列（`文档/inbox.mdx:48`）。

**现状**
- `effectiveStatusOf` 的优先级是：手动覆盖 > 重启中断 > 待授权 > 运行中 > LLM 分析（`server/projection.ts:12-28`）。
- 回复约定（prompts:5-14）的首行，以及用户自己写给 agent 的任务里常用的同一约定，都没有被利用。

**改动**
1. `shared/types.ts`：`TurnSchema`（`:100-110`）增加可选字段 `declared: { kind: "done" | "blocked" | "failed"; text: string } | null`。
2. `server/turns.ts` 组装 turn 的循环（`:69-76`）中，记下本轮**最后一条** `assistant_message`，取它的首个非空行，用 `/^(完成|阻塞|失败)[：:]\s*(.*)$/` 匹配。
   - 只看最后一条消息的首行。正文里引用约定的文字不会误判。
3. `server/projection.ts` 的 `effectiveStatusOf`：在「运行中」之后、LLM 结论之前插入一层：
   - 最新 turn 有 `declared` 时，`done` 映射为 `completed`；
   - `blocked` 和 `failed` 都映射为 `blocked`，归入需要处理列（`shared/presentation.ts:72-74`）。
4. 卡片和详情直接显示 `declared.text`，作为一句话结论。LLM 分析仍然执行，负责标题、摘要和下一步。
   - 可选：有 `declared` 的 turn 跳过 LLM 的状态判断，省一次调用。不建议默认开启。
5. 测试：`server/turns.test.ts` 和 `server/projection.test.ts` 补以下用例：
   - 首行匹配、未匹配；
   - 中间消息里出现「完成：」；
   - 失败轮次；
   - 与手动覆盖的优先级。

### R3 Paseo 重启中断后回流协调者（插件为主，dev-team 补一句）

**借鉴点**
- daemon 重启后丢失的 run 会被识别，并自动进入重试（`svc/task.go:5985`、`5256-5263`）；
- 被委派的工作最终失败时，平台写一条持久的"事实"去唤醒协调者，由协调者决定改派、跳过还是结束（`:6248-6262`）；
- 唤醒消息只陈述事实，不代表完成（`prompt.go:216`）。

**为什么放在插件里**
- 重启后协调者自己也是 closed 状态，无法自我唤醒。
- Paseo 分不清"重启关闭"和"用户关闭"，插件已经自己记录了重启中断（`server/service.ts:586,612-613` 的 `interruptedAt`）。
- 目前要靠用户手动说「继续 <ID>」。

**改动**
1. 在 `server/service.ts` 的 `runAutoResume`（`:1082-1141`）结束后，调用新方法 `notifyInterruptedTeams()`。
2. 挑选记录：`interruptedAt !== null`、`labels.team` 存在、`parentAgentId` 存在。按 `(parentAgentId, labels.team)` 分组。
3. 每组的处理：
   - 协调者处于 dormant 时，先 `this.resume(parentAgentId)`；
   - 协调者正在运行时跳过；
   - 否则用 `paseo.agents.ref(parentAgentId).send(text)` 发送：

   ```
   继续 <ID>
   [看板插件] Paseo 在 <时间> 重启，以下子 agent 当时正在运行，已被中断：
   - <role>（agentId <id>，<title>）
   这是事实通知，不代表任务完成或失败。按 /dev-team「恢复」处理。
   ```
4. 幂等：在 `server/store.ts` 持久化 `teamRecovery[<team>] = { restartAt, notifiedAt }`。同一次重启只发一次，插件 reload 后不重发。这对应 Multica 的"先落持久信号，再派发"。
5. 设置项：在 `shared/settings.ts` 增加 `teamRecovery: "notify" | "off"`。
6. dev-team 侧：SKILL「## 恢复」加一句「这条消息可能来自看板插件」。中断的子 agent 按 R1 的「中断」类自动续跑。
7. 实施前需要先验证一件事【推断，未验证】：协调者对子 agent 的 notifyOnFinish 订阅能否撑过 Paseo 重启。
   - 能撑过：插件可以改为直接给子 agent 发「续跑」，完成通知仍然回到协调者；
   - 撑不过（较可能）：维持上面的设计，由协调者用 `send_agent_prompt` 续跑，从而重新挂上通知。
   - 验证方法：在临时需求上，让子 agent 运行时重启 Paseo。

**待用户拍板**：`teamRecovery` 默认 `notify` 还是 `off`。推荐 `notify`。

### R4 排队消息移到服务端、持久化，并合并为一轮（插件）

**借鉴点**
- 运行中的 agent 最多再有一个后续 run，期间来的多条输入合并进去，并告诉 agent 这一轮还包含 N 条更早的消息、每条都要处理（`mig/150`、`prompt.go:402`）；
- 只有真正送达的消息才算处理完，完成时对账补漏（`hdl/daemon.go:4465`）。

**现状问题**（`client/conversation/queue.ts:1-6`、`conversation-pane.tsx:139-184`）
- 队列只存在客户端，重启就丢；
- 冲刷逻辑在面板的 effect 里，面板关着就不发；
- 每条消息各起一轮，并等上一轮结束。

**改动**
1. 新增 `server/queue.ts`，仿照 `server/drafts.ts`，存在插件数据目录下，结构为 `{ [sessionId]: { id, text, at }[] }`。
2. `shared/rpc.ts` 新增 `session-manager.queue.list` / `.add` / `.remove` / `.pop`，命名用 snake_case 风格。
3. 发送移到服务端：
   - 在 `onTurnEnded`（`server/service.ts:516`）中，outcome 为 completed 且没有待授权请求时冲刷队列；
   - `reconcile()`（`:1272`）对空闲且队列非空的会话补发一次，因为 hook 是尽力而为、不会重放的（NOTES-SDK）。
4. 合并规则：
   - 只有 1 条时原样发送；
   - N 条时合成一条：「你上一轮运行期间我追加了 N 条消息，按顺序处理，最后一并回复：1. … 2. …」。
   - `send` 成功后才从队列删除。失败或被授权请求卡住时保留，并在卡片上显示。
5. 客户端：`queue.ts` 改为基于 RPC 的 store，删掉 `conversation-pane` 里的冲刷 effect。按 AGENTS.md 的 Hermes 约束写。
6. 测试：
   - 合并文本；
   - 发送失败时保留；
   - hook 漏掉后由 reconcile 补发；
   - 重启后队列仍在。

**待用户拍板**：多条合并成一轮，还是保持逐条各起一轮。推荐合并，可以少起几轮，agent 也能一次看到全部补充。

### R6 steer 消息加包装（插件，极小改动）

在 composer 以 steer 方式发送时，给文本加一层固定包装：「[追加说明] 这是对当前任务的补充，不是替换。继续完成原目标，在本轮最终回复中一并体现，不要单独确认。」

- 措辞取自 `server/internal/daemon/task_supplement.go:90-105`。
- 依据：【推断】不加说明时，agent 可能把插话当成新任务，放下原目标。
- 位置：`client/conversation/conversation-pane.tsx` 的 steer 发送路径。

### R5 团队视图（二期，等痛点出现再做）

借鉴 Multica issue 页的信息结构（`文档/tasks.mdx:56-72`）：

- 每个需求一张卡（按 `labels.team` 分组），显示：
  - 阶段：解析 `<MAIN>/.team/<ID>/state.md` 的 `- 阶段:` 行；
  - 在等谁：用户门禁，或某个角色；
  - 角色表：状态、尝试次数、产物链接；
  - 「记录」末尾几行，作为执行日志。
- `MAIN` 取协调者会话的 cwd。
- 新增 RPC `session-manager.team.list`。
- 只有同时跑多个需求时才有明显价值，与记忆中「二期可选」的判断一致。

---

## 5. 不建议借鉴的部分

1. **服务端任务队列与运行时管理**：领取锁（`FOR UPDATE SKIP LOCKED`）、prepare 租约、心跳、运行时离线宽限、重连重试、工作区 GC（`sql/agent.sql:749-810`、`runtime_sweeper.go`）。这些解决的是"服务器派活给多台机器"的问题。Paseo 是本机 daemon，直接起 agent，不存在"排队等机器"，照搬等于重造 Paseo。
2. **评论串、@ 路由、订阅、Inbox 分组**（`hdl/comment.go:2700-2792`）。这是多人、多 agent 自由对话时的路由问题。dev-team 由协调者居中转发，子 agent 之间不直接对话，这本身就是防回环的优点。Multica 也承认，agent 互相 @ 时平台不判断何时结束（`文档/mentioning-agents.mdx:71-73`）。
3. **把 Squad 作为可指派对象，让 leader 每次用 LLM 判断派给谁**。dev-team 是固定流水线，角色和顺序是确定的。改成 leader 动态路由只会增加不确定性。可借鉴的协议要点已经在 SKILL 里了。
4. **子 issue 加 stage 分批、child_done 阶段屏障**。我们是一个需求、一个工作树、一个实施者。多个实施者在同一工作树里并行会冲突；协调者多被唤醒一次的成本很低。将来如果要把大需求拆成多个子需求、各用一个 worktree，再考虑这一项。
5. **完整的 Wakeup 规则引擎**：25 种事件、条件轮询、receipt、join、指纹去重。机制精巧，但服务的是"agent 等外部事实"（PR、CI、别的 issue）。dev-team 等的是子 agent 完成（Paseo 已经会通知）和用户（直接对话）。只借鉴两点语义：一次性定时唤醒（R1 中用 heartbeat 实现），以及"触发只是事实"的措辞（R3）。
6. **自定义状态、五种视图、优先级排队、自定义属性、项目、标签命名空间**。这些面向规模化团队管理；看板五列加延迟队列已经够用。
7. **Autopilot**。cron 部分 Paseo 的 schedule 和 heartbeat 已原生覆盖；webhook 需要对外暴露服务，不符合本地场景。
8. **权限（Access）、成员角色、人员归因、Slack / 飞书渠道、云端 skill 仓库**。这些属于多人协作与合规需求。
9. **以 `bypassPermissions` 运行、不做逐工具授权**（`server/pkg/agent/claude.go:1084`）。我们刻意让 Paseo 的权限请求交给用户处理（SKILL:26），不应为了自动化去掉这层。

---

## 附：核对说明

- **材料来源**：官方文档随代码发布在 `apps/docs/content/docs/*.mdx`，作为主干阅读；源码只核对准备推荐借鉴的关键点。
- **调研过程**：起初派了 4 个只读源码阅读子任务。「任务管理」和「wakeup / 触发」两个返回了带行号的报告；「AI 团队」和「可靠性」两个因 API 限流中断，没有结果，这两块由我直接读源码补齐。
- **亲自回到源码核对过的引用**：
  - `brief:102,268,771-791,801`
  - `sql/agent.sql:749-810,1041`
  - `mig/452`、`mig/055`、`mig/150`、`mig/184:35-44`
  - `svc/task.go:156-175,5256-5321,5392-5470,5985,6079-6118,6248-6300`
  - `runtime_sweeper.go:24-74`
  - `hdl/squad_briefing.go:33-108`
  - `hdl/comment.go:2700-2792`
  - `hdl/issue.go:4080-4089`
  - `hdl/daemon.go:4465`
  - `svc/issue_trigger.go:97`
  - `svc/issue_wakeup.go:1284-1318`
  - `svc/issue_wakeup_activity.go:17-21`
  - `svc/issue_wakeup_condition.go:385-438,545-598`
  - `svc/issue_wakeup_system.go:44-52,144`
  - `daemon/prompt.go:215-216,402`
  - `daemon/task_supplement.go:90-105`
  - `pkg/agent/claude.go:1084`
  - `docs/engineering/issue-wakeups.md:1-8`
  - `docs/issue-status-lifecycle-rollout.md`
- **来自源码阅读报告、未逐行复核的引用**：
  - issue 表各字段对应的迁移编号（`mig/001`、`084`、`105`、`123`、`351`、`509`、`553`、`557`、`558`）；
  - 视图组件路径；
  - PR 合并自动完成。
- **仅依据文档**：
  - agent 的权限分级；
  - Skills 的创建与沉淀方式；
  - Autopilot 按失败率自动暂停；
  - Inbox 自动归档规则；
  - run 状态与超时速查表（其中 dispatched 5 分钟和 3h 宽限期已在源码中核对）。
