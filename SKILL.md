---
name: schedule-task
description: Author scheduled, resumable automation tasks from natural language — single tasks or dependency-ordered batches — for any repo that has the .schedule-tasks-data/ runtime. Use when the user wants to schedule autonomous coding-agent work to run later on a worker box. The author opens a dev batch (schedule-task dev), workers execute the full chain (dev → mutation → review → test → report) and MERGE their own work back to the dev branch, the author archives the batch (schedule-task archive). Trigger on "schedule a task", "run X autonomously tonight", "create a dev task", "initialize automation".
---

# schedule-task

Turn a natural-language request into one or more scheduled, **resumable** tasks the worker
watchdog runs unattended. Output = a routing **envelope** + a **harness prompt** per task (plus
a **batch manifest** when one requirement splits into several tasks), committed to the repo's
inbox branch (default `dev`) where the watchdogs pick them up. Never a one-liner prompt — a
single sentence is too weak to steer a multi-hour autonomous run.

**Roles are fixed and never blur.** The *author* box owns the lifecycle: it opens a dev batch,
drafts tasks (assigning each to a worker + branch + time), and closes the batch. A *worker* box
only executes: its always-on watchdog launches tasks whose envelope `.worker` matches its machine
id, the worker runs the **full chain** (dev → mutation check → self-review → testing → consolidated
report), and **merges its own finished work back to `dev`** — workers never merge anyone else's
work, and the author never merges at all.

Everything here is agent-neutral: tasks are executed by the coding agent CLI configured per task
(`"agent": "claude"` or `"kimi"`), and this skill itself works in any SKILL.md-compatible agent.

## The v3.3 lifecycle at a glance

```
 dev              archive
 ─────────────    ─────────
 author           author
 opens a batch    closes
 ─────────────    ─────────    the batch
 workers execute  (summary
 the full chain:  report +
 dev → mutation   archive/)
 → review → test
 → report → merge
```

- **One batch at a time.** The system runs a single current batch. `schedule-task dev` refuses
  to open a new batch while a batch is still open — close it with `schedule-task archive` first.
- **Workers run the full chain.** Each task covers: development → mutation check → self-review →
  testing → consolidated report → merge. The worker writes a full-chain report covering every
  stage's outcome, integrates the latest `dev`, merges its own branch, re-runs the gates, and
  pushes. The runner verifies the merge, stamps the report, and deletes the worktree + branch.
- **Merge failure is not a dead end.** If the executor cannot resolve a merge conflict it pushes
  its branch, writes the conflict into the report, and ends `merge-failed`. The author sees it in
  `status`, inspects the pushed branch, and re-dispatches a follow-up dev task.
- **Stage failure cancels the chain.** If any stage within a task fails fatally, the task is
  marked `failed` with the failure reason recorded. The branch is NOT merged. All tasks that
  depend on this task are automatically `cancelled`. The author sees the failure in `status`
  with the reason and stage.
- **The batch ends with archive.** `schedule-task archive` requires every member terminal,
  writes a batch summary report (outcomes + follow-ups), moves the manifest + envelopes +
  prompts to `archive/`, and empties the current batch.

## Prerequisite

Two steps install the system on a machine (see `docs/refactor-three-layer-separation.md` in the
repo for the design):

1. **Tool layer — the global CLI (one command):**

   ```
   curl -fsSL <raw install.sh URL> | bash
   ```

   (or `./install.sh` inside a clone). It does `npm install -g` from a self-contained tarball
   and puts the **`schedule-task`** command on PATH. This is the runtime: **invoke it as
   `schedule-task <subcommand>`** from any repo. One copy per machine — no code duplication,
   no version drift. Re-running it replaces the global CLI (that is how you update the tool).
2. **Knowledge layer — bind this skill into each agent:**

   ```
   schedule-task install --target all
   ```

   copies the **knowledge three — SKILL.md / references/ / templates/, zero code** — from the
   global CLI package into each installed agent's `skills/schedule-task` (`~/.kimi-code`,
   `~/.claude`, `~/.agents`). Whole-dir overwrite: re-running it refreshes the skill and
   automatically cleans any old-form code residue. A `.installed-from` marker records the
   source CLI version + time.
- **Data layer — per project.** `.schedule-tasks-data/` lives in each repo, created by
  `schedule-task init`, committed with git.

The repo you schedule work in must contain the runtime **data directory** `.schedule-tasks-data/`
(`{tasks,prompts,reports,batches,state,templates}/` + `hooks/notify.sh`). If it is missing in
the repo you're working in, run `schedule-task init` first (below) — it creates the data dirs,
the worker-local state configuration, and the committed data schema version
(`.schedule-tasks-data/version`).

