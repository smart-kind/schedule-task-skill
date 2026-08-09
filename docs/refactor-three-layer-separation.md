# schedule-task 改造计划：回归"三层分离"架构

> 本文档汇总了 2026-08-09 的架构讨论结论，作为技能开发目录的改造依据。
> 目标版本：3.1.0（程序版本独立于 schema 版本，见 §3）。

---

## 1. 背景与问题

安装形态经历了几轮迭代，目前处于混乱的双轨状态：

- **旧方案（软链接）**：技能目录软链接到源码树 + `~/.local/bin/schedule-task` 软链接。已被推翻，但本机残留未清干净，且 PATH 中遮蔽了正确的全局命令。
- **V3 方案（纯副本）**：把全部可执行代码复制进每个 agent 的技能目录，取消全局命令。这份方案把"工具（代码）"错误地放进了"知识（per-agent 技能目录）"，造成：同一代码多份拷贝、版本漂移、author/worker 多机协议不一致时难排查（昨天已实际踩坑：`{ok, stdout}` vs `rc.text` 字段名 bug 在两份拷贝中同时存在）。

**核心结论**：工具和技能（知识）必须严格分离。技能是给 agent 的说明书（per-agent 合理），代码是可执行程序（机器级共享合理），数据是项目资产（per-project）。

## 2. 目标架构：三层分离

| 层 | 内容 | 存放位置 | 更新方式 |
|---|---|---|---|
| 知识层 | SKILL.md、references/、templates/ | 每个 agent 的 `skills/schedule-task`（真实副本，可含 bin/src 源码作为参考，但**不作为运行依赖**） | install.sh 复制 |
| 工具层 | CLI 全部可执行代码（bin + src） | **机器级全局安装一份**（`npm install -g`，由 install.sh 完成；从 GitHub public repo 拉取，无需发布 npm 包） | install.sh 更新 |
| 数据层 | `.schedule-tasks-data/`（tasks/prompts/reports/batches/state/hooks） | 每个项目内，committed 随 git 走 | git + 任务运行 |

与 codegraph/graphify 同构：全局二进制 + 项目下数据目录 + 技能里只有指南。

## 3. 程序版本 vs schema 版本（分开管理）

- **程序版本**（package.json version）：改 bug、加功能，可能不影响数据格式。频繁变更。
- **schema 版本**（数据格式版本）：`envelope`/`prompt`/`report`/`state` 的格式契约。只在格式变更时递增，低频。

## 4. schema 版本机制（单一版本号，不做 min/current 双版本）

- 数据格式版本写在 `.schedule-tasks-data/version`（**committed**，随数据走 git；不能放 `state/`——那是 gitignored 的 worker 本地态）。
- CLI 编译期固定一个 `SCHEMA_VERSION`。
- 判断规则（三选一，够用即可，YAGNI 不加 min_schema）：
  - 数据 version < CLI 的 SCHEMA_VERSION → **需要迁移**（提示 `schedule-task migrate`）
  - 数据 version > CLI 的 SCHEMA_VERSION → **CLI 太旧**，拒绝并提示升级 CLI
  - 相等 → 正常执行

> 说明：min_schema（宽容窗口：旧 CLI 可读新数据一段时间）是"多节点渐进升级、不能停机"场景才需要的。当前规模（author + 少量 worker，git 同步）不需要，先保持简单；将来确有需要再加。

## 5. 升级链路（两件事分离）

### 5.1 程序安装/更新：install.sh（无 AI）

- install.sh 完成：复制知识层副本到各 agent 技能目录 + `npm install -g` 全局 CLI。
- 从 GitHub public repo 拉取（`curl -fsSL <raw install.sh URL> | bash`），无需发布 npm 包。
- 幂等；`--update` 覆盖更新。
- 安装/更新**不杀任何运行中的任务进程**（见 §7 隔离机制）。

### 5.2 数据迁移：技能触发时由 agent 完成（有 AI）

