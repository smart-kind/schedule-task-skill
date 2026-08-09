# schedule-task

A SKILL.md-compatible skill that teaches any coding agent CLI (Kimi Code, Codex, Claude Code) to
author **scheduled, resumable automation tasks** — dev / test / audit — that a deterministic
watchdog executes unattended on a worker box (e.g. a VPS). You describe the work in natural
language from any repo; the skill produces a routing envelope + a plan-harness prompt (plus a
batch manifest for multi-task requests), commits them to the repo's inbox branch, and the worker
picks them up at the scheduled time, survives usage-limit windows, and pushes back results.

Git is the only channel: you push *intent*, the worker pushes back *results*.

```
 Author box (any laptop)         Git remote              Worker box(es) (VPS, watchdog)
 ┌──────────────────────┐   ┌────────────────┐   ┌───────────────────────────────────┐
 │ /schedule-task       │   │ tasks/*.json   │   │ schedule-task watchdog (daemon)   │
 │  DISCUSS→DRAFT→      │──►│ prompts/*.md   │──►│  reads state/.machine role+id     │
 │  REVIEW→COMMIT       │   │ batches/*.json │   │  only launches .worker == my id  │
 │  envelope + prompt   │   │                │   │  └─ detached runner → run <id>    │
 │  + batch manifest    │   │                │   │      worktree on automation/<id>  │
 │  (assigns .worker)   │   │                │   │      agents.js → claude|kimi      │
 └──────────────────────┘   │                │   │      limit? park → resume session│
        ▲                   │ reports/*.md   │◄──│      done → reports/<id>.md, push│
 │  git fetch + status ─────┤ task branches  │   │      (never merges)              │
 │  merge-batch: land ────► │                │   └───────────────────────────────────┘
 │  done branches → dev     │                │
 └──────────────────────────┘                └─── workers only execute; author merges
```

*(All `tasks/` `prompts/` `reports/` `batches/` `state/` above live under the repo's
`.schedule-tasks-data/` directory — the per-project private data dir, renamed from the old
`automation/`.)*

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

The CLI ships **inside the skill itself — there is no global install.** In the installed copy
(or the source checkout) it lives at `bin/schedule-task.js`:

```bash
node <skill-dir>/bin/schedule-task.js --help      # every command
node <skill-dir>/bin/schedule-task.js doctor      # env health check (node/git/claude/kimi/graphify)
node <skill-dir>/bin/schedule-task.js self-test   # run the node:test suite
node <skill-dir>/bin/schedule-task.js version     # this copy's version (run per copy to tell leftovers apart)
```

`<skill-dir>` is the directory that contains `SKILL.md` — e.g. `~/.agents/skills/schedule-task`.
Throughout the rest of this README, `schedule-task <cmd>` is shorthand for
`node <skill-dir>/bin/schedule-task.js <cmd>`.

## Install

Pick your install path:

- **At a terminal and want to read the source** → **Option A**
- **Want an AI agent to install it for you** → **Option B** (send your agent this exact prompt: `Install this skill for me: https://github.com/smart-kind/schedule-task-skill — read README.md first, then follow its install instructions.`)
- **At a terminal, one-liner only** → **Option C**

**Option A — clone then install** (if you want to read the source):

```bash
git clone https://github.com/smart-kind/schedule-task-skill ~/schedule-task
cd ~/schedule-task
./install.sh            # add --dry-run to preview, --yes to skip prompts
```

**Option B — let an AI agent install it for you.** In your agent (Kimi Code, Claude Code,
Codex, …), say:

> Install this skill for me: https://github.com/smart-kind/schedule-task-skill — read README.md first, then follow its install instructions.

When your agent receives the prompt above, it automatically reads this README, fetches
`install.sh`, detects its own platform, and runs it with the matching `--platform` flag —
no clone, no inspection, no interactive answers, and no need for you to say what you are
on. A human at a terminal instead uses the pipe form in Option C.

**Option C — manual install, one curl command** (public repo; the script clones itself):

```bash
curl -fsSL https://raw.githubusercontent.com/smart-kind/schedule-task-skill/main/install.sh | bash
```

### install.sh flags

| Flag | Meaning |
|---|---|
| `--platform=kimi-code,claude,agents` (or `all`) | Which agent platform(s) to install the skill into. For unattended/AI installs pass exactly the platform the script runs under — no prompts. |
| `--yes` | Skip all prompts (installs into every detected platform when `--platform` is absent). |
| `--dry-run` | Print what would happen without changing anything. |
| `--update` | Refresh the source, re-copy the skill dirs (replacing installed copies in place). |

With no flags and a terminal, `install.sh` asks which platform(s) to use. Then it:

1. **Copies** the skill into each chosen platform's skills dir — a plain user-level copy,
   **no symlinks, no global install** (self-contained: the same layout works on macOS and a
   VPS): `~/.kimi-code/skills/schedule-task`, `~/.claude/skills/schedule-task`,
   `~/.agents/skills/schedule-task`. `.git` and `graphify-out/` are stripped from each copy,
   and a `.installed-from` marker records the source.
2. Prints how to run the CLI from each copy — `node <skill-dir>/bin/schedule-task.js <cmd>`.
   There is nothing else to install.

