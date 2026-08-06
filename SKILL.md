---
name: schedule-task
description: Author scheduled, resumable automation tasks (dev/test/audit) from natural language — single tasks or dependency-ordered batches — for any repo that has the automation/ runtime. Use when the user wants to schedule autonomous coding-agent work to run later on a worker box — it creates the routing envelope (automation/tasks/<id>.json), a plan-harness prompt (automation/prompts/<id>.md), and for multi-task batches a manifest (automation/batches/<batch>.json), assigns each task to a specific worker (envelope `worker` = the machine id configured at init), then commits them to the inbox branch for the worker dispatcher. Workers only execute; the author merges finished results (merge-batch). Trigger on "schedule a task", "run X autonomously tonight", "create an automation task", "initialize automation".
---

# schedule-task

Turn a natural-language request into one or more scheduled, **resumable** tasks the worker
dispatcher runs unattended. Output = a routing **envelope** + a **plan-harness prompt** per task
(plus a **batch manifest** when one requirement splits into several tasks), committed to the
repo's inbox branch (default `dev`) where the dispatchers pick them up. Never a one-liner prompt
— a single sentence is too weak to steer a multi-hour autonomous run.

**Roles are fixed and never blur.** The *author* box owns the whole lifecycle: it initializes the
repo, drafts tasks (assigning each to a worker + branch + time), and — when all workers are done
— merges the results (automation/merge-batch.sh, PR optional). A *worker* box only executes: its
cron dispatcher launches tasks whose envelope `.worker` matches its machine id, and pushes results
back on per-task branches. **Workers never merge.**

Everything here is agent-neutral: the tasks are executed by the coding agent CLI configured per
task (`"agent": "claude"` or `"kimi"`), and this skill itself works in any SKILL.md-compatible
agent.

## Prerequisite

The current repo must contain the automation **data directories**:
`automation/{tasks,prompts,reports,batches,state}/` and optionally `automation/hooks/notify.sh`.
The executable scripts live in the user-level skill installation (e.g.
`~/.agents/skills/schedule-task/automation/`) and accept the repo path as the first argument.
If `automation/tasks/` is missing in the repo you're working in, run the **`init`** sub-command
first (below) — it creates the data directories and the worker-local state configuration.

## Sub-commands (route on the first argument)

- **`status`** — read-only report of every scheduled task. Run `git fetch` first, then
  `bash <skill>/automation/status.sh <repo>` (or `bash automation/status.sh` when the scripts are
  copied into the project) and relay its output verbatim (the batch-grouped table + the counts
  line). The script auto-detects the machine: on a *worker* it reads live `state/` flags + run
  logs; on the *author* box it infers state from each task branch's committed
  `automation/reports/<id>.md` (state/ is gitignored, so after a fetch the reporter reads the
  report on `origin/<branch>`; see `references/operations.md`). Do NOT author anything in this
  mode. (`bash automation/status.sh --self-test` verifies the reporter itself.)

- **`init`** — install the runtime into the current repo (the repo root, not a subdirectory)
  **and declare this machine's role**:
  1. **Ask what this machine is**: role `author` or `worker`, and its machine id (default
     `hostname`; the id is what envelope `.worker` values are matched against — pick something
     stable like `vps-01`). Write `automation/state/.machine` (gitignored, never committed):
     ```
     role=worker
     id=vps-01
     ```
     Every machine that runs the runtime gets one: the author box (role `author`), and each
     worker box (role `worker`). dispatch.sh refuses to launch anything unless `role=worker`, so
     an author box can never compete with a worker.
  2. Create only the **data directories** in `<repo>/automation/`: `tasks/`, `prompts/`,
     `reports/`, `batches/`, and `state/`. Also add a no-op `hooks/notify.sh` so users have a
     per-project customization point. The executable scripts (`dispatch.sh`, `run-task.sh`,
     `coding-agent.sh`, `archive-task.sh`, `cancel-task.sh`, `merge-batch.sh`, `status.sh`)
     are **not copied** — they live in the user-level skill installation and are invoked with
     the repo path as the first argument.
  3. **Re-init / migration**: if `<repo>/automation/` already contains the old executable
     scripts, ask the user whether to remove them. Keep `tasks/`, `prompts/`, `reports/`,
     `batches/`, `state/`, and `hooks/notify.sh`. Do not remove anything without confirmation.
  4. Merge `automation/gitignore.snippet` into the repo's `.gitignore` — append only the lines
     that are missing (currently just `automation/state/`).
  5. Check dependencies on PATH: `jq`, `tmux`, `git`, and at least one of `claude` / `kimi`.
     Report what's missing; don't fail hard — the deps matter on the *worker*, not necessarily
     on the author's machine.
  6. Only for a `worker` role, print the exact cron line for that worker box. Replace `<repo>`
     with the absolute path of the repo **on the worker**, `<skill>` with the skill installation
     path (e.g. `~/.agents/skills/schedule-task`), and `<lock>` with the repo's basename
     (e.g. `red-flow`). The flock name is scoped per project so several projects' dispatchers
     on one machine never serialize each other:
     ```
     */5 * * * * flock -n /tmp/<lock>-dispatch.lock bash <skill>/automation/dispatch.sh <repo> >> <repo>/automation/dispatch.log 2>&1
     ```
     Remind the user: `automation/state/` stays local to the worker (gitignored); it is the
     worker-local truth and never crosses git.

