# schedule-task 三层分离设计（修订版 v2）与实施计划

> **修订说明**：v1（2026-08-09）存在一处根本性错误 —— §2 允许知识层副本"可含 bin/src 源码作为参考"，
> 导致 install.sh 整仓拷贝、每个技能目录仍含一份完整代码，违背了 §1"工具与知识必须严格分离"的核心结论。
> 本修订版 v2 纠正该错误，并把安装/绑定/数据三条链路重新定义清楚。**执行以此文档为准。**

---

## 1. 设计决策（修订后）

### 1.1 三层各含什么

| 层 | 内容 | 存放位置 | 由谁创建/更新 |
|---|---|---|---|
| **工具层** | CLI 全部可执行代码（bin + src） | 机器级全局一份（PATH 上有 `schedule-task` 命令） | install.sh（**只安装全局命令 schedule-task**：npm install -g） |
| **知识层** | SKILL.md + references/ + templates/（**三项，零代码**） | 每个 agent 的 `skills/schedule-task` | `schedule-task install`（CLI 子命令，从全局包拷知识三项） |
| **数据层** | `.schedule-tasks-data/`（tasks/prompts/reports/batches/state/hooks/templates + version） | 每个项目内，committed 随 git | CLI（init / migrate / 任务运行） |

### 1.2 原则（硬约束）

1. **知识层零代码**：`bin/`、`src/`、`tests/`、`package.json`、`install.sh` 一律不进入技能目录。源码不存在"参考"用途 —— 如果使用全局命令时需要看源码才知道怎么用，那是**全局命令本身的帮助/输出有缺陷**，该修命令，而不是把源码塞进知识目录（浪费磁盘，制造 N 份代码与版本漂移）。
2. **知识来源 = 全局命令**。使用技能的 agent 只依赖 `schedule-task` 命令及其 help / status / doctor 输出；技能目录只是给 agent 的说明书，且 SKILL.md 内含**对所有命令的完整解释**。
3. **代码只随全局命令走，且不依赖任何"用户可能删除/移动"的源码位置**。install.sh 装完即与源码解耦（全局包是自包含拷贝）。
4. **安装与绑定分离**：install.sh 只管工具层（全局命令）；绑定技能到某个 agent 是另一件事，由 CLI 子命令 `install` 做。
5. **没有 `update` 子命令**：更新 = 重跑 install.sh（新安装自然替换旧全局命令），知识层刷新 = 重跑 `schedule-task install`（幂等覆盖）。

---

## 2. 各层动作（谁做什么，命令是什么）

### 2.1 工具层 —— install.sh 只装全局命令

- 唯一职责：让 `schedule-task` 出现在 PATH 上。
- **不再做任何其他事**：不复制技能目录、不设置任何 agent 的 skills 目录、没有 `--platform` 概念。
- 机制：**把项目克隆到临时目录 → `npm install -g <临时目录>` 按需拷贝到全局命令最终所在目录 → 临时目录清理**（全局命令是自包含拷贝，不依赖临时克隆）。
- **全局包内容**（最终目录）：既含命令行所需的脚本程序（bin + src），**也含知识数据（SKILL.md / references/ / templates/）** —— 因为后续 `install` 子命令要从全局包读取这三项（见 2.2），与 codegraph/graphify"全局二进制 + 项目数据 + 技能里只有指南"同构。
- 入口形态：
  - 最终用户：`curl -fsSL <raw install.sh URL> | bash`。
  - 开发者自用：在自己的克隆里跑 `./install.sh` 等价。
- 可保留 `--dry-run` 预览；无其他参数。
- **更新 = 重跑 install.sh**（curl 一行命令），新安装自然替换旧全局命令；**没有 `update` 子命令**。

### 2.2 知识层 —— 新增 CLI 子命令 `schedule-task install`

命名与参数对齐 codegraph 的 `install`（全局二进制自绑到各 AI 平台的同构模式）。

