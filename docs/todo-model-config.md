# TODO 计划：执行者（worker）模型集合配置

> 状态：**计划中，未实现**（2026-08 记录）。本文档只记录需求与待办方向，供后续实现时参考。
> 实现前需与 `docs/refactor-three-layer-separation.md` 的三层分离原则对齐（配置属于数据层，排除源码仓库/技能目录管理）。

---

## 1. 需求背景

系统里每个 worker（最终执行者，跑 runner / agents.js）都有自己的 AI 身份——`kimi-code` 或
`claude`（CC）。同一身份的**可用模型集合**在不同机器上并不相同，取决于该机器上安装的
客户端及其订阅/网关：

- **Kimi Code**：可用模型由用户自己定义，例如 `K3`、`DeepSeek V4 flash` 等（用户特殊配置，只有用户自己知道）。
- **Claude Code（传统订阅）**：可用模型为 `opus` / `sonnet` 等订阅内模型。
- **Claude Code（Anthropic 兼容网关）**：worker 上装的是兼容 Anthropic 协议的模型集合，
  可用模型集合的定义与官方订阅完全不同。

现状：任务的可用模型由 envelope 的 `agent` / `model` 字段指定（默认 `claude` + 默认模型），
**没有按机器配置「这个执行者到底能用哪些模型」的入口**。

## 2. 目标

新增一个 **JSON 配置文件**，让用户按 worker 配置该执行者能使用的模型集合：

- **用户不配置** → 按技能（SKILL.md / 代码）里的默认值运行，行为与现状一致；
- **用户配置了** → 以配置文件为准；
- 配置属于**数据层**，**排除源码仓库管理**：不写死在 `src/`、不随 `install.sh` /
  `schedule-task install` 分发、不进技能目录；由用户在自己机器的数据目录里维护。

## 3. 设计要点（实现时确认，可调整）

- **放置位置**（候选，需定）：
  - worker 本机、gitignored 的位置（如 `~/.local/state/schedule-task/<repo>/` 或
    `.schedule-tasks-data/state/`）——每个 worker 配置自己的模型集合，符合「不同 worker
    不同身份」；
  - 或 `.schedule-tasks-data/` 内新增配置文件（committed 会随仓库传到所有机器，与
    per-worker 诉求冲突，倾向不用，待定）。
- **文件名**（候选）：`model-set.json` / `workers.json` / `agent-models.json`。
- **内容形态**：按平台（`kimi-code` / `claude`）→ 可用模型列表（可含别名/显示名），可选
  默认模型；结构示例：
  ```json
  {
    "kimi-code": { "models": ["K3", "DeepSeek V4 flash"], "default": "K3" },
    "claude":    { "models": ["opus", "sonnet"], "default": "sonnet" }
  }
  ```
- **读取点**：`agents.js`（agent 路由）或 `core.js`——envelope 的 `model` 落在该集合内则
  使用；不在集合内则明确报错/提示（或回退默认，实现时定）。
- **文档同步**：SKILL.md 命令解释、`references/envelope-schema.md` 补配置说明。

## 4. 待办清单

- [ ] 定配置文件的放置位置 + 文件名 + JSON schema（含非法值处理）
- [ ] `agents.js` / `core.js` 读取配置：未配置 → 默认值；配置 → 使用配置
- [ ] envelope `model` 与配置集合的匹配/报错/回退策略
- [ ] 文档：SKILL.md、`references/envelope-schema.md` 补模型集合配置说明
- [ ] 测试：未配置用默认 / 配置生效 / 非法配置回退
- [ ] 实现时 bump 版本号（schema 不变则只 bump 程序版本）

## 5. 验收标准（实现时对照）

- 不配置：现有行为完全不变（默认模型）。
- 配置 `kimi-code` 含 `K3`、`DeepSeek V4 flash`：envelope `model` 命中即被使用。
- 配置 `claude` 为网关模型集合：可用集合即网关集合，不再假设官方订阅模型。
- 配置改动不触发任何源码仓库/技能目录的变更。