- **`update`** — update the skill installation itself. Run in the skill source directory
  (e.g. `~/agent-skills/schedule-task`): `bash install.sh --update`. This pulls the latest
  source from GitHub and ensures the user-level symlinks
  (`~/.agents/skills/schedule-task`, `~/.claude/skills/schedule-task`,
  `~/.kimi-code/skills/schedule-task`) still point to it. Existing correct symlinks are left
  alone; broken or stale symlinks are replaced. Use `--dry-run` to preview.

- **`archive`** — retire finished tasks: run `bash <skill>/automation/archive-task.sh <repo> <id>`
  per task (or once per task of a finished batch). It moves the envelope + prompt pair into
  `automation/{tasks,prompts}/archive/` — kept in git as a faithful record — and **refuses any
  task whose state is not `done` or `cancelled`**. Reports in `automation/reports/` are never
  moved.

- **`cancel`** — stop one task or everything in flight:
  `bash <skill>/automation/cancel-task.sh <repo> <id> [reason...]` or
  `bash <skill>/automation/cancel-task.sh <repo> --all [reason...]`. A **pending** task simply
  never dispatches again; a **running** one gets its tmux session killed (runner, limit-park
  `sleep`, and the coding-agent CLI child all die with the pane — so cancel works even mid
  limit-wait). Cancelling **cascades**: active tasks whose `depends_on` chain includes the
  cancelled id are cancelled too (they could never become eligible). Terminal tasks
  (`done`/`failed`/`cancelled`) are refused. The task's worktree is left in place for
  inspection. No git mutations — cancel is worker-local state (`state/<id>` = `cancelled` +
  a notes line + notify hook). Batch interplay: cancelling never triggers a merge — batch
  finalization is the author's `merge-batch.sh`, which lands every task branch whose report says
  `(done)` and skips the rest (cancelled tasks have no done report → their branches are never
  merged).
  NOTE: this only works on the **worker** (needs live `state/` + tmux); from the author box,
  ssh to the worker or ask the user to run it there.

- **`merge-batch <batch-id>`** — AUTHOR-side batch finalization. Run on the author box when every
  task in the batch has finished: `bash <skill>/automation/merge-batch.sh <repo> <batch-id>`.
  It fetches
  `origin`, checks each task's committed report on its branch (`(done)` = merge it, anything else
  = skip and report), lands the done branches onto the manifest's `merge_target` (default `dev`)
  in manifest (dependency) order, and pushes. On a conflict it aborts and exits non-zero —
  resolve by hand, then re-run (idempotent). The author is the ONLY merger in the system:
  workers never merge. Optional PR: if the repo is on GitHub/GitLab and the user wants review
  instead of a direct push, run the merge locally, then `git push` the topic branch of the
  combined result and open a PR via `gh` — the skill must NOT invent a PR workflow beyond that.

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
- **Which worker executes it**: the machine id configured at `init` (e.g. `vps-01`). For a batch
  split across machines, agree who runs which tasks. Default (no `worker` field) = any worker may
  take it.
- Guardrails / invariants (branch rules, architecture constraints, "never touch main").
- What **"done"** looks like, and how to behave **on resume** after an interruption.
- Which executor: `agent` = `claude` (default) or `kimi`, and optionally a `model` alias.

### 2. DRAFT

- **id convention (unified for batches and tasks):** `<B|T><YYMMDD>-<seq>-<tag>` — prefix `B` for
  the batch, `T` for a task; `YYMMDD` year+date; `seq` a **two-digit** counter (`01`, `02`, … —
  batches: the day's batch number; tasks: the position within the batch, matching dependency
  order); `tag` the topic. Examples: batch `B260805-01-combat-improvement`; tasks
  `T260805-01-formation`, `T260805-02-combat`, `T260805-03-retreat`. The same day can carry
  `B260805-01-…`, `B260805-02-…`, etc. A task belongs to its batch via the envelope's `batch`
  field (the full batch id), never inferred from the id prefix. Check collisions against
  `automation/tasks/*.json` — and against the other ids you're minting this pass.
