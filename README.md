# schedule-task

A SKILL.md-compatible skill that any coding agent CLI (Kimi Code, Claude Code, Codex) can load to
author **scheduled, resumable automation tasks** — dev / test / audit — that a deterministic
watchdog executes unattended on a worker box (e.g. a VPS). You describe the work in natural
language from any repo; the skill produces a routing envelope + a plan-harness prompt (plus a
batch manifest for multi-task requests), commits them to the repo's inbox branch, and the worker
picks them up at the scheduled time, survives usage-limit windows, and pushes back results.
Authoring is agent-neutral (any SKILL.md-compatible agent); execution is not — the worker runs
tasks through the `claude` or `kimi` executor CLIs only (see `references/envelope-schema.md`).

Git is the only channel: you push *intent*, workers merge *results* back to `dev`.

```
 Author box (any laptop)         Git remote              Worker box(es) (VPS, watchdog)
 ┌──────────────────────┐   ┌────────────────┐   ┌───────────────────────────────────┐
 │ /schedule-task       │   │ tasks/*.json   │   │ schedule-task watchdog (daemon)   │
 │  dev / audit /       │──►│ prompts/*.md   │──►│  reads state/.machine role+id     │
 │  archive flows       │   │ batches/*.json │   │  only launches .worker == my id  │
 │  envelope + prompt   │   │                │   │  └─ detached runner → run <id>    │
 │  + batch manifest    │   │                │   │      worktree on automation/<id>  │
 │  (assigns .worker)   │   │                │   │      agents.js → claude|kimi      │
 └──────────────────────┘   │                │   │      limit? park → resume session│
        ▲                   │ dev ← results  │◄──│      done → executor merges to dev│
 │  git fetch + status ─────┤ reports/*.md   │   │      (never touches others' work) │
 │  audit / archive ───────►│ (merged to dev)│   └───────────────────────────────────┘
 │                          │                │
 └──────────────────────────┘                └─── workers execute + merge their own work
```

*(All `tasks/` `prompts/` `reports/` `batches/` `state/` `templates/` above live under the
repo's `.schedule-tasks-data/` directory — the per-project private data dir, renamed from the
old `automation/`.)*