**Update later:** edit the skill source repo, commit and release, then run
`./install.sh --update` in a source checkout (or re-run the curl line) on each machine — it
refreshes the source and re-copies the skill dirs in place. Old symlink installs from the
previous version are never silently converted: install prints a hint (`use --update`, or delete
the symlink by hand and reinstall).

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
   `.schedule-tasks-data/{tasks,prompts,reports,batches,state,hooks}/` with a no-op
   `hooks/notify.sh`, merges the gitignore snippet, checks dependencies (`node`, `git`, plus
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
2. **Schedule your first task.** In the repo, tell your agent: "schedule a task: <what you want
   done>, run it tonight at 02:00 UTC". The skill interviews you (mission, gates in plain
   language, worker assignment, guardrails, schedule), drafts
   `.schedule-tasks-data/tasks/<id>.json` + `.schedule-tasks-data/prompts/<id>.md`, shows them
   for review, and commits to the inbox branch (`dev`).
3. **Watch it.** From the worker: `schedule-task status` (live state) and
   `schedule-task log <id> -f` (live stream — replaces the old `tmux attach`). From the author
   box: `git fetch && schedule-task status` (infers state from each task branch's committed
   report). Results arrive as commits on `automation/<id>` plus
   `.schedule-tasks-data/reports/<id>.md`.
4. **Batches**: describe one requirement that needs several tasks and the skill drafts a
   dependency-ordered batch (`depends_on`, shared `batch` id, `batches/<batch>.json` manifest),
   assigning each task to a worker if you have more than one. When all members finish, the
   **author** lands them: `schedule-task merge-batch <batch-id>` (PR optional) — workers never
   merge.

## Repo layout

```
schedule-task/
├── SKILL.md                  # the skill: create (default) / status / init / archive / cancel / merge-batch / log / doctor / version
├── README.md                 # this file
├── package.json              # zero runtime deps; bin → bin/schedule-task.js; npm test
├── install.sh                # installs self-contained skill copies (no symlinks, no global CLI)
├── bin/schedule-task.js      # CLI launcher (shebang; everything is in src/)
├── src/                      # the whole runtime — one module per concern
│   ├── cli.js                # command table + arg parsing + help
│   ├── core.js               # paths, machine identity, state/notes/pid, notify hook, env seams
│   ├── git.js                # thin `git` wrappers (the only external channel)
│   ├── agents.js             # coding-agent router: claude/kimi profiles, stream-json parsing
│   ├── runner.js             # resilient per-task runner (worktree, resume, limit-park, report)
│   ├── dispatch.js           # the tick: eligibility, concurrency cap, detached spawn (called by watchdog)
│   ├── watchdog.js           # watchdog start/stop/status — the resident daemon loop
│   ├── status.js             # read-only reporter (worker/author modes, batch grouping)
│   ├── cancel.js             # cancel + cascade + process-group kill
│   ├── archive.js            # retire finished tasks into archive/
│   ├── merge-batch.js        # AUTHOR-side batch finalization
│   ├── init.js               # per-repo setup + automation/ migration
│   ├── log.js                # `log <id> [-f]` — tail a run log
│   └── doctor.js             # environment health check
├── templates/
│   ├── plan-harness.md       # prompt skeleton every task prompt is built from
│   └── hooks/notify.sh       # default no-op hook (copied per repo at init)
├── references/
│   ├── envelope-schema.md    # tasks/<id>.json + batches/<batch>.json + state contract
│   ├── architecture.md       # two-layer design, topology, invariants, agent router
│   └── operations.md         # logs, watching, stuck-task recovery, notify hook
└── tests/                    # node:test suite (no VPS, no network, mock agent CLI)
```

Per-project data (created by `init`, gitignored part is `state/`):

```
<repo>/.schedule-tasks-data/
├── tasks/  prompts/  reports/  batches/    # committed (inbox/outbox; each has archive/)
├── state/                                  # gitignored: .machine, <id>, <id>.notes, <id>.pid, .watchdog.pid, .watchdog.status
└── hooks/notify.sh                         # per-project notification hook
```

Worker-local run state (per machine, per repo): `~/.local/state/schedule-task/<repo-basename>/`
with `<id>/run.log`, `<id>/attempt-<n>.jsonl`, `<id>/session_id`, `worktrees/<id>`,
`watchdog.log`.

## Back-compat & rollback

- Old envelopes (no `batch` / `worker` / `depends_on` / `agent`) run unchanged as single-task
  batches with no machine assignment (any worker) on the default `claude` profile. Old-style ids
  remain valid — the id is just the filename.
- **Data dir renamed:** `automation/` → `.schedule-tasks-data/`. `schedule-task init` migrates
  an existing `automation/` data dir in place (move + rewrite `prompt_file`); the old shell
  scripts are not needed for anything.
- **Branch convention unchanged:** one branch per task, `automation/<id>` — in-flight task
  branches on live workers keep working.
- **No tmux:** watch a task with `schedule-task log <id> -f`; cancel kills the runner's process
  group instead of a tmux session.
- **State contract unchanged:** the `state/<id>` first-line-is-the-state-word contract is
  preserved, so older tooling reading those files keeps working.
- `FL_MAX_CONCURRENCY=1` restores the old fully-serial dispatch behavior; the default is 2.
- The old bash runtime is preserved in git history (`automation/*.sh` on `main`).

## More

- Authoring tasks: read `SKILL.md` (or just ask your agent to schedule something).
- Field-by-field schema: `references/envelope-schema.md`.
- Design rationale: `references/architecture.md`.
- Operating a live system (stuck tasks, notify hooks): `references/operations.md`.
- Run the tests: `npm test` or `schedule-task self-test`.
