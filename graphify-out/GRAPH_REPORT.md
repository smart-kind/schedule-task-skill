# Graph Report - schedule-task  (2026-08-08)

## Corpus Check
- 37 files · ~28,272 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 448 nodes · 623 edges · 31 communities (27 shown, 4 thin omitted)
- Extraction: 83% EXTRACTED · 17% INFERRED · 0% AMBIGUOUS · INFERRED: 105 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6dff2903`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Design Rationale
- Core Utilities
- Git & Archive Layer
- Dispatch & Watchdog
- Docs & Invariants
- Test Harness & Helpers
- Init & Doctor
- Status & Process Tree
- Agent Launcher
- Topology: Author/Worker Flow
- Cancel Command
- Package Metadata
- CLI Entry Point
- Cancel Flow Diagram
- Watchdog Flow Diagram
- Init Flow Diagram
- Run Flow Diagram
- Merge-Batch Flow
- Status Flow Diagram
- Machine Roles
- Mock Agent Helper
- Install Script
- Notify Hook
- Execution Loop
- status worker vs author mode (live truth vs committed truth)
- archive.test.js
- Runner (worktree, park-resume, trust-but-verify)
- Plan-harness prompt skeleton (every task prompt is built from it)
- status command (read-only report)
- State files contract (gitignored, worker-local truth)
- graphify — optional knowledge-graph integration

## God Nodes (most connected - your core abstractions)
1. `git()` - 18 edges
2. `Runner (worktree, park-resume, trust-but-verify)` - 13 edges
3. `Business flow overview (业务视角, no tech details)` - 11 edges
4. `readConfig()` - 9 edges
5. `schedule-task runtime (zero-dependency Node CLI)` - 9 edges
6. `render()` - 7 edges
7. `State files contract (gitignored, worker-local truth)` - 7 edges
8. `Plan-harness prompt skeleton (every task prompt is built from it)` - 7 edges
9. `invoke()` - 6 edges
10. `showFile()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `state/<id> first-line state-word contract` --semantically_similar_to--> `State files contract (gitignored, worker-local truth)`  [INFERRED] [semantically similar]
  README.md → references/envelope-schema.md
- `Routing envelope (tasks/<id>.json)` --semantically_similar_to--> `Envelope (tasks/<id>.json, filename IS the id)`  [INFERRED] [semantically similar]
  README.md → references/envelope-schema.md
- `Watchdog daemon (resident, 300s tick)` --semantically_similar_to--> `Watchdog (worker daemon, 300s dispatch tick)`  [INFERRED] [semantically similar]
  README.md → references/architecture.md
- `Detached task runner` --semantically_similar_to--> `Runner (worktree, park-resume, trust-but-verify)`  [INFERRED] [semantically similar]
  README.md → references/architecture.md
- `Task caretaker runner (任务管家 — 陪跑: park, retry, verify, report)` --semantically_similar_to--> `Runner (worktree, park-resume, trust-but-verify)`  [INFERRED] [semantically similar]
  docs/business-flow.md → references/architecture.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **schedule-task CLI command set (one CLI, route on the first argument)** — skill_init_command, skill_status_command, skill_update_command, skill_archive_command, skill_cancel_command, skill_merge_batch_command, skill_log_command, skill_watchdog_command, skill_doctor_command [EXTRACTED 1.00]
