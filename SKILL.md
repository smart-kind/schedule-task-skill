---
name: schedule-task
description: Author scheduled, resumable automation tasks (dev/test/audit) from natural language — single tasks or dependency-ordered batches — for any repo that has the .schedule-tasks-data/ runtime. Use when the user wants to schedule autonomous coding-agent work to run later on a worker box — it creates the routing envelope (.schedule-tasks-data/tasks/<id>.json), a plan-harness prompt (.schedule-tasks-data/prompts/<id>.md), and for multi-task batches a manifest (.schedule-tasks-data/batches/<batch>.json), assigns each task to a specific worker (envelope `worker` = the machine id configured at init), then commits them to the inbox branch for the worker watchdog. Workers only execute; the author merges finished results (merge-batch). Trigger on "schedule a task", "run X autonomously tonight", "create an automation task", "initialize automation".
---

# schedule-task

Turn a natural-language request into one or more scheduled, **resumable** tasks the worker
watchdog runs unattended. Output = a routing **envelope** + a **plan-harness prompt** per task
(plus a **batch manifest** when one requirement splits into several tasks), committed to the
repo's inbox branch (default `dev`) where the watchdogs pick them up. Never a one-liner prompt
— a single sentence is too weak to steer a multi-hour autonomous run.

**Roles are fixed and never blur.** The *author* box owns the whole lifecycle: it initializes the
repo, drafts tasks (assigning each to a worker + branch + time), and — when all workers are done
— merges the results (`node <skill-dir>/bin/schedule-task.js merge-batch <batch>`, PR optional). A *worker* box only
executes: its always-on watchdog launches tasks whose envelope `.worker` matches its machine id, and
pushes results back on per-task branches. **Workers never merge.**

Everything here is agent-neutral: the tasks are executed by the coding agent CLI configured per
task (`"agent": "claude"` or `"kimi"`), and this skill itself works in any SKILL.md-compatible
agent.

## Prerequisite

Install the runtime once per machine: run `./install.sh` in the skill source
directory, or simply copy this skill directory into an agent's skills dir
(`~/.agents`, `~/.claude`, `~/.kimi-code`) — plain copies, no symlinks, and
**no global install** (`npm install -g` is gone). The runtime is the
**`schedule-task` CLI** — one Node binary, no other dependencies (the
bash/jq/tmux era is gone). In this self-contained install the CLI lives
**inside the skill copy** at `bin/schedule-task.js`; invoke it as
`node <skill-dir>/bin/schedule-task.js <subcommand>`, where `<skill-dir>` is
the directory that contains this SKILL.md (the agent already knows it — it is
the directory this skill was loaded from).

The repo you schedule work in must contain the runtime **data directory** `.schedule-tasks-data/`
(`{tasks,prompts,reports,batches,state}/` + `hooks/notify.sh`). If it is missing in the repo
you're working in, run `node <skill-dir>/bin/schedule-task.js init` first (below) — it creates
the data dirs and the worker-local state configuration.

## Sub-commands (one CLI, route on the first argument)

- **`status`** — read-only report of every scheduled task. Run `git fetch` first, then
  `node <skill-dir>/bin/schedule-task.js status` (from the repo) or
  `node <skill-dir>/bin/schedule-task.js status -r <repo>`, and relay its
  output verbatim (the batch-grouped table + the counts line). The CLI auto-detects the machine:
  on a *worker* it reads live `state/` flags + run logs; on the *author* box it infers state from
  each task branch's committed `.schedule-tasks-data/reports/<id>.md` (state/ is gitignored, so
  after a fetch the reporter reads the report on `origin/<branch>`; see
  `references/operations.md`). Do NOT author anything in this mode.
  (`node <skill-dir>/bin/schedule-task.js status --self-test` verifies the reporter itself.)

- **`init`** — install the runtime into the current repo (the repo root, not a subdirectory)
  **and declare this machine's role**:
  1. **Ask what this machine is**: role `author` or `worker`, and its machine id (default
     `hostname`; the id is what envelope `.worker` values are matched against — pick something
     stable like `vps-01`). Write `.schedule-tasks-data/state/.machine` (gitignored, never
     committed):
     ```
     role=worker
     id=vps-01
     ```
     Every machine that runs the runtime gets one: the author box (role `author`), and each
     worker box (role `worker`). The watchdog refuses to launch anything unless `role=worker`, so
     an author box can never compete with a worker.
  2. Create the data directories in `<repo>/.schedule-tasks-data/`: `tasks/`, `prompts/`,
     `reports/`, `batches/`, `state/`, plus a no-op `hooks/notify.sh` as the per-project
     customization point. Non-interactive with `--role`/`--id`/`--yes` flags.
  3. **Re-init / migration**: if `<repo>/automation/` still exists (the old bash-era data dir),
     `init` asks whether to migrate it — move `{tasks,prompts,reports,batches,state,hooks}` into
     `.schedule-tasks-data/`, rewrite each envelope's `prompt_file` from `automation/…` to
     `.schedule-tasks-data/…`, and remove the old runtime scripts if any were copied in. Nothing
     is removed without confirmation.
  4. Merge `.schedule-tasks-data/state/` into the repo's `.gitignore` — append only the lines
     that are missing.
  5. Check dependencies on PATH: `node` (running), `git`, and at least one of `claude` / `kimi`.
     Report what's missing; don't fail hard — the deps matter on the *worker*, not necessarily
     on the author's machine. Also checks `graphify` (optional — knowledge-graph queries for
     executors; install once per machine with `uv tool install graphifyy`, see
     `references/graphify.md`).
  6. Only for a `worker` role, print the exact watchdog command for that worker box. Replace
     `<repo>` with the absolute path of the repo **on the worker**:
     ```
     node <skill-dir>/bin/schedule-task.js watchdog start --repo <repo>
     ```
     This spawns a resident daemon that checks for due tasks every 300 s (default; `--interval <s>`
     to change) and launches them as detached runners. No cron needed. Check/stop it with
     `node <skill-dir>/bin/schedule-task.js watchdog status | stop`; after a machine reboot, `start` again (or add it to
     the login startup). Remind the user: `.schedule-tasks-data/state/` stays local to the worker
     (gitignored); it is the worker-local truth and never crosses git.

