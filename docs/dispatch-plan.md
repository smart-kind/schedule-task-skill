# schedule-task 任务派发策略设计（弹性派发 v2，计划稿，未实施）

> **状态声明**：本文档是**未来开发计划**，仅用于定方案，**当前不执行**。文中涉及的代码改动均未落地。
> 制定日期：2026-08-10。
>
> **决策记录（2026-08-10 与 author 确认）**：
> 1. 任务间间隔（spacing）= **同一 worker 上任务启动间的最小间隔**，默认 10 分钟，可设 0 关闭。
> 2. `run_at` **可选化**：不写 = 依赖就绪立即启动（earliest）；写了仍是"最早时间"下限。
> 3. 任务堆积处理 = **尽快执行 + status 可见性**，不自动作废。
> 4. **批次目录分组 v1 不做**（理由见 §5，列为后续演进选项）。

---

## 1. 背景与痛点

author 把任务派发给 worker 时，任务的时间点决策很粗放——常见做法是手工排等距时间
（"4 个任务每小时一个"），导致：

- **填充率差**：worker 的 Agent 长时间空闲。任务可能 5 分钟就做完，下一个却要等到
  原定时刻才启动——即使依赖就绪、worker 空闲。
- **堆积**：依赖链上某一环被限流拖住后，后续任务的 `run_at` 全部过期；等前序完成时
  一次性涌上来（曾出现"执行时任务已过期 10 多小时"）。
- **限流冲击**：部分 worker 流量受限，任务常跨多个 session/chat/5-hour limit 被打断；
  多个任务同时启动会互相挤占限流配额。
- **暂停/衔接策略不足**：`limit-wait` 停车期间占着并发槽，其他任务进不来。

目标：**把静态手工排班改为弹性派发**——`run_at` 只是"不早于"的下限，任务在依赖就绪后
尽早启动，靠并发上限 + 任务间最小间隔自动排队，提升填充率、尽快完成 batch。

---

## 2. 现状分析（`src/dispatch.js` 的启动判定）

当前每个任务启动要过（`src/dispatch.js` tick）：

1. 状态非终态 / 非 `running`（`running`/`dev-done`/`audit-pass`/`audit-fail`/
   `merge-failed`/`failed`/`cancelled` 跳过）；
2. 机器匹配：envelope `.worker` 等于本机 id（缺省 = 任意 worker）；
3. `now >= run_at`（`schedule.run_at`，ISO-8601 UTC 一次性）——**已过即启动**，
   所以"过期 10 小时还执行"是当前设计行为；
4. `depends_on` 前序全部 `dev-done`；
5. 全局并发上限 `FL_MAX_CONCURRENCY`（默认 2）。

**根因**：`run_at` 是 author 手工排的静态等距时间表；`dispatch` 本身没有"任务间错峰/
尽早填充"的概念。`run_at` 语义虽在 schema 中写为"eligible once `now >= run_at`"，
但 author 心智模型是"精确执行时刻"，排班方式（等距）制造了空闲与堆积。

---

## 3. 方案：弹性派发 v2

### 3.1 `run_at`：语义明确化 + 可选化

- **语义**：`run_at` = 最早可开始时间（not-before 下限）。依赖就绪后、`now >= run_at`
  即尽早启动，绝不等待原定时刻（现状实现即如此，写清楚并统一文档措辞）。
- **可选化**：不写 `schedule` / `schedule.run_at` = **依赖就绪立即启动**（earliest）。
  这是填充率提升最直接的一刀——绝大多数任务不再需要排时间。
- 保留场景：确有"特定时段才跑"需求（如限流时段价格差异、外部依赖窗口）时仍可显式填
  `run_at`。注意：**"精确控制时段"已被 author 放弃**（2026-08-10 决策）——为不同时段
  价格手动错峰带来的复杂度大于收益；`run_at` 只服务真正的时间约束。
- 向后兼容：旧 envelope 带 `run_at` 继续生效（现在就是 `now >= run_at` 语义）。

### 3.2 `spacing`：同一 worker 任务启动间的最小间隔（新增）

- **定义**：同一 worker 上，两次任务**启动**之间的最小间隔 `spacing_minutes`，
  默认 **10 分钟**，可设 `0` 关闭（纯并发队列）。
- **作用**：替代手工错峰——无需再手动排 1 小时等距；任务在 worker 空闲时尽早启动，
  但同一 worker 上间隔不小于 `spacing`，避免全 batch 同时启动互相挤占限流配额。
- **位置**：批次级放 batch manifest `batches/<batch>.json`（`"spacing_minutes": 10`），
  任务级可在 envelope 加可选 `spacing_minutes` 覆盖批次值；均缺省时默认 10。
- **实现要点**：dispatch 在 worker 本地 `state/` 维护"最近一次任务启动时间"记录
  （如 `state/.last_start`，时间戳 + 任务 id）；候选任务通过 eligibility 后，再校验
  `now - last_start >= spacing_minutes`。`state/` 是 worker-local 的，天然按 worker 隔离。
- **与并发上限的关系**：`spacing = 0` + `FL_MAX_CONCURRENCY = N` = 尽快并行；
  `spacing > 0` = 自动错峰。两者独立可调。

### 3.3 依赖链弹性（保持，写清楚）

