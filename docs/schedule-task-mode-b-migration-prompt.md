> ⚠️ **已废弃（superseded）**：本文档是 2026-08 执行「V3 纯副本自包含」迁移（模式 B）时的任务 prompt。
> 该方案随后被推翻 —— 当前目标架构回归**三层分离**（工具层全局 CLI + 知识层技能副本 + 数据层项目目录），
> 即重新引入 `npm install -g` 全局命令。**不要**再按本文档执行任何改动；以
> [`refactor-three-layer-separation.md`](./refactor-three-layer-separation.md) 为准。
> 保留本文档仅作历史记录（当时的双轨混乱与代码重复问题正是新方案要解决的）。

# 任务：把 schedule-task 技能从「全局安装 + 副本」双轨方案收敛为「纯副本自包含」方案（模式 B）

**背景**：当前 install.sh 同时做两件事——①把技能完整复制到各 agent 的 `skills/schedule-task` 目录（删 `.git` 和 `graphify-out`，打 `.installed-from` 标记）；②`npm install -g` 装全局命令 `schedule-task`（node_modules 里是软链接，真实源在 `~/.local/share/schedule-task/src`）。这造成同一套代码存在两份（技能副本 + 全局源），要同步维护；而且一旦全局安装/软链接链条断掉，整个系统无法工作。现决定废弃全局安装，只保留「完整副本进技能目录」一种形态：技能目录里包含全部可执行代码（bin + src + tests），拷贝即用，不依赖任何机器级安装。

请在开发目录完成以下改动并提交一个新版本：

## 1. install.sh 重构

- 删除 `npm install -g` 这一步及其相关输出（"CLI: npm install -g"、"The CLI is installed globally as schedule-task" 等措辞全部去掉）。
- 删除「移除 `~/.local/bin/schedule-task` 旧软链接」的清理逻辑（那是旧全局方案的残留处理，新方案不再需要；如需保留，仅作为可选的迁移提示，不执行删除）。
- 保留并完善核心能力：把技能作为真实副本（`cp -R`，无软链接）复制到所选平台（kimi-code / claude / agents）的 `skills/schedule-task`，副本内删除 `.git` 和 `graphify-out`，写入 `.installed-from` 标记；`--update` 时用最新源码替换现有副本；`--dry-run` 支持；检测到旧的软链接残留时提示"这是旧方案，请用 --update 或手动删除后重装"，不做静默转换。
- 安装后输出明确说明：本技能自包含，CLI 位于技能目录下 `bin/schedule-task.js`，用 `node <技能目录>/bin/schedule-task.js <子命令>` 运行，无需任何全局安装。

## 2. SKILL.md 同步改写

- Prerequisite 段落：删除「runs `npm install -g` for the global `schedule-task` command」；改为「把本技能目录复制到 agent 的 skills 目录即可，无需全局安装；运行 `./install.sh` 或直接拷目录」。
- 全文把「the global `schedule-task` command / `schedule-task` CLI（作为 PATH 命令）」的表述，改为「技能目录内 `bin/schedule-task.js`」的调用方式（例如 `node <技能目录>/bin/schedule-task.js status`），并说明 agent 如何定位技能目录。
- `update` 相关：副本内没有 `.git`，原「CLI 运行于 git checkout 时 git pull 更新」的机制不再适用；更新方式统一为「在开发目录改完 → 提交发布 → 各机器跑 `install.sh --update` 重装副本」。文档里写清楚这个新更新流。
- 架构/引用文档（README、references/architecture.md、operations.md 等）里所有「全局命令」「npm install」「软链接安装」的描述同步清理。

## 3. 运行时自洽性检查

- 确认副本内的 `bin/schedule-task.js` 用 `node` 直接运行完整可用（相对 require `../src/*.js` 在副本内闭合，无任何机器级依赖）；`npm test`（node:test）在副本内直接可跑。
- `schedule-task doctor` 的依赖检查：node/git/claude/kimi 保留；与"全局安装"相关的检查项改为检查技能副本完整性（bin、src 存在）。
- 确认 install.sh 在新机器（macOS 和 Linux VPS）上从零安装后，副本内直接运行 `node bin/schedule-task.js status/init` 全流程可用。

## 4. 版本与提交

- `package.json` 版本号 bump（建议 2.1.0，语义为「移除全局安装，纯副本自包含」）。
- 提交信息清晰说明本次变更：移除 npm 全局安装与软链接方案，技能改为纯自包含副本，install/SKILL/README 同步更新。
- 提交后，各机器通过 `install.sh --update`（或重跑 install.sh）把副本更新到新版本即可；旧机器上残留的全局命令（nvm 里的 npm 全局、`~/.local/bin/schedule-task` 软链接、`node_modules/schedule-task` 软链接）可按需手动清理，与新方案无依赖关系。