- **`update`** — refresh this skill installation to the latest source, right from the copy:
  it pulls the source recorded in `.installed-from` (or clones the repo when there is no
  recorded source) and re-runs `install.sh --update` to re-copy every platform's skill dir on
  this machine. It does **not** remove old-scheme leftovers (npm global `schedule-task`,
  `~/.local/bin` symlink) — clean those up by hand.

- **`archive <id>`** — retire finished tasks: moves the envelope + prompt pair into
  `.schedule-tasks-data/{tasks,prompts}/archive/` — kept in git as a faithful record — and
  **refuses any task whose state is not `done` or `cancelled`**. Reports in
  `.schedule-tasks-data/reports/` are never moved.

- **`cancel <id> [reason...]`** / **`cancel --all [reason...]`** — stop one task or everything in
  flight. A **pending** task simply never launches again; a **running** one gets its process
  group killed (runner, limit-park `sleep`, and the coding-agent CLI child all die together — so
  cancel works even mid limit-wait). Cancelling **cascades**: active tasks whose `depends_on`
  chain includes the cancelled id are cancelled too (they could never become eligible). Terminal
  tasks (`done`/`failed`/`cancelled`) are refused. The task's worktree is left in place for
  inspection. No git mutations — cancel is worker-local state (`state/<id>` = `cancelled` + a
  notes line + notify hook). Batch interplay: cancelling never triggers a merge — batch
  finalization is the author's `merge-batch`, which lands every task branch whose report says
  `(done)` and skips the rest. NOTE: this only works on the **worker** (needs live `state/` +
  the process); from the author box, ssh to the worker or ask the user to run it there.

- **`merge-batch <batch-id>`** — AUTHOR-side batch finalization. Run on the author box when every
  task in the batch has finished: `node <skill-dir>/bin/schedule-task.js merge-batch <batch-id>` (from the repo, or with
  `-r <repo>`). It fetches `origin`, checks each task's committed report on its branch (`(done)`
  = merge it, anything else = skip and report), lands the done branches onto the manifest's
  `merge_target` (default `dev`) in manifest (dependency) order, and pushes. On a conflict it
  aborts and exits non-zero — resolve by hand, then re-run (idempotent). The author is the ONLY
  merger in the system: workers never merge. Optional PR: if the repo is on GitHub/GitLab and the
  user wants review instead of a direct push, run the merge locally, then `git push` the topic
  branch of the combined result and open a PR via `gh` — the skill must NOT invent a PR workflow
  beyond that.

- **`log <id> [-f]`** — tail a task's run log live (this is how you watch a running task now —
  the old `tmux attach` is gone). `-f` follows new lines.

- **`watchdog start|stop|status`** — the resident watchdog, no cron needed. `start` spawns a daemon
  that checks for due tasks every 300 s (default; `--interval <s>` to change) and launches them
  as detached runners (capped by `FL_MAX_CONCURRENCY`, default 2). `stop` stops it; `status`
  shows whether it is alive and what the last check did. Only machines with `role=worker`
  launch anything; the watchdog NEVER merges. Run these on the worker box.

- **`doctor`** — environment health check: node/git/claude/kimi/graphify presence, skill-copy
  completeness (bin/ and src/ present), old-scheme leftover detection (a `schedule-task` on
  PATH that is not this skill's own copy — npm global or `~/.local/bin` symlink; advises
  removal by hand, never deletes), machine identity, data-dir completeness.

- **`version`** — print this skill copy's version (from `package.json` next to this CLI).
  Run it from each installed copy to tell which version it is — handy when several copies
  or old leftovers exist on a machine.

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
  `.schedule-tasks-data/tasks/*.json` — and against the other ids you're minting this pass.
- Write `.schedule-tasks-data/prompts/<id>.md` from `templates/plan-harness.md` (next to this
  SKILL.md), filling **every** `<...>` slot and the `$id` markers.