- `depends_on` 前序全部 `dev-done` 后，若 `run_at` 已过（或缺省 earliest），
  立即启动——依赖链自然紧凑，不等人为时间点。

### 3.4 author 排期简化（`dev` 命令）

- **默认不再逐个排 `run_at`**：`dev` 创建任务时缺省不写 `run_at`（earliest），
  由 dispatch 按 spacing + 并发上限自动排队。
- 显式要求时才填 `run_at`（interview 中问"是否有硬性时间约束？"，默认无）。
- 多任务 batch：无依赖任务全 earliest；依赖任务只写依赖关系。不再有"起始时间 + 等距
  递推"的排班流程——spacing 已接管错峰。

### 3.5 堆积可见性（`status` 增强）

- `status` 对"已过期未启动"的任务（`run_at` 已过且未完成）显示 **overdue 标记与过期
  时长**（如 `⏰ overdue 3h12m`）。
- 判定：worker 侧读 `state/`（无 state 文件 = pending）；author 侧读 `reports/`
  （run_at 已过 + 无对应报告 = 未完成）。两侧都可见堆积，而不是事后才发现。
- **不做自动作废**（决策）：author 目标是最快完成所有任务；过期任务尽快执行 +
  可见性足够。

### 3.6 暂停 / 限流衔接（v1 列为已知限制，不解决）

- `limit-wait` 的 runner 睡眠时仍占并发槽（runner 是 detached 独立进程，dispatch
  无法调度它）。现状如此。
- 缓解手段：spacing 错峰 + 并发上限本身限制了同时撞限流的任务数。
- 真正的"暂停释放槽位 / 槽位可抢占"需要重构 runner 与 dispatch 的协作契约
  （如 runner 停车前写"parked"状态 + 预计唤醒时间，dispatch 读取并让其他任务借位），
  复杂度高，**后续单独规划**。

---

## 4. 配置位置汇总

| 配置 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `run_at` | envelope `schedule.run_at` | 缺省 = earliest | 最早开始时间下限；不写 = 依赖就绪立即启动 |
| `spacing_minutes` | batch manifest `batches/<batch>.json` | 10 | 批次级任务启动最小间隔 |
| `spacing_minutes`（覆盖） | envelope（可选） | 取批次值 | 单任务覆盖批次级间隔 |
| 并发上限 | 环境变量 `FL_MAX_CONCURRENCY` | 2 | 全局同时 running 的 runner 数 |

---

## 5. 批次目录分组（决策记录：v1 不做）

**作者提出的演进想法**：当前所有批次的任务平铺在 `tasks/` 下，无批次级目录；若改为
`tasks/<batch>/<id>.json`，可为批次单独设定一些东西。

**v1 决定：不做**，理由：

- 批次级配置已有现成载体：`batches/<batch>.json` manifest（`spacing_minutes` 放这里），
  不需要目录分组。
- 目录分组是 **schema breaking change**：`id` 必须等于文件名（`references/envelope-schema.md`
  的 load-bearing 约定），所有读 `tasks/` 的代码（dispatch/status/archive/audit/cancel/
  init/doctor）都要改，且要 `migrate` 升级数据 schema v2。
- 收益（目录结构清晰）当前不足以覆盖成本。

**后续演进选项**（出现真实需求再评估）：`tasks/<batch>/<id>.json` 目录分组，需
schema v2 + migrate + 全链路改造；或保持平铺、仅让 manifest 承担更多批次级配置。

---

## 6. 实现范围（未来实施时的工作清单）

| 文件 | 改动 |
|---|---|
| `src/dispatch.js` | eligibility 增加 spacing 校验（读/写 `state/.last_start`）；按 run_at/依赖拓扑排序候选，优先最早可执行 |
| `src/core.js` | `readSpacing()` 辅助：batch manifest 值 ← envelope 覆盖 ← 默认 10；`run_at` 缺省判定 |
| `src/status.js` | 增加 overdue 列（worker 侧读 state，author 侧读 reports 推断） |
| `src/cli.js` / `src/audit.js` 等 | 无 `run_at` 的 envelope 创建路径适配（earliest 合法） |
| `templates/dev-plan-harness.md` / SKILL.md | interview 默认不再排 `run_at`，只有硬时间约束才填；文档措辞统一"not-before 下限" |
| `references/envelope-schema.md` | `schedule.run_at` 改可选；新增 `spacing_minutes` 字段说明 |
| `tests/dispatch.test.js` 等 | spacing 校验、overdue 渲染、无 run_at 启动的单元测试 |

建议实施顺序：dispatch 的 spacing 校验（核心）→ envelope `run_at` 可选化 →
status overdue → dev interview 简化 → 文档同步。

## 7. 开放问题（实施前确认）

1. spacing 的"最近启动时间"是否也考虑**跨任务并发**（同一 worker 同时跑 2 个任务时，
   第三个任务的启动间隔以哪个为准）？——当前建议以 `state/.last_start` 单调推进为准。
2. `limit-wait` 停车是否应计入 spacing 判定的"占用窗口"（即停车中视为已占用间隔）？
   ——v1 建议不计（简单），确认即可。
3. overdue 的阈值显示（如超 1 小时才显示 ⏰，还是所有过期都显示）？