Key properties: no AI in the control loop (the orchestrator is deterministic Node); add-only git
design (no merge conflicts on the bus); gates as prose (polyglot — any language's repo); resume
via CLI session ids (no work lost or redone across limit windows); per-task worktrees + branches;
machine identity (`state/.machine`) so an author box and several workers never race; workers only
execute, the author merges finished batches (dependency-ordered, PR optional).

## Runtime: one CLI, two dependencies

The whole runtime is the **`schedule-task` CLI** — a single zero-dependency Node program. The
only hard requirements are **node ≥ 18** and **git**; the old bash/jq/GNU-date/tmux/flock stack
is gone. `jq` is JSON.parse, GNU date is `Date`, tmux sessions are detached process groups
(killed via `kill(-pgid)`), flock is a pid lock file.

The install is **three-layer separated** (see `docs/refactor-three-layer-separation.md`): the
CLI is installed **once per machine** as a global command by `install.sh` (`npm install -g`),
the skill copies are knowledge (SKILL.md/references/templates, `bin/`+`src/` reference-only),
and `.schedule-tasks-data/` is per-project data. The CLI runs the same everywhere:

```bash
schedule-task --help      # every command
schedule-task doctor      # env health check (node/git/claude/kimi/graphify) — prints CLI vX · data schema vY
schedule-task self-test   # run the node:test suite
schedule-task version     # the CLI version
schedule-task update      # refresh the whole install to the latest source
```

`schedule-task <cmd>` is the same command on every machine — no per-copy invocation, no version
drift between installs.

## Install

Pick your install path:

- **At a terminal and want to read the source** → **Option A**
- **Want an AI agent to install or update it for you** → **Option B** (send your agent this exact prompt: `Install this skill for me: https://github.com/smart-kind/schedule-task-skill — read README.md first, then follow its install instructions. If the skill is already installed here, run install.sh with --update to refresh it.`)
- **At a terminal, one-liner only** → **Option C**

**Option A — clone then install** (if you want to read the source):

```bash
git clone https://github.com/smart-kind/schedule-task-skill ~/schedule-task
cd ~/schedule-task
./install.sh            # add --dry-run to preview, --yes to skip prompts
```

**Option B — let an AI agent install it for you.** In your agent (Kimi Code, Claude Code,
Codex, …), say:

> Install this skill for me: https://github.com/smart-kind/schedule-task-skill — read README.md first, then follow its install instructions. If the skill is already installed here, run install.sh with `--update` to refresh it.

When your agent receives the prompt above, it automatically reads this README, fetches
`install.sh`, detects its own platform, and runs it with the matching `--platform` flag (plus
`--update` when the skill is already installed, so existing copies are refreshed instead of
skipped) — no clone, no inspection, no interactive answers, and no need for you to say what
you are on. A human at a terminal instead uses the pipe form in Option C.

**Option C — manual install / update, one curl command** (public repo; the script clones itself):

```bash
# install (or refresh the source) — copies into the detected platforms:
curl -fsSL https://raw.githubusercontent.com/smart-kind/schedule-task-skill/main/install.sh | bash

# update an existing install (refresh the global CLI + replace the installed copies):
curl -fsSL https://raw.githubusercontent.com/smart-kind/schedule-task-skill/main/install.sh | bash -s -- --update
```

### install.sh flags

| Flag | Meaning |
|---|---|
| `--platform=kimi-code,claude,agents` (or `all`) | Which agent platform(s) to install the skill into. For unattended/AI installs pass exactly the platform the script runs under — no prompts. |
| `--yes` | Skip all prompts (installs into every detected platform when `--platform` is absent). |
| `--dry-run` | Print what would happen without changing anything. |
| `--update` | Refresh the source, re-run `npm install -g` for the global CLI, and re-copy the skill dirs (replacing installed copies in place). |

With no flags and a terminal, `install.sh` asks which platform(s) to use. Then it:

1. **Installs the global CLI** — `npm install -g <source>` puts the `schedule-task` command on
   PATH (tool layer, once per machine).
2. **Copies the skill** into each chosen platform's skills dir — a plain user-level copy, no
   symlinks (the same layout works on macOS and a VPS): `~/.kimi-code/skills/schedule-task`,
   `~/.claude/skills/schedule-task`, `~/.agents/skills/schedule-task`. `.git` and
   `graphify-out/` are stripped from each copy, and a `.installed-from` marker records the
   source. These are knowledge copies — the runtime is the global CLI from step 1.

**Update later:** edit the skill source repo, commit and release, then on each machine re-run
`./install.sh --update` in a source checkout, use the `--update` curl one-liner in Option C, or
run `schedule-task update` from any installed copy (it pulls the latest source, refreshes the
global CLI with `npm install -g`, and re-copies every platform's skill dir). A `~/.local/bin`
symlink leftover from older versions is never silently converted: install prints a hint
(`use --update`, or delete the symlink by hand and reinstall).

### Per-tool notes

- **Kimi Code** and **Codex** natively scan `~/.agents/skills/` (user-level) — pick `agents`
  when asked (or `kimi-code`, Kimi Code's own dir).
- **Claude Code** does not read `.agents/skills/` — it only loads `~/.claude/skills/`, so pick
  `claude` for it.
- You can install into several platforms on the same machine; each gets its own independent
  copy (no shared links, so nothing breaks when paths differ across machines).

## Quickstart

1. **Install the runtime into a target repo** (once per repo, once per machine). Open the repo
   in your agent and ask to "initialize automation", or run `schedule-task init`. It asks what
   this machine is (role `author` or `worker`) and its machine id, writes
   `.schedule-tasks-data/state/.machine` (gitignored), creates the data directories
   `.schedule-tasks-data/{tasks,prompts,reports,batches,state,templates,hooks}/` with a no-op
   `hooks/notify.sh`, stamps the committed data schema version (`.schedule-tasks-data/version`),
   merges the gitignore snippet, checks dependencies (`node`, `git`, plus
   `claude` or `kimi`), and — only for a `worker` — prints the watchdog command:
   ```
   schedule-task watchdog start --repo <repo>
   ```
   Run it on the worker: a resident daemon checks for due tasks every 300 s (default;
   `--interval <s>` to change) and launches them as detached runners. No cron needed. Inspect or
   stop it with `schedule-task watchdog status | stop`; after a reboot, `start` again (or add it
   to the login startup). `.schedule-tasks-data/state/` stays worker-local
   (gitignored). If the repo still has the old `automation/` data dir, `init` offers to migrate
   it (move + rewrite `prompt_file` paths).
2. **Open a dev batch.** In the repo, tell your agent: "start a dev batch: <what you want done>,
   run it tonight at 02:00 UTC". The skill runs `schedule-task dev` (it refuses while a batch is
   still open), interviews you (mission, gates in plain language, worker assignment, guardrails,
   schedule), splits the requirement into subtasks if needed, drafts the envelopes + prompts
   (from `templates/dev-plan-harness.md`), shows them for review, and commits to the inbox branch
   (`dev`).
3. **Watch it.** From the worker: `schedule-task status` (live state) and
   `schedule-task log <id> -f` (live stream — replaces the old `tmux attach`). From the author
   box: `git fetch && schedule-task status` (reads the reports merged to `dev` — no branch
   awareness needed). Each finished dev task is merged to `dev` by its executor with a handover
   report; `schedule-task` (bare) is also status.
4. **Audit + close.** When every dev task is `dev-done`, run `schedule-task audit`
   (`--edit`/`--readonly`, `--per-task`/`--batch` — the auditor uses the opposite agent and
   reviews code + test meaningfulness). When every member is terminal, close the batch with
   `schedule-task archive` (batch summary + archive/ + current batch cleared).

## Repo layout

```
schedule-task/
├── SKILL.md                  # the skill: status (default) / dev / audit / archive / init / watchdog / cancel / log / migrate / doctor / update / version
├── README.md                 # this file
├── package.json              # zero runtime deps; bin → bin/schedule-task.js; npm test
├── install.sh                # three-layer install: global CLI (npm install -g) + knowledge skill copies
├── bin/schedule-task.js      # CLI launcher (shebang; everything is in src/)
├── src/                      # the whole runtime — one module per concern
│   ├── cli.js                # command table + arg parsing + help
│   ├── core.js               # paths, machine identity, current batch, state/notes/pid, notify hook, env seams
│   ├── git.js                # thin `git` wrappers (the only external channel)
│   ├── agents.js             # coding-agent router: claude/kimi profiles, stream-json parsing
│   ├── runner.js             # resilient per-task runner (worktree, resume, limit-park, merge verify, report)
│   ├── dispatch.js           # the tick: eligibility, concurrency cap, detached spawn (called by watchdog)
│   ├── watchdog.js           # watchdog start/stop/status — the resident daemon loop
│   ├── status.js             # read-only reporter (worker/author modes, batch grouping)
│   ├── audit.js              # AUTHOR-side audit creation (mode + granularity, opposite agent)
│   ├── cancel.js             # cancel + cascade + process-group kill
│   ├── archive.js            # AUTHOR-side batch close-out (summary + archive/)
│   ├── init.js               # per-repo setup + automation/ migration
│   ├── log.js                # `log <id> [-f]` — tail a run log
│   ├── migrate.js            # deterministic data-schema upgrade (stamps .schedule-tasks-data/version)
│   └── doctor.js             # environment health check
├── templates/
│   ├── harness-common.md     # shared task rules (graphify, TEST_HEADER, checkpoints, resume)
│   ├── dev-plan-harness.md   # dev task prompt skeleton (report + merge protocol)
│   ├── audit-harness.md      # audit task prompt skeleton (readonly/edit, verdict)
│   └── hooks/notify.sh       # default no-op hook (copied per repo at init)
├── references/
│   ├── envelope-schema.md    # tasks/<id>.json + batches/<batch>.json + state contract
│   ├── architecture.md       # runtime design (trigger/driver layers) + three-layer install topology
│   └── operations.md         # logs, watching, stuck-task recovery, notify hook
└── tests/                    # node:test suite (no VPS, no network, mock agent CLI)
```

Per-project data (created by `init`, gitignored part is `state/`):

```
<repo>/.schedule-tasks-data/
├── version                                  # committed data schema version (upgraded by `schedule-task migrate`)
├── tasks/  prompts/  reports/  batches/  templates/   # committed (each has archive/ where applicable)
├── state/                                  # gitignored: .machine, <id>, <id>.notes, <id>.pid, .watchdog.pid, .watchdog.status
└── hooks/notify.sh                         # per-project notification hook
```

Worker-local run state (per machine, per repo): `~/.local/state/schedule-task/<repo-basename>/`
with `<id>/run.log`, `<id>/attempt-<n>.jsonl`, `<id>/session_id`, `worktrees/<id>`,
`watchdog.log`.

## Program version vs data schema

Two version numbers are managed separately:

- **Program version** (`package.json` version, printed as `CLI vX`) — bumps on any code change.
- **Data schema** (`.schedule-tasks-data/version`, printed as `data schema vY`) — the format
  contract of `envelope`/`prompt`/`report`/`state`. Bumps only when the data formats change.

`status`/`doctor` print both on one line (`CLI v3.1.0 · data schema v1`). The rule is:

- data schema **<** CLI schema → **needs `schedule-task migrate`** (read commands warn and keep
  working; write commands `run`/`audit`/`cancel`/`archive` **hard-stop** with a migrate hint).
- data schema **>** CLI schema → the CLI is too old; refuse and upgrade the CLI
  (`install.sh --update`).
- equal → normal operation.

`migrate` is deterministic (no AI): it upgrades the committed schema version in place. Commit the
current state first, then run it — rollback is a git revert. On a fresh repo, `schedule-task
init` writes the current schema version.

## Back-compat & rollback

- Old envelopes (no `batch` / `worker` / `depends_on` / `agent`) run unchanged as single-task
  batches with no machine assignment (any worker) on the default `claude` profile. Old-style ids
  remain valid — the id is just the filename.
- **Data dir renamed:** `automation/` → `.schedule-tasks-data/`. `schedule-task init` migrates
  an existing `automation/` data dir in place (move + rewrite `prompt_file`); the old shell
  scripts are not needed for anything.
- **Branch convention unchanged:** one branch per task, `automation/<id>` — in-flight task
  branches on live workers keep working. New tasks delete the branch after a successful merge.
- **Worker merge replaces author merge-batch.** Workers now merge their own work to `dev`;
  `merge-batch` is gone. In-flight tasks finish under the old rules.
- **No tmux:** watch a task with `schedule-task log <id> -f`; cancel kills the runner's process
  group instead of a tmux session.
- **State contract preserved, words extended:** the `state/<id>` first-line-is-the-state-word
  contract is preserved; v3 adds `dev-done` / `merge-failed` / `audit-pass` / `audit-fail` and
  reads legacy `done` as `dev-done`, so older tooling reading those files keeps working.
- `FL_MAX_CONCURRENCY=1` restores the old fully-serial dispatch behavior; the default is 2.
- **Unversioned data dirs keep working for reads.** A `.schedule-tasks-data/` without a
  `version` file (pre-3.1.0) is treated as legacy schema v0: `status`/`doctor` warn and continue,
  write commands (`run`/`audit`/`cancel`/`archive`) hard-stop with a hint until
  `schedule-task migrate` stamps the version (commit first — rollback is a git revert).
- The old bash runtime is preserved in git history (`automation/*.sh` on `main`).

## More

- Authoring tasks: read `SKILL.md` (or just ask your agent to schedule something).
- Field-by-field schema: `references/envelope-schema.md`.
- Design rationale: `references/architecture.md`.
- Operating a live system (stuck tasks, notify hooks): `references/operations.md`.
- Run the tests: `npm test` or `schedule-task self-test`.
