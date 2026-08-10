# schedule-task 任务状态可见性改进（TODO，计划稿，未实施）

> **状态声明**：本文档是**未来开发计划**，仅用于记录问题与方案，**当前不执行**。文中涉及的代码改动均未落地。
> 制定日期：2026-08-10。
> 来源：author 实际使用中遇到的两个真实问题（见 §1）。

---

## 1. 痛点

### 1.1 author 看不到"任务已开始"

一个 batch 共 4 个任务：3 个已完成、第 4 个 worker 已经开始干但没干完。
author 侧查询状态：**只能看到 pending / 已完成**，看不到"正在运行"——

- 第 4 个任务显示为"等待（pending）"，而实际上它正在执行中。

原因：任务状态只有 worker 本地的 `state/<id>`（gitignored），author 侧唯一的信息源是
合并到 `dev` 的 `reports/<id>.md`，而报告是任务**结束**时才写的。任务开始（running）
在 git 上**没有任何痕迹**。

### 1.2 author 查询状态时不拉最新代码

author 侧执行 `schedule-task status` 时看到"所有任务都在等待"；手动 `git pull` 之后
再查，才看到"3 个已完成、1 个进行中"。

原因：`status` 命令本身**不执行 `git fetch`**，依赖用户先手动拉取
（`SKILL.md` 写的是 "Run `git fetch` first"）。忘了拉 → 看到的是过期状态。

---

## 2. 现状分析（代码勘查，2026-08-10）

| 现状 | 位置 |
|---|---|
| author 模式只读 `origin/<inbox>` 上的 `reports/<id>.md`（`git show`），且假定已 fetch | `src/status.js:9-12, 57-64` |
| `status` 不自动 `git fetch`，靠用户手动；`SKILL.md` 引导 "Run `git fetch` first" | `src/status.js` / `SKILL.md` |
| 任务开始时：写 `state/<id>`（gitignored）+ run log + notify hook；**无 git commit/push** | `src/runner.js:61-65` |
| 任务结束时：commit + 写报告 + push 合并到 `dev`；报告是 author 侧唯一状态信号 | `src/runner.js` 头部注释 |
| `state/` 为 gitignored worker-local truth，不跨 git（设计原则） | `references/envelope-schema.md` §state |

**结论**：要让 author 看到 running，必须让任务启动时在 **committed 区域**留下一个 git
可见的标记；同时 `status` 需要自动拉取最新远端，两个问题合起来才是完整的
"author 侧状态可见性"。

---

## 3. 方案草案

### 3.1 任务启动时上报 git 标记（running 可见性）

- **新增 committed 运行状态区** `.schedule-tasks-data/runtime/<id>.json`
  （与 `reports/` 平级，committed 随 git，不进 gitignore）：
  ```json
  { "id": "T260805-03-retreat", "status": "running", "startedAt": "2026-08-10T12:00:00Z",
    "agent": "claude", "model": "opus", "branch": "automation/T260805-03-retreat", "attempt": 1 }
  ```
- **写入时机**：runner 启动（`started`）时写该文件并 `git commit` + `git push`（极小的
  "任务已开始"提交）；任务终态（dev-done/audit-pass/failed/cancelled 等）时删除该文件
  （或标记 terminal）并再提交一次——终态信息仍以 `reports/` 为准。
- **status 消费**：author 模式除读 reports 外，再读 `runtime/<id>.json`——
  存在且 `status: running` → 该任务显示 `running`（附 startedAt / agent / branch）；
  不存在 → 按 reports 推断（现状逻辑）。
- **设计权衡**：
  - 为什么不用 `state/`：它 gitignored，改动它违背 worker-local truth 原则且状态不跨 git。
  - 为什么不用 `reports/`：报告是终态产物，混入 running 语义会污染报告消费方。
  - 为什么按 `id` 独立文件：多 worker 各写各的，天然无写冲突（文件级别隔离）。
  - **已知竞态**：多个 worker 同时启动各自任务并同时 push 时可能互相 rebase 冲突——
    提交需 `pull --rebase` 重试（dispatch/runner 已有该模式，复用即可）。

### 3.2 `status` 自动拉取最新代码（author 模式）

- `status` 在 **author 模式**默认自动执行一次 `git fetch origin <inbox>`
  （只读、无副作用、失败不致命）；`--no-fetch` 可关闭（离线/只读场景）。
- worker 模式无需 fetch（读本地 state，已有逻辑）。
- 文档同步：`SKILL.md` 与 `references/operations.md` 中 "Run `git fetch` first" 的
  引导改为"status 自动 fetch；需要离线快照用 `--no-fetch`"。

### 3.3 组合效果

1. 任务开始 → `runtime/<id>.json` 提交上 `dev` → author 下一次 status（自动 fetch）看到
   `running`，而非 pending。
2. 任务结束 → 报告上 `dev`、`runtime/<id>.json` 删除 → author 看到终态。
3. author 再也不用记得先手动拉代码。

---

## 4. 影响面与注意事项

- **数据 schema**：`runtime/` 是新 committed 目录，属于数据格式变化，需评估是否 bump
  schema（`migrate` 只 stamp 版本号，新增目录对旧 CLI 是"多余目录"，通常无害，
  但 status 消费逻辑在旧 CLI 上不存在——`status` 需向后兼容"无 runtime 目录"）。
- **git 噪音**：每个任务多 1-2 个极小提交（started + 终态清理），add-only 设计可接受；
  提交信息建议统一前缀（如 `runtime: <id> started`），便于过滤。
- **status 自动 fetch 的失败处理**：离线时 fetch 失败 → 继续用本地/缓存状态渲染，
  并提示"fetch 失败，显示的是本地视图"。
- **`state/` 原则不破坏**：`runtime/` 是 committed 的派生视图，`state/` 仍是
  worker-local 唯一真值。

---

## 5. 开放问题（实施前确认）

1. `runtime/<id>.json` 在终态时**删除**还是**更新为 terminal**（保留运行历史）？
   ——初稿建议删除（终态以 reports 为准，减少 git 噪音）。
2. `runtime/` 是否需要进 schema 版本管理（bump data schema v2）？
3. status 自动 fetch 是否也要覆盖 `--self-test` / 非 repo 场景（保持不联网）？
4. 是否需要把该 TODO 纳入 README roadmap 一起排期？