- **Authored unit per task: envelope + plan-harness prompt + batch manifest** — skill_envelope, skill_plan_harness_prompt, skill_batch_manifest [EXTRACTED 1.00]
- **Two-layer architecture components (trigger / driver / executor)** — references_architecture_watchdog, references_architecture_runner, references_architecture_executor [EXTRACTED 1.00]
- **取消任务主流程** — docs_diagrams_cancel_flow_start, docs_diagrams_cancel_flow_select_target, docs_diagrams_cancel_flow_finished_decision, docs_diagrams_cancel_flow_stop_running, docs_diagrams_cancel_flow_mark_cancelled, docs_diagrams_cancel_flow_dependents_decision, docs_diagrams_cancel_flow_cascade_cancel, docs_diagrams_cancel_flow_preserve_workspace, docs_diagrams_cancel_flow_done [EXTRACTED 1.00]
- **执行循环（最多 60 轮）** — docs_diagrams_run_flow_existing_session, docs_diagrams_run_flow_launch_agent, docs_diagrams_run_flow_completion_marker, docs_diagrams_run_flow_failure_handling [EXTRACTED 1.00]
- **执行机状态读取分支** — docs_diagrams_status_flow_is_executor, docs_diagrams_status_flow_read_local_truth, docs_diagrams_status_flow_aggregate_statuses [EXTRACTED 1.00]
- **作者机状态推断分支** — docs_diagrams_status_flow_is_executor, docs_diagrams_status_flow_read_submitted_reports, docs_diagrams_status_flow_aggregate_statuses [EXTRACTED 1.00]
- **任务生命周期主流程：作者推入意图 → Git 通道 → 执行者推回结果** — docs_diagrams_topology_author_box, docs_diagrams_topology_git_remote, docs_diagrams_topology_worker_box [EXTRACTED 1.00]
- **任务启动前的三道门控检查（机器归属 / 开始时间 / 依赖完成）** —  [EXTRACTED 1.00]

## Communities (31 total, 4 thin omitted)

### Community 0 - "Design Rationale"
Cohesion: 0.12
Nodes (19): Dependency-ordered batch scheduling (depends_on gating), Git remote as the only channel (唯一通道, no direct link), Add-only git design (no merge conflicts on the bus), Routing envelope (tasks/<id>.json), Gates as prose (polyglot acceptance criteria), Git-only channel (push intent, pull results), No AI in the control loop, Resume via CLI session ids (no lost work across limit windows) (+11 more)

### Community 1 - "Core Utilities"
Cohesion: 0.06
Nodes (28): appendNotes(), dataDir(), ensureDir(), fs, intEnv(), killGroup(), killTree(), logLine() (+20 more)

### Community 2 - "Git & Archive Layer"
Cohesion: 0.11
Nodes (25): { execFileSync }, git(), headSha(), objectExists(), showFile(), treeClean(), core, fs (+17 more)

### Community 3 - "Dispatch & Watchdog"
Cohesion: 0.10
Nodes (29): core, dispatch(), fs, { git, treeClean }, path, { spawn }, tick(), core (+21 more)

### Community 4 - "Docs & Invariants"
Cohesion: 0.29
Nodes (10): Business flow overview (业务视角, no tech details), Invariant: the author is the only merger, archive housekeeping (retire done/cancelled tasks), archive command (retire finished tasks), cancel command (process-group kill + cascade), init command (role registration + data dirs + migration), merge-batch command (author-side finalization), Fixed role separation (author owns lifecycle; workers only execute) (+2 more)

### Community 5 - "Test Harness & Helpers"
Cohesion: 0.12
Nodes (15): addTask(), dataRoot(), { execFileSync }, fs, git(), makeRepo(), os, path (+7 more)

### Community 6 - "Init & Doctor"
Cohesion: 0.12
Nodes (21): core, doctor(), { findInPath }, fs, path, ask(), COMMITTED_DIRS, core (+13 more)

### Community 7 - "Status & Process Tree"
Cohesion: 0.13
Nodes (21): childPids(), COL(), core, dur(), fs, { git, showFile }, path, processTree() (+13 more)

### Community 8 - "Agent Launcher"
Cohesion: 0.14
Nodes (16): claudeArgs(), extractSessionId(), fs, invoke(), kimiArgs(), parseResetEpoch(), path, readline (+8 more)