- Write `automation/prompts/<id>.md` from `templates/plan-harness.md` (next to this SKILL.md),
  filling **every** `<...>` slot and the `$id` markers.
- Write `automation/tasks/<id>.json` — the envelope only:
  ```json
  {
    "id": "T260805-03-retreat",
    "batch": "B260805-01-combat-improvement",
    "type": "dev",
    "worker": "vps-01",
    "branch": "automation/T260805-03-retreat",
    "prompt_file": "automation/prompts/T260805-03-retreat.md",
    "schedule": { "run_at": "2026-08-05T02:00:00Z" },
    "depends_on": ["T260805-01-formation", "T260805-02-combat"],
    "agent": "claude",
    "model": "opus"
  }
  ```
  Field notes:
  - **`worker`** — which machine executes this task: the machine id configured at `init`
    (`.machine` file, default hostname). dispatch.sh only launches tasks whose `worker` equals
    its own id. **Absent `worker` = any worker may take it** (single-worker setups can ignore
    it entirely). A batch may split its tasks across several workers — each runs its own
    branches in parallel; merging is always the author's job.
  - **Branch convention: one branch per task**, `automation/<id>`. The runner cuts it from the
    inbox branch on the worker. The old shared `automation/dev` convention is dead — do not use it.
  - `batch`, `worker`, `depends_on`, `agent`, `model` are optional: a task without them is a
    single-task batch with no dependencies, runnable by any worker, on the default agent (`claude`).
  - **No `gate` field** — gates live in the prompt as prose.
- **Batch manifest** — only when the pass authors more than one task:
  `automation/batches/<batch>.json`:
  ```json
  {
    "id": "B260805-01-combat-improvement",
    "title": "combat improvement — formation, combat, retreat",
    "notes": "formation must land before combat touches the same config",
    "tasks": ["T260805-01-formation", "T260805-02-combat", "T260805-03-retreat"],
    "merge_target": "dev"
  }
  ```
  `tasks` lists ids in dependency order — the author's merge-batch lands the branches in exactly
  this order. The manifest is committed — it is the author-side durable record of the batch.

### 3. REVIEW

Show every file (envelope + prompt per task, plus the manifest for a batch). Let the user edit
anything. Confirm before committing.

### 4. COMMIT

Stage all envelopes + prompts + the manifest and commit them together — **one commit**, on the
**inbox branch** (default `dev`), then push:
`git add automation/tasks/ automation/prompts/ automation/batches/ && git commit && git push`.
Then remind the user:
- Each worker's dispatcher picks up the tasks assigned to it (`worker` = its machine id) at
  `run_at` (dependencies permitting); unassigned tasks go to whichever worker pulls first.
- Progress shows as `[[CHECKPOINT ...]]` markers; results land on each task branch +
  `automation/reports/<id>.md` — visible via `git fetch` + status.
- When **all** tasks of a batch are done, the **author** lands the batch:
  `bash <skill>/automation/merge-batch.sh <repo> <batch-id>` (or `bash automation/merge-batch.sh <batch-id>`
  when scripts are copied into the project). PR optional — workers never merge.

## Hard rules

- **`id` must equal the envelope filename** (`tasks/<id>.json`); ids follow
  `<B|T><YYMMDD>-<seq>-<tag>`.
- Envelope + prompt must be **committed to the inbox branch before `run_at`** — the dispatcher
  only sees what `git pull` brings.
- Gates are prose in the prompt. There is no `gate` field in the envelope.
- **A task runs only on its `worker`** (envelope `.worker` = machine id from `state/.machine`);
  a machine that did not declare `role=worker` never dispatches.
- **Workers never merge. The author is the only merger** (`automation/merge-batch.sh`).
- `automation/state/` is gitignored worker-local truth (incl. `.machine`); `reports/` +
  `batches/` are the committed durable records.
- One branch per task (`automation/<id>`); never schedule work onto `main`/`dev` directly.

## References

- `references/envelope-schema.md` — full field table: which script consumes what, the batch
  manifest schema, the state-file contract.
- `references/architecture.md` — two-layer design, topology, core invariants, the coding-agent
  router.
- `references/operations.md` — operating a live system: logs, tmux, stuck-task recovery, notify
  hooks.