- 用途：把知识三项绑定进指定 agent 的 `skills/schedule-task`。
- 用法：
  ```
  schedule-task install                        # 交互询问目标平台
  schedule-task install --target kimi-code,claude,agents
  schedule-task install --target all --yes     # 非交互：装到所有已检测平台
  ```
  - `-t, --target <ids>`：逗号分隔的平台 id（`kimi-code` / `claude` / `agents`），或 `all` / `auto`（= 所有已检测平台）；默认交互询问。
  - `-y, --yes`：非交互（等价 `--target auto`）。
- **知识源 = 全局 CLI 包自身**（`skillRoot()`）：全局命令最终所在目录内自带 SKILL.md / references/ / templates/。绑定命令从全局包拷贝，**无需网络、无需克隆**。
- 动作：
  1. 目标目录：`~/.kimi-code/skills/schedule-task`（等，按平台映射）。
  2. **整目录覆盖**：目标已存在（含旧版本或旧形态的完整副本）→ 整个删除重拷，保证幂等且自动清掉旧代码残留。
  3. 拷贝知识三项（SKILL.md、references/、templates/），**不拷贝任何代码**。
  4. 写入 `.installed-from` 标记（记录来源全局命令版本 + 时间）。
- `docs/`、`README.md` 不属于知识三项，不随技能绑定（设计文档在仓库/GitHub 查看）。

### 2.3 数据层 —— 项目内由命令管理

- 技能在某个项目被触发/开始执行时：
  - 检查该项目 `.schedule-tasks-data/version` 与 CLI `SCHEMA_VERSION`：
    - 不匹配（旧）→ 提示/执行 `schedule-task migrate`（写命令硬停止，读命令警告）。
    - 匹配/新项目 → 用模板建立数据层（`init`：建目录 + 写 version + 拷 hooks/templates）。
- 此链路 v1 已实现，**保持不动**（core.js schemaCheck / migrate / init / ensureTemplates）。

---

## 3. 组件改动清单（文件级）

1. **`install.sh`** — 重写为只装全局命令：
   - 删除：知识副本复制逻辑（copy_skill/copy_skill_into）、`--platform`、平台检测与选择、技能目录相关全部输出。
   - 新增：curl|bash 时克隆到临时目录 → `npm install -g` → 清理临时目录（临时目录用 `mktemp -d` + trap）。
   - 保留：`--dry-run`；幂等说明。
2. **新增 `src/install.js`** — 绑定子命令实现（平台映射、`--target`/`--yes` 参数、整目录覆盖、拷三项、写标记）。
3. **`src/cli.js`** — 注册 `install` 命令；**移除 `update` 命令 case**；USAGE 增删改；写命令 schema 门禁清单不变。
4. **删除 `src/update.js`** — `update` 子命令整体移除（更新 = 重跑 install.sh，新装自然替换全局命令，无需 CLI 内建 update）；同步从 `bin/schedule-task.js` 预加载清单中移除 `require('../src/update.js')`。
5. **`src/doctor.js`** — 完整性检查改为两项：
   - 全局 CLI 包完整（bin + src + SKILL.md + references/ + templates/ 在 `skillRoot()` 内）；
   - 已绑定技能目录完整（知识三项在、**且不含代码** —— 发现 bin/src 等多余文件时提示"旧形态残留，重跑 install 清理"）。
6. **`SKILL.md`** — Prerequisite 改为两步安装：① `curl install.sh | bash`（全局命令）② `schedule-task install --target all`（绑定知识）。命令清单**补全全部命令解释、删除 `update` 条目**；删除"副本含 bin/src"、`node <skill-dir>/...` 痕迹；doctor/version 段同步。
7. **`README.md`** — 只面向最终用户：
   - **删除 Option A**（克隆源码 → 源码目录跑 ./install.sh 的路径不再提供；源码安装仅开发者自用，README 不写）。
   - 安装节改为两步（install.sh + install）；更新 install.sh flags 表（无 --platform）；**移除所有 `update` 子命令表述**（runtime 命令块、Update later 段改为"重跑 install.sh + 重跑 install"）。
   - repo layout 注释更新（删 update.js、新增 install.js）。