### Community 9 - "Topology: Author/Worker Flow"
Cohesion: 0.16
Nodes (17): 作者⑥ 验收合并（批次全部完成后并入主开发分支）, 作者③ 指派执行者（指定哪台机器执行、用哪条分支）, 作者盒（Author）——日常开发电脑，只负责发起与验收, 作者④ 提交并推送（任务进入唯一通道 Git）, 作者② 生成任务单与说明（机器可读任务单 + 详细说明）, 作者① 发起任务（自然语言描述：做什么、何时、交给谁）, 作者⑤ 查询进度（随时查看每个任务进行到哪一步）, Git 远程仓库——唯一通道，双方只做加法互不冲突 (+9 more)

### Community 10 - "Cancel Command"
Cohesion: 0.13
Nodes (14): cancel(), core, fs, path, sleepMs(), assert, { cancel }, core (+6 more)

### Community 11 - "Package Metadata"
Cohesion: 0.12
Nodes (15): bin, schedule-task, description, engines, node, keywords, license, name (+7 more)

### Community 12 - "CLI Entry Point"
Cohesion: 0.19
Nodes (11): { main }, core, fs, main(), parseArgs(), path, { spawnSync }, VALUE_FLAGS (+3 more)

### Community 13 - "Cancel Flow Diagram"
Cohesion: 0.16
Nodes (14): 级联取消依赖者, 编码助手, 有任务依赖它吗？, 完成, 取消只在执行机上生效, 任务已经收尾了？, 标记「已取消」+ 记录原因, 通知钩子 (+6 more)

### Community 14 - "Watchdog Flow Diagram"
Cohesion: 0.18
Nodes (14): 还有空闲执行名额吗？（默认同时最多跑 2 个任务，可调）, 领取「检查令牌」（同一时间只允许一次检查，避免重复开工）, 它依赖的任务还没完成？——跳过，先等前面的落地, 退出（作者机不干活）, 退出（下次再看）, 这台机器是执行者吗？（看门狗只在执行机上运行）, 条件齐了 → 启动任务执行（后台独立进程，看门狗不陪跑）, 任务指定了别的机器？——跳过，等那台机器来接 (+6 more)

### Community 15 - "Init Flow Diagram"
Cohesion: 0.19
Nodes (13): 检查环境依赖, 是「执行者」角色？（决策）, 初始化完成, 确认机器名（默认主机名）, 确认这台机器的角色, 创建项目数据目录, 数据目录子项：任务单/说明/报告/批次/状态/通知钩子, 发现旧版数据目录？（决策） (+5 more)

### Community 16 - "Run Flow Diagram"
Cohesion: 0.18
Nodes (13): 出现「完成标记」？, 完成标记, 双重验证, 有旧会话？, 没完成怎么办？, 发起编码助手（claude / kimi）, 标记「运行中」, 准备专属工作区 (+5 more)

### Community 17 - "Merge-Batch Flow"
Cohesion: 0.22
Nodes (11): 中止，交人工解决, 验收完成, 合并有冲突？, 任务分支上有「完成」报告？, 作者验收合并（merge-batch）, 把它的分支并入目标分支, 拉取最新, 全部处理完 → 推送 (+3 more)

### Community 18 - "Status Flow Diagram"
Cohesion: 0.28
Nodes (9): 汇总所有任务状态, 结束（只读）, 按批次分组呈现, 识别本机身份, 本机是执行者？, 输出汇总计数, 查询状态（status）, 读「本地真相」 (+1 more)

### Community 19 - "Machine Roles"
Cohesion: 0.67
Nodes (4): Author role (作者盒 — initiates, queries, accepts/merges), Worker role (执行盒 — executes on schedule, returns results), Author box (machine role), Worker box (machine role, VPS watchdog)

### Community 24 - "status worker vs author mode (live truth vs committed truth)"
Cohesion: 0.14
Nodes (14): automation/ -> .schedule-tasks-data migration, .schedule-tasks-data per-project data directory, Machine identity (state/.machine role+id), state/<id> first-line state-word contract, hooks/notify.sh notification hook (events, no-op default), run.log, attempt-<n>.jsonl, session_id artifacts, status worker vs author mode (live truth vs committed truth), Worker-local run state (~/.local/state/schedule-task/<repo>/) (+6 more)