**Updating later:** the developer improves the repo → pushes a release → every machine re-runs
the `curl -fsSL <raw install.sh URL> | bash` one-liner (replaces the global CLI) and
`schedule-task install --target all` (refreshes the bound skills — idempotent). There is **no
`update` subcommand**.
Data migration after an upgrade is per-project and AI-assisted: `status`/`doctor` warn when
`.schedule-tasks-data/version` is older than the CLI (`CLI vX · data schema vY`); write commands
(`run`/`cancel`/`archive`) **hard-stop** with a hint to run **`schedule-task migrate`**
first (commit first — rollback is a git revert).

## Sub-commands (one CLI, route on the first argument)

- **no argument / `status`** — read-only report of every scheduled task. Run `git fetch` first,
  then `schedule-task status` (from the repo) or `schedule-task status -r <repo>`, and relay its
  output verbatim (the version line, the batch-grouped table + the counts line). The CLI
  auto-detects the machine: on a *worker* it reads live `state/` flags + run logs; on the
  *author* box it infers state from the reports **merged to `dev`** (state/ is gitignored, so
  after a fetch the reporter reads `origin/<inbox>`; see `references/operations.md`). Do NOT
  author anything in this mode.
  (`... status --self-test` verifies the reporter itself.)

- **`dev`** — the gate to START a new dev batch. It refuses while a batch is still open
  (finish + `archive` it first). When it exits 0, it shows the available workers from the
  profile. Then run the create flow below: interview the user, select a worker, draft envelopes
  + prompts from `templates/dev-plan-harness.md` (which references `templates/harness-common.md`
  — both are copied into `.schedule-tasks-data/templates/`), review, commit to the inbox branch.
  Every task the executor completes is merged to `dev` by the executor itself — the prompt's
  merge protocol makes this a hard requirement.

