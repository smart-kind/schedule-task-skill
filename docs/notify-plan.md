# schedule-task 通知与查询体系设计（计划稿，未实施）

> **状态声明**：本文档是**未来开发计划**，仅用于定方案，**当前不执行**。文中涉及的代码改动均未落地。
> 制定日期：2026-08-10。

> **范围边界（2026-08-10 决策）**：聊天通道的责任边界定为 **单向通知 + 只读查询**。
> 允许 bot 被动推送事件、应答只读查询（status/log）；**不做任何写操作控制**
> （取消、改计划、重派等一律留在 CLI 受控面）。双工查询设计见 §11。

---

## 1. 背景与目标

schedule-task 体系中，author（人类）负责派发任务，worker（机器）无人值守地自动执行。
当前系统对"任务执行过程中发生的重要事情"没有任何主动推送能力——人类只能靠主动跑
`schedule-task status` 才知道发生了什么，而机器遇到严重问题时（失败、卡顿、做出重大决策）
人类完全无感知，直到事后。

本计划的目标：建立一个**分级分组、渠道可插拔、任务可配置**的通知体系，把任务生命周期中
的重要事件推送到即时通讯渠道（优先 Mattermost），让人类在异常发生时能及时知情。

核心原则：

1. **纯通知渠道**：只做"上报/通知"，**不引入"让用户参与决策"的交互**（不暂停、不等待人类裁决）。
2. **渠道统一抽象**：Mattermost / Slack / Telegram 全部通过 **Bot + chat/channel ID** 接入，
   不引入 webhook 等其他形态；某个渠道无法以 Bot 方式接入则不做该渠道，不为少数渠道复杂化系统。
3. **任务级声明**：每个任务在自己的 envelope（`tasks/<id>.json`）中声明"要不要通知、通知哪些
   分组/级别"，渠道细节属于系统级配置，任务不感知。
4. **静默保活**：任务长时间无消息时要主动推阶段性总结，避免人类疑惑"是不是卡死了"。
5. **零依赖、不阻塞**：通知管道绝不能影响任务执行主流程（发送失败静默跳过）。

---

## 2. 现状调研结论（2026-08-10 代码勘查）

现有系统已有一个"通知钩子"机制，但处于**机制就位、内容为空**的状态：

- `src/core.js` 的 `notify(repo, event, id, msg)`（core.js:278）：
  - 检查 repo 的 `.schedule-tasks-data/hooks/notify.sh` 是否存在且可执行（X_OK）；
  - 是则 `spawn` 调用（detached、`stdio: 'ignore'`、`unref()`，绝不阻塞主流程），否则静默跳过。
- **当前调用点**：
  - `src/runner.js` — `started`（任务启动）、`limit-wait`（限流停车）、终态（`dev-done` /
    `merge-failed` / `failed` / `audit-pass` / `audit-fail` / `cancelled`）。
  - `src/cancel.js` — `cancelled`。
  - `src/watchdog.js` — **无**通知调用（到点自动拉起任务不通知）。
- 模板 `templates/hooks/notify.sh` 与 `init` 复制到各 repo 的 `hooks/notify.sh` 默认是 `exit 0`
  空壳。要让其生效只需把 body 换成真实发送调用（`references/operations.md` 有示例）。
- 事件签名：`hooks/notify.sh <event> <task-id> <message>`，事件清单：
  `started`、`attempt`、`limit-wait`、`done`、`failed`、`merged`、`merge-conflict`、`cancelled`。

**对照需求的主要缺口**：

| 缺口 | 现状 |
|---|---|
| 无分级/分组 | 事件平铺，无严重程度，无过滤能力 |
| 卡顿/无法决策不通知 | executor 反复无进展退出（ambiguous）只记日志，不通知 |
| 重大决策无上报通道 | executor 完全自主，系统无"决策点"概念 |
| 到点自动拉起任务不通知 | watchdog 不触发 hook |
| 静默无心跳 | 无"长时间无消息"检测 |
| 发送端为空壳 | 无默认发送器，渠道接入靠手工写 shell |

---

## 3. 需求模型：分组 × 级别

### 3.1 分组（group）

| 分组 | 语义 | 说明 |
|---|---|---|
| `runner` | 运行层面事件 | 限流等待、任务启动/暂停/进入等待、卡顿重试、watchdog 拉起任务。**仅上报，不决策** |
| `worker` | 任务执行层面事件 | 任务开始、完成报告、重大决策、严重错误。组内再分级 |

### 3.2 级别（level）

不用传统日志的 error/warning/info/debug（那是诊断语义），改用面向"人需要知道的事"的语义化级别：

