---
name: schedule-task
description: Author scheduled, resumable automation tasks (dev/test/audit) from natural language — single tasks or dependency-ordered batches — for any repo that has the automation/ runtime. Use when the user wants to schedule autonomous coding-agent work to run later on a worker box — it creates the routing envelope (automation/tasks/<id>.json), a plan-harness prompt (automation/prompts/<id>.md), and for multi-task batches a manifest (automation/batches/<batch>.json), then commits them to the inbox branch for the VPS dispatcher. Trigger on "schedule a task", "run X autonomously tonight", "create an automation task", "initialize automation".
---

# schedule-task

Turn a natural-language request into one or more scheduled, **resumable** tasks the VPS dispatcher
runs unattended. Output = a routing **envelope** + a **plan-harness prompt** per task (plus a
**batch manifest** when one requirement splits into several tasks), committed to the repo's inbox
branch (default `dev`) where the dispatcher picks them up. Never a one-liner prompt — a single
sentence is too weak to steer a multi-hour autonomous run.

Everything here is agent-neutral: the tasks are executed by the coding agent CLI configured per
task (`"agent": "claude"` or `"kimi"`), and this skill itself works in any SKILL.md-compatible
agent.

## Prerequisite

The current repo must contain the automation runtime: `automation/dispatch.sh`, `run-task.sh`,
`status.sh`, `archive-task.sh`, `coding-agent.sh`, `hooks/notify.sh`. If `automation/dispatch.sh`
is missing in the repo you're working in, run the **`init`** sub-command first (below) — it copies
the bundled bootstrap from the `automation/` directory next to this SKILL.md.

## Sub-commands (route on the first argument)

- **`status`** — read-only report of every scheduled task. Run `bash automation/status.sh` and
  relay its output verbatim (the batch-grouped table + the counts line). The script auto-detects
  the machine: on the VPS *worker* it reads live `state/` flags + run logs; on the author box after
  `git pull` it infers state from committed `reports/<id>.md` + `tasks/` presence, since `state/`
  is gitignored. Do NOT author anything in this mode. (`bash automation/status.sh --self-test`
  verifies the reporter itself.)