- **`profile [list|add|edit|remove]`** — worker profile management. Workers are stored in
  `.schedule-tasks-data/workers.json` (committed). No args or `list` shows all workers with
  their per-stage models. Sub-commands:
  - `add <name> <agent>` — add a worker (`agent`: `kimi` or `cc`). Auto-assigns the next id (W01, W02…).
  - `edit <worker-id> <stage> <model>` — set a stage's model. Stages: `dev`, `review`,
    `mutation`, `test`.
  - `remove <worker-id>` — remove a worker.
  Shorthand: `profile W01 dev sonnet` edits worker W01's dev model to sonnet.

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
     `reports/`, `batches/`, `state/`, `templates/`, plus a no-op `hooks/notify.sh` as the
     per-project customization point. Non-interactive with `--role`/`--id`/`--yes` flags.
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
     schedule-task watchdog start --repo <repo>
     ```
     This spawns a resident daemon that checks for due tasks every 300 s (default; `--interval <s>`
     to change) and launches them as detached runners. No cron needed. Check/stop it with
     `schedule-task watchdog status | stop`; after a machine reboot, `start` again (or add it to
     the login startup). Remind the user: `.schedule-tasks-data/state/` stays local to the worker
     (gitignored); it is the worker-local truth and never crosses git.

- **`install [-t, --target <ids>] [-y, --yes]`** — bind the knowledge layer into an agent:
  copy SKILL.md / references/ / templates/ (zero code) from the global CLI package into each
  chosen platform's `skills/schedule-task` (`kimi-code` / `claude` / `agents`). Whole-dir
  overwrite — idempotent, and it cleans up old-form code residue automatically. With no flags
  it asks which platform(s); `--target all` / `--target auto` / `-y` (non-interactive) = every
  detected platform. There is **no `update` subcommand** — updating is re-running install.sh
  (a new install replaces the global CLI) plus this command again.

- **`archive [<batch-id>]`** — AUTHOR-side batch close-out (default: the current batch). Every
  member must be terminal. Writes a batch summary report
  (`.schedule-tasks-data/reports/<batch-id>.md` — per-member outcomes + a Follow-ups section),
  moves the manifest + member envelopes + prompts into `archive/`, commits and pushes. The
  current batch is then empty — a new batch may start.

- **`cancel <id> [reason...]`** / **`cancel --all [reason...]`** — stop one task or everything in
  flight. A **pending** task simply never launches again; a **running** one gets its process
  group killed (runner, limit-park `sleep`, and the coding-agent CLI child all die together — so
  cancel works even mid limit-wait). Cancelling **cascades**: active tasks whose `depends_on`
  chain includes the cancelled id are cancelled too (they could never become eligible). Terminal
  tasks (`done`/`merge-failed`/`failed`/`cancelled`) are refused.
  The task's worktree is left in place for inspection. No git mutations — cancel is worker-local
  state (`state/<id>` = `cancelled` + a notes line + notify hook). NOTE: this only works on the
  **worker** (needs live `state/` + the process); from the author box, ssh to the worker or ask
  the user to run it there.

- **`log <id> [-f]`** — tail a task's run log live (this is how you watch a running task now —
  the old `tmux attach` is gone). `-f` follows new lines.

- **`migrate`** — upgrade the committed data schema (`.schedule-tasks-data/version`) to this
  CLI's schema. Deterministic — the CLI only re-stamps the version; commit the current state
  first so rollback is a git revert. Run it when `status`/`doctor` show a stale data schema
  (`CLI vX · data schema vY`), or when a write command hard-stops with a migrate hint.

- **`watchdog start|stop|status`** — the resident watchdog, no cron needed. `start` spawns a daemon
  that checks for due tasks every 300 s (default; `--interval <s>` to change) and launches them
  as detached runners (capped by `FL_MAX_CONCURRENCY`, default 2). `stop` stops it; `status`
  shows whether it is alive and what the last check did. Only machines with `role=worker`
  launch anything. Run these on the worker box.

- **`doctor`** — environment health check: node/git/claude/kimi/graphify presence, the global
  CLI package completeness (bin + src + SKILL.md + references/ + templates/), each bound skill
  dir (knowledge three present, no code residue — an old-form copy containing bin/src is
  flagged with a hint to re-run `install`), the runtime CLI (a `schedule-task` on PATH that is
  the npm global install, and whether its version matches the CLI package), `~/.local/bin`
  symlink leftovers (advises removal by hand, never deletes), machine identity, data-dir
  completeness, and the data schema version (`CLI vX · data schema vY`).

- **`version`** — print the CLI version (from `package.json` next to this CLI). Handy for
  telling installs apart and for the version line in `status`/`doctor`
  (`CLI vX · data schema vY`).

- **anything else** → try the create flow guidance for `dev`, or `help`/`--help` for the
  command list.

## Flow: DEV  (author) — DISCUSS → DRAFT → REVIEW → COMMIT  (create one *or many* tasks)

Start with `schedule-task dev` (it gates the current batch). Then:

### 1. DISCUSS  (interview — do NOT skip)

First establish the shape: **single task or batch?** One requirement can map to N tasks that share
a batch id. For a batch, agree the **dependency graph** explicitly: which tasks run in parallel,
which must wait on which (`depends_on`). Interview each task's specifics separately, but share
what's common (guardrails, branch rules) so you don't re-ask.

Ask, one at a time, only what you cannot infer from the repo/context:
- Mission / outcome.
- An existing plan/spec doc to reference?
- **Acceptance gates in plain language** (e.g. "the test suite passes", "browser smoke is clean").
  NEVER hard-code project-specific commands like `npm test` / `pytest` — the executor discovers
  the right command for the repo. Keeping gates as prose is what makes the system polyglot.
- **Schedule**: `run_at` (ISO-8601 UTC) for a one-shot. (Recurring cron schedules are not
  supported.)
- **Which worker executes it**: read the workers profile (`schedule-task profile`) and present
  the numbered list to the user for selection (e.g. `W01 kimi-130 (kimi)`, `W02 cc-opus (cc)`).
  The selected worker's agent + per-stage models are written into the envelope — the author
  cannot override individual stage models. For a batch split across machines, agree who runs
  which tasks. Default (no `worker` field) = any worker may take it.
- Guardrails / invariants (branch rules, architecture constraints, "never touch main").
- What **"done"** looks like, and how to behave **on resume** after an interruption.

### 2. DRAFT

- **id convention (unified for batches and tasks):** `<B|T><YYMMDD>-<seq>-<tag>` — prefix `B` for
  the batch, `T` for a task; `YYMMDD` year+date; `seq` a **two-digit** counter (`01`, `02`, … —
  batches: the day's batch number; tasks: the position within the batch, matching dependency
  order); `tag` the topic. Examples: batch `B260805-01-combat-improvement`; tasks
  `T260805-01-formation`, `T260805-02-combat`, `T260805-03-retreat`. A task belongs to its batch
  via the envelope's `batch` field (the full batch id), never inferred from the id prefix. Check
  collisions against `.schedule-tasks-data/tasks/*.json` — and against the other ids you're
  minting this pass.
- Ensure `templates/` are present in `.schedule-tasks-data/templates/` (run
  `schedule-task init` or copy by hand) — the harness prompts reference
  `harness-common.md` from there.
- Write `.schedule-tasks-data/prompts/<id>.md` from `templates/dev-plan-harness.md` (next to
  this SKILL.md), filling **every** `<...>` slot and the `$id` markers. The harness contains the
  **development report** and **merge protocol** requirements — keep them verbatim.
- Write `.schedule-tasks-data/tasks/<id>.json` — the envelope only:
  ```json
  {
    "id": "T260805-03-retreat",
    "batch": "B260805-01-combat-improvement",
    "type": "dev",
    "worker": "W01",
    "branch": "automation/T260805-03-retreat",
    "prompt_file": ".schedule-tasks-data/prompts/T260805-03-retreat.md",
    "schedule": { "run_at": "2026-08-05T02:00:00Z" },
    "depends_on": ["T260805-01-formation", "T260805-02-combat"],
    "agent": "kimi",
    "model": "K3"
  }
  ```
  Field notes:
  - **`worker`** — the worker profile id (e.g. `W01`). The watchdog matches this against its
    `.machine` id. The profile's `agent` and per-stage `models` are resolved at dispatch time
    and written into the envelope. **Absent `worker` = any worker may take it.**
  - **Branch convention: one branch per task**, `automation/<id>`. The runner cuts it from the
    inbox branch on the worker. It is an isolated workspace only — after a successful merge it is
    deleted; on failure it is pushed for the author.
  - `batch`, `worker`, `depends_on`, `agent`, `model` are optional: a task without them is a
    single-task batch with no dependencies, runnable by any worker, on the default agent.
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
  `tasks` lists ids in dependency order. The manifest is committed — it is the author-side
  durable record of the batch, and the basis for `archive` (the current batch = the
  newest non-archived manifest).

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
- Each finished task is **merged to `dev` by its executor** with a full-chain report —
  progress shows as `[[CHECKPOINT ...]]` markers; the merged result + report land on `dev`.
- When all tasks are `done`, close the batch: `schedule-task archive`.

## Flow: ARCHIVE  (author) — closes the current batch

- `schedule-task archive` — every member must be terminal
  (`done`/`merge-failed`/`failed`/`cancelled`). It writes the
  batch summary report (outcomes + Follow-ups), archives the manifest + envelopes + prompts,
  pushes, and empties the current batch. The author's agent may fill the Follow-ups section
  with suggestions before/after the report lands.
- A new dev batch can then be opened (`schedule-task dev`).

## Task states (v3.3)

- Task: `pending → running → done | merge-failed | failed | cancelled`
  - `done` — full chain passed AND the executor merged its branch to `dev` (runner-verified).
  - `merge-failed` — code complete but the merge did not land; branch pushed for the author.
  - `failed` — a stage failed fatally or the runner could not complete; branch pushed for the author.
  - `cancelled` — cancelled by the author, or cascade-cancelled because a dependency failed.
- Back-compat: the v1–v2 words `dev-done` / `audit-pass` / `audit-fail` are normalised via
  aliases (`dev-done` → `done`, `audit-pass` → `done`, `audit-fail` → `failed`).

## Hard rules

- **`id` must equal the envelope filename** (`.schedule-tasks-data/tasks/<id>.json`); ids follow
  `<B|T><YYMMDD>-<seq>-<tag>`.
- Envelope + prompt must be **committed to the inbox branch before `run_at`** — the watchdog
  only sees what `git pull` brings.
- Gates are prose in the prompt. There is no `gate` field in the envelope.
- **A task runs only on its `worker`** (envelope `.worker` matches the worker profile id, which
  maps to the `.machine` id); a machine that did not declare `role=worker` never launches anything.
- **The executor runs the full chain and merges its own work to `dev`**; workers never touch
  anyone else's work, and the author never merges. Merge conflict resolution is part of the job,
  never a punt — an unresolvable conflict becomes `merge-failed` + a pushed branch.
- **Stage failure cancels dependents.** If a task fails, all tasks depending on it are
  cascade-cancelled. No retry loops.
- **One batch at a time**: `dev` refuses to open a new batch while one is open; `archive` is
  what closes it.
- **Worker profile is committed** (`.schedule-tasks-data/workers.json`) — the author reads it to
  select workers during dispatch. The agent + per-stage models from the profile are locked into
  the envelope at dispatch time.
- `.schedule-tasks-data/state/` is gitignored worker-local truth (incl. `.machine`); `reports/`
  + `batches/` + `templates/` + `workers.json` are the committed durable records.
- One branch per task (`automation/<id>`), disposable; never schedule work onto `main`/`dev`
  directly.

## Runtime dependencies

- **node ≥ 18** + **git** are the only hard requirements. The CLI is a zero-dependency Node
  program: no jq (JSON.parse), no GNU date (Date), no tmux (detached process groups), no flock
  (pid lock files). `claude`/`kimi` are needed on the worker. `schedule-task doctor` checks all
  of this.
- **graphify (optional)** — knowledge-graph queries for executors (`graphify query` /
  `graphify update`), ~8x cheaper than reading source files. `init`/`doctor` only **detect** the
  `graphify` binary: present → executors can save tokens; absent → a warning prints the install
  command (`uv tool install graphifyy`) — the skill never installs it itself. The harness
  templates tell executors to refresh and query it when present. Install rules (binary + the
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