| 级别 | 语义 | 示例 |
|---|---|---|
| `info` | 状态变化，知悉即可 | 任务开始、取消、进入等待 |
| `report` | 报告 | 任务完成摘要、心跳阶段性总结 |
| `decision` | 重大决策 | 原计划不可行、改走替代方案 |
| `critical` | 严重错误，需人关注 | 失败、合并失败、审计不过、卡死超限 |

### 3.3 事件映射表（草拟）

| 事件 | 分组 | 级别 | 触发点 | 状态 |
|---|---|---|---|---|
| 任务开始执行 | worker | info | runner 启动 | 已有，升级 |
| 到点自动拉起任务 | runner | info | watchdog 启动 runner | **新增** |
| 限流停车等待（limit-wait） | runner | info | runner 撞限 | 已有，升级 |
| 卡顿重试（ambiguous） | runner | info | runner 检测到无进展退出 | **新增** |
| 重大决策（原计划不可行，改走替代方案） | worker | decision | executor 输出 `[[DECISION …]]` | **新增** |
| 阶段性 summary（静默超阈值） | worker | report | 心跳 | **新增** |
| 任务完成（dev-done / audit-pass） | worker | report | runner 终态 | 已有，升级为报告 |
| 失败 / 合并失败 / 审计不过 | worker | critical | runner 终态 | 已有，升级 |
| 取消 | worker | info | cancel | 已有，升级 |

---

## 4. 总体架构

```
事件源 (runner / cancel / watchdog)
   │  core.notify(repo, { group, level, event, id, message })
   ▼
src/notify.js ── 统一通知管道
   ├─ 1. 过滤    按任务 envelope 的 notify 节点判断该 分组×级别 是否上报
   ├─ 2. 路由    读系统渠道配置（state/notify.env + 环境变量覆盖）
   │             NOTIFY_CHANNELS=mattermost,slack,telegram
   ├─ 3. 线程化  同一任务的消息串成 thread（每个渠道各自维护 root id）
   └─ 4. 发送    按启用的渠道分发给对应 adapter；未配置凭证的渠道静默跳过
                      │
      ┌───────────────┼────────────────┐
      ▼               ▼                ▼
  mattermost.js    slack.js       telegram.js
   (Bot+Token)    (Bot+Token)     (Bot+Token)
```

### 4.1 统一渠道接口（adapter 契约）

三个渠道实现同一契约，全部基于 **Bot API**：

```js
// 每个渠道一个 adapter 模块，暴露：
{
  name: 'mattermost',            // slack / telegram
  // 发送首条消息 → 返回 threadId（供后续回复挂靠）
  async send(cfg, { text, level }) → { threadId },
  // 回复到已有 thread
  async reply(cfg, { text, threadId }),
  // doctor 健康检查用
  async ping(cfg) → boolean
}
```

| 渠道 | 接入方式 | 关键配置 | 线程语义 |
|---|---|---|---|
| Mattermost | Bot + API Token | `MM_URL`、`MM_TOKEN`、`MM_CHANNEL_ID` | `root_id`（POST /api/v4/posts） |
| Slack | Bot + Bot Token | `SLACK_TOKEN`、`SLACK_CHANNEL_ID` | `thread_ts`（chat.postMessage） |
| Telegram | Bot + Bot Token | `TG_TOKEN`、`TG_CHAT_ID` | 回复锚点（sendMessage 后以其消息 id 回复） |

约束：

- 每个渠道**只支持 Bot 形态**；不支持 Bot 的渠道（如只有 webhook 的 Slack 环境）**不做该渠道**，
  不为单个渠道引入第二套机制。
- 消息通过 Bot 的 chat/channel ID 分流到目标会话。
- 渠道未配置（缺 token/ID/URL 任一）→ 静默跳过，不影响其他渠道与任务执行。
- 全部用 Node 内置 `fetch`，维持 zero-dependency。

### 4.2 发送器归属（方案 A：内置 Node 发送器）

- 新增 `src/notify.js`（统一管道）+ `src/notify/{mattermost,slack,telegram}.js`（渠道 adapter）。
- `hooks/notify.sh` 保留为**可选覆盖层**：repo 内存在且可执行 → 取代内置渠道，由项目自定义发送
  （向后兼容现有用法，签名扩展为带 group/level）；否则走内置渠道。
- 过滤、线程化、心跳等复杂逻辑放 Node，可纳入现有 `tests/` 体系。

---

## 5. 配置设计

### 5.1 系统级渠道配置（gitignored）

`.schedule-tasks-data/state/notify.env`（`init` 生成模板；同名环境变量可覆盖文件值）：

```
# 启用的渠道（逗号分隔）：mattermost, slack, telegram
NOTIFY_CHANNELS=mattermost

# mattermost（Bot）
MM_URL=https://mattermost.example.com
MM_TOKEN=xxxx
MM_CHANNEL_ID=xxxx

# slack（Bot；环境不支持 Bot 则整段留空，该渠道不启用）
SLACK_TOKEN=
SLACK_CHANNEL_ID=

# telegram（Bot）
TG_TOKEN=
TG_CHAT_ID=
```