### Community 25 - "archive.test.js"
Cohesion: 0.15
Nodes (12): archive(), core, fs, { git }, path, { archive }, assert, core (+4 more)

### Community 26 - "Runner (worktree, park-resume, trust-but-verify)"
Cohesion: 0.20
Nodes (12): Limit-park and resume, never redo (限流停车续跑), Task caretaker runner (任务管家 — 陪跑: park, retry, verify, report), agents.js router (invoke contract, profiles), Exit-code contract (0 done / 75 limit / else ambiguous), Invariant: resume via CLI session ids, Invariant: per-task branches, never main/dev directly, Invariant: per-task worktree isolation, Agent profiles (claude | kimi) (+4 more)

### Community 27 - "Plan-harness prompt skeleton (every task prompt is built from it)"
Cohesion: 0.31
Nodes (11): Plan-harness prompt (prompts/<id>.md), README — schedule-task overview, self-test command (node:test suite), Architecture reference (canonical design rationale), Envelope schema reference (field table, state contract), Operations reference (running a live system), Plan-harness prompt (prompts/<id>.md), SKILL.md — schedule-task skill spec (+3 more)

### Community 28 - "status command (read-only report)"
Cohesion: 0.22
Nodes (10): Batch manifest (batches/<batch>.json), Process model (detached process groups replace tmux/flock), Batch manifest (batches/<batch>.json, committed author-side record), Unified ID convention (<B|T><YYMMDD>-<seq>-<tag>), Batch manifest (batches/<batch>.json), Create flow: DISCUSS -> DRAFT -> REVIEW -> COMMIT, Hard rules (id=filename, one branch per task, workers never merge), ID convention <B|T><YYMMDD>-<seq>-<tag> (+2 more)

### Community 29 - "State files contract (gitignored, worker-local truth)"
Cohesion: 0.27
Nodes (10): Dispatch tick (eligibility, concurrency cap, pid lock), Invariant: liveness by PID, not by silence, Invariant: machine identity, no cross-machine racing, Watchdog (worker daemon, 300s dispatch tick), Backwards compatibility (old envelopes as single-task batches), Envelope (tasks/<id>.json, filename IS the id), Envelope field table (one consumer per field), State files contract (gitignored, worker-local truth) (+2 more)

### Community 30 - "graphify — optional knowledge-graph integration"
Cohesion: 0.33
Nodes (5): Commit policy for graphify-out/, Env check & install (per machine — author and worker), graphify — optional knowledge-graph integration, Refresh before task work, What it is

## Knowledge Gaps
- **168 isolated node(s):** `{ main }`, `name`, `version`, `description`, `schedule-task` (+163 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `git()` connect `Git & Archive Layer` to `archive.test.js`, `Dispatch & Watchdog`, `Init & Doctor`, `Status & Process Tree`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `Runner (worktree, park-resume, trust-but-verify)` connect `Runner (worktree, park-resume, trust-but-verify)` to `Design Rationale`, `status worker vs author mode (live truth vs committed truth)`, `State files contract (gitignored, worker-local truth)`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `Business flow overview (业务视角, no tech details)` connect `Docs & Invariants` to `status worker vs author mode (live truth vs committed truth)`, `Plan-harness prompt skeleton (every task prompt is built from it)`, `status command (read-only report)`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `Runner (worktree, park-resume, trust-but-verify)` (e.g. with `Task caretaker runner (任务管家 — 陪跑: park, retry, verify, report)` and `Detached task runner`) actually correct?**
  _`Runner (worktree, park-resume, trust-but-verify)` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `{ main }`, `name`, `version` to the rest of the system?**
  _168 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Design Rationale` be split into smaller, more focused modules?**
  _Cohesion score 0.12280701754385964 - nodes in this community are weakly interconnected._
- **Should `Core Utilities` be split into smaller, more focused modules?**
  _Cohesion score 0.05647840531561462 - nodes in this community are weakly interconnected._