- **`init`** — install the runtime into the current repo (the repo root, not a subdirectory):
  1. Copy every file from the `automation/` directory bundled next to this SKILL.md into
     `<repo>/automation/`. Idempotent: **skip files that already exist**, and report what was
     copied vs skipped. (Keep existing `tasks/`, `prompts/`, `reports/`, `batches/` content —
     only add what's missing.)
  2. Merge `automation/gitignore.snippet` into the repo's `.gitignore` — append only the lines
     that are missing (currently just `automation/state/`).
  3. Check dependencies on PATH: `jq`, `tmux`, `git`, and at least one of `claude` / `kimi`.
     Report what's missing; don't fail hard — the deps matter on the *worker*, not necessarily
     on the author's machine.
  4. Print the exact cron line for the worker box, with `<repo>` replaced by the absolute path
     of the repo **on the worker**:
     ```
     */5 * * * * flock -n /tmp/schedule-task-dispatch bash <repo>/automation/dispatch.sh >> <repo>/automation/dispatch.log 2>&1
     ```
     Remind the user: `automation/state/` stays local to the worker (gitignored); it is the
     worker-local truth and never crosses git.

- **`archive`** — retire finished tasks: run `bash automation/archive-task.sh <id>` per task (or
  once per task of a finished batch). It moves the envelope + prompt pair into
  `automation/{tasks,prompts}/archive/` — kept in git as a faithful record — and **refuses any
  task whose state is not `done` or `cancelled`**. Reports in `automation/reports/` are never
  moved.

- **`cancel`** — stop one task or everything in flight: `bash automation/cancel-task.sh <id>
  [reason...]` or `bash automation/cancel-task.sh --all [reason...]`. A **pending** task simply
  never dispatches again; a **running** one gets its tmux session killed (runner, limit-park
  `sleep`, and the coding-agent CLI child all die with the pane — so cancel works even mid
  limit-wait). Cancelling **cascades**: active tasks whose `depends_on` chain includes the
  cancelled id are cancelled too (they could never become eligible). Terminal tasks
  (`done`/`failed`/`cancelled`) are refused. The task's worktree is left in place for
  inspection. No git mutations — cancel is worker-local state (`state/<id>` = `cancelled` +
  a notes line + notify hook). Batch interplay: a batch where every remaining task is
  `done`/`cancelled` still merges the done branches; an all-cancelled batch merges nothing.
  NOTE: this only works on the **worker** (needs live `state/` + tmux); from the author box,
  ssh to the worker or ask the user to run it there.

- **anything else / no argument** → the create flow below.

## Flow: DISCUSS → DRAFT → REVIEW → COMMIT  (create one *or many* tasks)

### 1. DISCUSS  (interview — do NOT skip)

First establish the shape: **single task or batch?** One requirement can map to N tasks that share
a batch id. For a batch, agree the **dependency graph** explicitly: which tasks run in parallel,
which must wait on which (`depends_on`). Interview each task's specifics separately, but share
what's common (guardrails, branch rules) so you don't re-ask.

Ask, one at a time, only what you cannot infer from the repo/context:
- Mission / outcome.
- **type**: `dev` | `test` | `audit` (a routing/report label).
- An existing plan/spec doc to reference?
- **Acceptance gates in plain language** (e.g. "the test suite passes", "browser smoke is clean").
  NEVER hard-code project-specific commands like `npm test` / `pytest` — the executor discovers
  the right command for the repo. Keeping gates as prose is what makes the system polyglot.
- **Schedule**: `run_at` (ISO-8601 UTC) for a one-shot. (Recurring cron schedules are not
  supported.)
- Guardrails / invariants (branch rules, architecture constraints, "never touch main").
- What **"done"** looks like, and how to behave **on resume** after an interruption.
- Which executor: `agent` = `claude` (default) or `kimi`, and optionally a `model` alias.

### 2. DRAFT

- `id` = `YYYY-MM-DD-<slug>`. **Batch tasks** share the id prefix `YYYY-MM-DD-<batch>` and get
  `-<slug>` suffixes (e.g. `2026-08-05-p0805-formation`, `2026-08-05-p0805-retreat`); the `batch`
  field is that shared prefix. Check collisions against `automation/tasks/*.json` — and against
  the other ids you're minting this pass.
- Write `automation/prompts/<id>.md` from `templates/plan-harness.md` (next to this SKILL.md),
  filling **every** `<...>` slot and the `$id` markers.
- Write `automation/tasks/<id>.json` — the envelope only:
  ```json
  {
    "id": "2026-08-05-p0805-retreat",
    "batch": "2026-08-05-p0805",
    "type": "dev",
    "repo": "/abs/path/on/worker",
    "branch": "automation/p0805-retreat",
    "prompt_file": "automation/prompts/2026-08-05-p0805-retreat.md",
    "schedule": { "run_at": "2026-08-05T02:00:00Z" },
    "depends_on": ["2026-08-05-p0805-formation"],
    "agent": "claude",
    "model": "opus"
  }
  ```
  Field notes:
  - **Branch convention: one branch per task**, `automation/<slug>`. The runner cuts it from the
    inbox branch on the worker. The old shared `automation/dev` convention is dead — do not use it.
  - `batch`, `depends_on`, `agent`, `model` are optional: a task without them is a single-task
    batch with no dependencies on the default agent (`claude`).
  - **No `gate` field** — gates live in the prompt as prose.
- **Batch manifest** — only when the pass authors more than one task:
  `automation/batches/<batch>.json`:
  ```json
  {
    "id": "2026-08-05-p0805",
    "title": "P0805 formation + retreat rework",
    "notes": "formation must land before retreat touches the same config",
    "tasks": ["2026-08-05-p0805-formation", "2026-08-05-p0805-retreat"],
    "merge_target": "dev"
  }
  ```
  `tasks` lists ids in dependency order. The manifest is committed — it is the author-side durable
  record of the batch.

### 3. REVIEW

Show every file (envelope + prompt per task, plus the manifest for a batch). Let the user edit
anything. Confirm before committing.

### 4. COMMIT

Stage all envelopes + prompts + the manifest and commit them together — **one commit**, on the
**inbox branch** (default `dev`), then push:
`git add automation/tasks/ automation/prompts/ automation/batches/ && git commit && git push`.
Then remind the user:
- The dispatcher picks each task up at its `run_at` (dependencies permitting).
- Progress shows as `[[CHECKPOINT ...]]` markers; results land on each task branch +
  `automation/reports/<id>.md`, visible via `git pull`.
- When **all** tasks of a batch are done, the dispatcher merges their branches into `dev`
  automatically (topological order) — or flags the batch `merge-conflict` for a human.

## Hard rules

- **`id` must equal the envelope filename** (`tasks/<id>.json`).
- Envelope + prompt must be **committed to the inbox branch before `run_at`** — the dispatcher
  only sees what `git pull` brings.
- Gates are prose in the prompt. There is no `gate` field in the envelope.
- `automation/state/` is gitignored worker-local truth; `reports/` + `batches/` are the committed
  durable records.
- One branch per task (`automation/<slug>`); never schedule work onto `main`/`dev` directly.

## References

- `references/envelope-schema.md` — full field table: which script consumes what, the batch
  manifest schema, the state-file contract.
- `references/architecture.md` — two-layer design, topology, core invariants, the coding-agent
  router.
- `references/operations.md` — operating a live system: logs, tmux, stuck-task recovery, notify
  hooks.