8. **`references/architecture.md`** — 三层安装拓扑表按 v2 更新（知识层零代码；安装/绑定/数据三链路；无 update 子命令）。
9. **`docs/refactor-three-layer-separation.md`** — 本文档即 v2 修订。
10. **`package.json`** — 版本 bump 至 3.2.0（新增 `install` 子命令、移除 `update`、安装流程重构）；`bin` 不变。
11. **测试**：
    - 新增 `tests/install.test.js`：temp HOME 下绑到各平台 → 断言知识三项在、无 bin/src/tests/package.json、无 .git、`.installed-from` 有；重复执行幂等（整目录覆盖）。
    - **删除 `tests/update.test.js`**；新增 `tests/install-sh.test.js` 替代：直接跑 install.sh（临时 HOME + 临时 npm prefix）→ 断言只装了全局命令、**不创建任何 agent 技能目录**、临时克隆已清理。
    - `tests/doctor.test.js`：补充"绑定目录含代码 → 提示旧形态残留"用例；更新完整性命名的断言。
    - `tests/cli.test.js`：`install` 参数校验用例；确认 `update` 已从命令表移除。

---

## 4. 关键设计点（为什么这样）

- **全局包 = 代码 + 知识数据**：`npm install -g` 把仓库整体装入全局命令最终所在目录，既含 bin/src 脚本程序，也含 SKILL.md/references/templates 知识三项 → `install` 子命令从 `skillRoot()` 读取知识，零网络、零克隆，工具层和知识层天然同版本。
- **整目录覆盖 = 幂等 + 自清理**：旧版本、旧形态（含代码）的技能目录，重跑 `install` 即被完整替换，不需要手动清理步骤。
- **install.sh 与源码解耦**：curl|bash 的临时克隆装完即弃，全局命令是自包含拷贝，用户删任何源码目录都不影响命令。
- **运行中任务隔离保留**：bin 入口预加载所有 src 模块（v1 §6 实现），install.sh 重装全局包时不影响运行中任务 —— 机制不变。
- **无 `update` 子命令**：更新 = 重跑 install.sh（新装自然替换旧全局命令）；知识层刷新 = 重跑 `install`（幂等覆盖）。少一个命令，少一份文档与维护面。
- **版本与 schema 分开管理不变**（v1 §3/§4 保留）。

---

## 5. 验证清单

- [ ] 新机器从零 `curl -fsSL <raw install.sh> | bash`：PATH 上出现 `schedule-task`；全局包内含 bin/src **及** SKILL.md/references/templates；**未改动任何 agent 技能目录**；临时克隆已清理。
- [ ] `schedule-task install --target all`：kimi-code / claude / agents 三处 `skills/schedule-task` 各有 SKILL.md + references/ + templates/，**无任何代码文件**；重复执行幂等。
- [ ] 绑定目录含代码（模拟旧形态）→ 重跑 `install` 后代码被清掉；`doctor` 对残留给出提示。
- [ ] `npm test`（node:test）全绿。
- [ ] 命令表：`schedule-task help` 无 `update`、有 `install`。
- [ ] 数据层回归：旧数据项目写命令硬停止 → `migrate` 恢复；新项目 `init` 建 version + 数据目录；读命令仅警告。
- [ ] 运行中任务升级隔离回归（install.sh 重装时运行中任务正常完成）。
- [ ] 本机实装：install.sh + `install --target all` 后，`schedule-task doctor` 全过。

---

## 6. 发布流程

1. 开发目录完成上述改动，`npm test` 全绿，本机实装验证通过。
2. 提交 + push（GitHub public repo）。
3. 各机器：`curl -fsSL <raw install.sh> | bash`（只装全局命令）→ `schedule-task install --target all`（绑定知识）。
4. 各项目：首次触发技能时按 2.3 完成 schema 检查 / migrate。

---

## 7. 遗留清理项（各机器一次）

- 删除旧软链接残留：`~/.local/bin/schedule-task`、旧 symlink 技能目录（v1 §7 不变）。
- 旧形态技能目录（含 bin/src 的完整副本）：重跑 `install` 即整目录替换，无需手动。
- 孤立源码树（如 `~/agent-skills/schedule-task`）：按需删除，与新方案无依赖。