- Write `.schedule-tasks-data/tasks/<id>.json` — the envelope only:
  ```json
  {
    "id": "T260805-03-retreat",
    "batch": "B260805-01-combat-improvement",
    "type": "dev",
    "worker": "vps-01",
    "branch": "automation/T260805-03-retreat",
    "prompt_file": ".schedule-tasks-data/prompts/T260805-03-retreat.md",
    "schedule": { "run_at": "2026-08-05T02:00:00Z" },
    "depends_on": ["T260805-01-formation", "T260805-02-combat"],
    "agent": "claude",
    "model": "opus"
  }
  ```
  Field notes:
  - **`worker`** — which machine executes this task: the machine id configured at `init`
    (`.machine` file, default hostname). The watchdog only launches tasks whose `worker` equals its
    own id. **Absent `worker` = any worker may take it** (single-worker setups can ignore it
    entirely). A batch may split its tasks across several workers — each runs its own branches in
    parallel; merging is always the author's job.
  - **Branch convention: one branch per task**, `automation/<id>`. The runner cuts it from the
    inbox branch on the worker. (The branch prefix `automation/` is kept as-is for continuity
    with in-flight tasks; it has nothing to do with the data dir name.)
  - `batch`, `worker`, `depends_on`, `agent`, `model` are optional: a task without them is a
    single-task batch with no dependencies, runnable by any worker, on the default agent (`claude`).
  - **No `gate` field** — gates live in the prompt as prose.
- **Batch manifest** — only when the pass authors more than one task:
  `.schedule-tasks-data/batches/<batch>.json`:
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
`git add .schedule-tasks-data/tasks/ .schedule-tasks-data/prompts/ .schedule-tasks-data/batches/ && git commit && git push`.
Then remind the user:
- Each worker's watchdog picks up the tasks assigned to it (`worker` = its machine id) at
  `run_at` (dependencies permitting); unassigned tasks go to whichever worker pulls first.
- Progress shows as `[[CHECKPOINT ...]]` markers; results land on each task branch +
  `.schedule-tasks-data/reports/<id>.md` — visible via `git fetch` + `node <skill-dir>/bin/schedule-task.js status`.
- When **all** tasks of a batch are done, the **author** lands the batch:
  `node <skill-dir>/bin/schedule-task.js merge-batch <batch-id>` (PR optional) — workers never merge.

## Hard rules

- **`id` must equal the envelope filename** (`.schedule-tasks-data/tasks/<id>.json`); ids follow
  `<B|T><YYMMDD>-<seq>-<tag>`.
- Envelope + prompt must be **committed to the inbox branch before `run_at`** — the watchdog
  only sees what `git pull` brings.
- Gates are prose in the prompt. There is no `gate` field in the envelope.
- **A task runs only on its `worker`** (envelope `.worker` = machine id from `state/.machine`);
  a machine that did not declare `role=worker` never launches anything.
- **Workers never merge. The author is the only merger** (`node <skill-dir>/bin/schedule-task.js merge-batch`).
- `.schedule-tasks-data/state/` is gitignored worker-local truth (incl. `.machine`); `reports/`
  + `batches/` are the committed durable records.
- One branch per task (`automation/<id>`); never schedule work onto `main`/`dev` directly.

## Runtime dependencies

- **node ≥ 18** + **git** are the only hard requirements. The CLI is a zero-dependency Node
  program: no jq (JSON.parse), no GNU date (Date), no tmux (detached process groups), no flock
  (pid lock files). `claude`/`kimi` are needed on the worker. `node <skill-dir>/bin/schedule-task.js doctor` checks all
  of this.
- **graphify (optional)** — knowledge-graph queries for executors (`graphify query` /
  `graphify update`), ~8x cheaper than reading source files. `init`/`doctor` only **detect** the
  `graphify` binary: present → executors can save tokens; absent → a warning prints the install
  command (`uv tool install graphifyy`) — the skill never installs it itself. The plan-harness
  template tells executors to refresh and query it when present. Install rules (binary + the
  Kimi Code skill copy) and the `graphify-out/` commit policy: `references/graphify.md`.
- Executor CLIs (`claude` / `kimi`) can be pinned with `CLAUDE_BIN` / `KIMI_BIN`; the tuning
  seams `LIMIT_MARGIN`, `LIMIT_FALLBACK`, `MAX_AMBIGUOUS`, `AMBIGUOUS_SLEEP`,
  `AMBIGUOUS_FRESH_AT`, `FL_MAX_CONCURRENCY`, `FL_INBOX` are all environment variables.

## References

- `references/envelope-schema.md` — full field table: which command consumes what, the batch
  manifest schema, the state-file contract.
- `references/architecture.md` — two-layer design, topology, core invariants, the coding-agent
  router (agents.js).
- `references/operations.md` — operating a live system: logs, watching with `log -f`,
  stuck-task recovery, notify hooks.
- `references/graphify.md` — the optional knowledge-graph integration: detect-only behavior,
  install command (binary + the Kimi Code skill copy), refresh-before-work convention,
  `graphify-out/` commit policy.