- 该文件在 `.schedule-tasks-data/state/` 下，随 gitignore 不提交，每台机器各自配置。
- 渠道列表与凭证**都不进任务 envelope**。

### 5.2 任务级声明（envelope `notify` 节点）

`tasks/<id>.json` 只声明"要通知 + 选哪些分组/级别"，不碰渠道细节：

```json
{
  "id": "T260805-03-retreat",
  "notify": {
    "groups": {
      "runner": true,
      "worker": ["info", "report", "decision", "critical"]
    },
    "heartbeat_minutes": 30
  }
}
```

语义：

- 任务未写 `notify` 节点 → **完全不通知**（保持现状，不打扰）。
- `runner: true` = runner 分组全级别上报；`worker` 为数组 = 只上报列出的级别。
- `heartbeat_minutes` 缺省 30。

过滤逻辑（notify.js）：

```js
function shouldNotify(taskNotify, group, level) {
  if (!taskNotify) return false;            // 任务未声明通知能力
  const g = taskNotify.groups?.[group];
  if (g === undefined) return false;
  if (g === true) return true;              // 整个分组全开
  return Array.isArray(g) && g.includes(level);
}
```

---

## 6. 消息组织

### 6.1 线程化

- 每个任务的首条通知（通常为 `started`）在渠道中新建 thread root，后续所有通知回复进同一
  thread——在 Mattermost 里"一个任务 = 一个可折叠线程"。
- 线程 id 状态存 `.schedule-tasks-data/state/notify-threads/<task-id>.<channel>.json`
  （gitignored），每个渠道独立维护。

### 6.2 消息格式（草拟）

```
[info]    任务开始 — <id> · <branch> · <agent>/<model>
[report]  完成 — <id> · attempts=N · commit=<sha>（<结果摘要>）
[critical]失败 — <id> · <失败原因摘要>
[decision]决策 — <id> · <executor 上报的 [[DECISION]] 内容>
[report]  心跳 — <id> · 已运行 <时长> · 最近进展：<最近 CHECKPOINT>
[info]    限流等待 — <id> · 停车 <N>s 后继续（attempt N）
```

- 级别带 emoji 前缀便于扫读；`critical`/`decision` 级别可在渠道内 @提及相关人（待定）。

### 6.3 心跳（静默保活）

- 任务运行期间，距上次通知超过 `heartbeat_minutes`（默认 30）→ 生成阶段性 summary：
  从 run log 提取最近 `[[CHECKPOINT]]` + 已运行时长 + 当前 attempt，按 `report` 级上报。
- 实现于 runner：记录 `lastNotifyTs`，每轮循环检查；仅在任务仍处于运行中时触发。

---

## 7. Executor 决策上报（"两者结合"）

1. **Executor 主动上报**（主要路径）：
   `templates/harness-common.md` 增加指令——当原计划无法继续、需要改变方案/范围/接口等
   **重大决策**时，输出 `[[DECISION 一句话说明]]` 标记并继续执行；runner 解析 executor
   输出中的该标记 → 发 `worker/decision` 通知。**只上报，不暂停等待**。
2. **系统自动兜底**（异常路径）：
   `failed` / `merge-failed` / `audit-fail` → `worker/critical`；ambiguous 重试超过上限
   （MAX_AMBIGUOUS）→ 任务转 `failed` → `critical`。

---

## 8. 向后兼容

- `hooks/notify.sh` 保留为可选覆盖层：存在且可执行 → 取代内置渠道，由项目自定义发送；
  否则走内置渠道。旧签名 `notify.sh <event> <id> <msg>` 扩展为带 group/level。
- 未配置任何渠道、任务也未声明 notify → 行为与现状完全一致。

---

## 9. 实现范围（未来实施时的工作清单）

| 文件 | 改动 |
|---|---|
| `src/notify.js`（新增） | 统一管道：过滤、路由、线程化、分发 |
| `src/notify/mattermost.js`（新增） | Bot adapter：posts + root_id 线程 |
| `src/notify/slack.js`（新增） | Bot adapter：chat.postMessage + thread_ts |
| `src/notify/telegram.js`（新增） | Bot adapter：sendMessage + 回复锚点 |
| `src/core.js` | `notify()` 签名扩展（group/level），读取 envelope notify 节点与渠道配置 |
| `src/runner.js` | `[[DECISION]]` 解析、心跳定时、终态报告摘要、ambiguous 通知 |
| `src/watchdog.js` | 拉起任务时发 `runner/info` 通知 |
| `src/cancel.js` | `cancelled` 升级为分组/级别 |
| `src/init.js` | 生成 `state/notify.env` 模板 |
| `templates/harness-common.md` | `[[DECISION]]` 指令 |
| `templates/hooks/notify.sh` | 注释更新（覆盖层语义） |
| `src/doctor.js` | 通知配置健康检查（渠道是否启用、凭证是否齐全、可选 ping） |
| `tests/notify.test.js` 等 | 过滤逻辑、adapter 接口、线程状态、心跳的单元测试 |
| `SKILL.md` / `references/operations.md` | 文档同步（事件表、配置说明、任务声明示例） |