- install.sh 无法迁移数据——它不知道有多少项目用了技能。
- 技能被触发时，agent 做一次**轻量版本检查**（`schedule-task doctor` / 或 status 输出里带 `CLI vX · data schema vY`）：
  - **只读命令**（status / doctor / log）：显示迁移警告，但继续执行——避免"看不到状态就无法决定迁移"的死锁。
  - **写命令**（run / audit / cancel / archive）：检测到未迁移，**硬停止**，提示先跑 `schedule-task migrate`。
- `migrate` 由 CLI 提供确定性迁移逻辑（无 AI）；agent 只负责"发现 + 决定 + 在安全窗口执行"（迁移前先 commit 现状，可回滚）。

## 6. 运行中任务隔离：入口预加载全部模块（不打包）

- 风险：Node `require` 是运行时执行的，进程启动后若磁盘上的模块文件被 install.sh 替换，尚未 require 的模块会读到新代码——同一进程内新旧代码混合执行会错乱。
- 方案：**在 `bin/schedule-task.js` 入口处预加载所有 `src/*.js` 模块**（显式 require 一遍）。进程一启动全部代码进入内存缓存，之后磁盘怎么替换都不影响运行中任务。
- 不采用打包成单文件的方案（引入构建复杂度；预加载一行代码达到同等隔离效果）。

## 7. 清理项（各机器执行一次）

- 删除旧软链接残留：
  - `~/.local/bin/schedule-task`（PATH 遮蔽全局命令）
  - `~/.agents/skills/schedule-task`（若为软链接）
  - `~/.claude/skills/schedule-task`（若为软链接）
- 保留 npm 全局（`npm ls -g schedule-task` 应指向本仓库）与 per-agent 知识副本。
- 孤立源码树（如 `~/agent-skills/schedule-task`）按需删除，与新方案无依赖。

## 8. 具体改动清单（文件级）

1. `install.sh`：
   - 复制知识层副本到各 agent 技能目录（真实副本、删 .git 与 graphify-out、写 `.installed-from`）。
   - `npm install -g .` 装全局 CLI（从 GitHub 拉取源码）。
   - 移除旧软链接（~/.local/bin、旧 symlink 技能目录）时给出提示。
   - 输出明确：CLI 为全局命令 `schedule-task`；技能目录仅知识。
2. `SKILL.md`：Prerequisite 改为"install.sh 一键安装：技能副本 + 全局命令"；所有"全局命令"表述与技能内 bin 的关系写清；更新流写明"改开发目录 → 发布 → 各机器 install.sh --update"。
3. `bin/schedule-task.js`：入口预加载全部 `src/*.js`。
4. `src/`：
   - 新增 `SCHEMA_VERSION` 常量（core.js）。
   - 新增 `migrate` 子命令（确定性迁移；检测并升级 `.schedule-tasks-data/version`）。
   - `status`/`doctor` 输出版本行（CLI vX · data schema vY）。
   - 写命令执行前做 schema 检查，不匹配则硬停止。
   - 读命令仅警告。
5. `package.json`：版本 bump；`bin` 保持不变。
6. README / references/：清理"全局安装/软链接"旧表述，补 schema 版本与升级链路说明。

## 9. 验证清单

- [x] 新机器从零 `install.sh` 后：全局命令 `schedule-task` 可用；技能副本存在且无 .git（本机 macOS 已验证；Linux VPS 待验）。
- [x] `npm test`（node:test）全绿（34/34）。
- [x] `schedule-task status` 在 author 侧正确显示 worker 已完成任务（回归：status --self-test 覆盖 author 模式，git show `{ok, stdout}` 路径）。
- [x] 升级链路演练：旧数据项目触发写命令被硬停止 → `migrate` 后恢复（含读命令仅警告、migrate 幂等、CLI 太旧拒绝）。
- [x] 运行中任务升级隔离：任务运行中重跑 install.sh，任务正常完成，无混合代码（演练：运行中副本被替换为打了标记的新代码，运行进程仍用预加载旧代码，任务 dev-done 收尾）。

## 10. 发布流程

1. 开发目录完成改造，自测通过。
2. 提交 + push（GitHub public repo）。
3. 各机器执行 `curl -fsSL <raw install.sh> | bash`（或 `install.sh --update`）更新知识副本 + 全局 CLI。
4. 各项目技能首次触发时按 §5.2 完成数据迁移。