建议实施顺序：notify.js 管道 + mattermost adapter（主渠道）→ runner/cancel/watchdog 事件接入
→ 决策上报 + 心跳 → slack/telegram adapter → doctor/文档。

## 10. 开放问题（实施前确认）

1. `critical`/`decision` 级别是否需要 @提及固定人（channel 成员或指定账号）？
2. 心跳摘要的"最近 CHECKPOINT"提取规则（取最近一条即可，还是按时间段聚合）？
3. 线程状态文件是否需要清理策略（任务终态后保留还是删除）？

---

## 11. 双工查询通道（只读）——后续阶段计划

单工通知解决"系统让人知道发生了什么"，查询解决"人想知道现在怎样"。合起来的边界是：
**让你看见，不替你操作**。控制操作（cancel / dev / audit / archive）保持既有 CLI 接口
（author/worker 机器上有 repo 上下文、git 保护与审计），不进入聊天通道。

### 11.1 为什么不做写控制

- 控制 = 改变系统状态，需要鉴权、幂等、冲突管理、审计，且可能与正在运行的任务冲突
  （例：用户说"取消"，任务恰好在 merge 阶段）。
- token 泄漏的代价不同：通知体系里只是刷屏，控制体系里是控制权泄漏。
- 控制操作频率低，现有 CLI 已覆盖且带完整上下文；聊天只是换输入法，没有降低门槛，
  却新增了风险面。

### 11.2 设计概要（实施时细化）

- **常驻接收端**：Mattermost bot 长连接（WebSocket）或 outgoing webhook / slash command
  回调到常驻 HTTP 端点；鉴权判断消息是否属于本项目（bot token ↔ 项目映射，即
  notify.env 中该 bot 绑定到哪个 repo）。
- **命令白名单**（只读、无 LLM）：
  - `/status` — 在绑定 repo 跑 `schedule-task status`，回贴输出
  - `/log <id>` — 回贴任务日志尾部
  - 可扩展：`/doctor`（健康检查）
- **交互形态**（Mattermost 实测能力，2026-08-10 核实）：
  - 主形态为 **slash command**：Mattermost 原生支持自定义 slash command（用户输入 `/`
    触发，带自动补全），无需菜单按钮；这是查询最自然的入口。
  - 可选进阶：通知消息上挂 **Interactive Message Buttons / Menus**（消息附件 actions，
    点击 POST 回调到接收端）——例如推送"任务失败"时带"查看日志"按钮。与常驻接收端
    共用同一套 HTTP 回调基础设施，不新增复杂度。Mattermost 无 Telegram 那种输入框旁
    的命令菜单按钮 UI，但 slash command 自动补全 + 消息按钮在功能上等效。
- **确定性执行**：收到指令 → 在绑定项目目录执行只读子命令 → 回贴输出。
  不引入 LLM / agent-sdk；自然语言解析暂不做（YAGNI）——查询是跑命令行，不是让 AI 写代码。
- **输出格式化**（不需要 AI；CLI 本身已是格式化器——`status` 的输出就是为人类可读
  设计的确定性文本表格，`src/status.js`）：
  - 起步：直接回贴 CLI 输出（代码块包裹，超长截断 + 提示"完整看终端"）。
  - 进阶：给只读子命令加 `--json` 机器可读输出（status.js 内部已组装好结构化数据，
    加一个分支即可），bot 拿 JSON 用**模板渲染**成 IM 紧凑列表（batch 分组、状态、
    next 等字段映射为 Markdown）；模板渲染可单元测试。
  - LLM 只承担可选的"自然语言总结"（把 JSON 翻译成散文），放在 bot 侧，不进 CLI 与
    notify.js 管道；内部工具查询以紧凑结构化列表为主，散文总结先不做。
- **安全**：只读命令白名单 + 项目绑定鉴权；与发送侧共用 notify.env 的 Bot 凭证。

### 11.3 阶段划分

- 阶段一：单工通知（本文档主体，§1–§10）。
- 阶段二：只读查询 bot（本节），独立小步，无副作用，可在通知落地后再做。
- 明确不做：写控制（除非未来出现明确的高频需求，再单独规划确认状态机方案）。
