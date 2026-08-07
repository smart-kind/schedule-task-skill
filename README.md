# schedule-task

A SKILL.md-compatible skill that teaches any coding agent CLI (Kimi Code, Codex, Claude Code) to
author **scheduled, resumable automation tasks** — dev / test / audit — that a deterministic
dispatcher executes unattended on a worker box (e.g. a VPS). You describe the work in natural
language from any repo; the skill produces a routing envelope + a plan-harness prompt (plus a
batch manifest for multi-task requests), commits them to the repo's inbox branch, and the worker
picks them up at the scheduled time, survives usage-limit windows, and pushes back results.

Git is the only channel: you push *intent*, the worker pushes back *results*.

```
 Author box (any laptop)         Git remote              Worker box(es) (VPS, cron every 5 min)
 ┌──────────────────────┐   ┌────────────────┐   ┌───────────────────────────────────┐
 │ /schedule-task       │   │ tasks/*.json   │   │ schedule-task dispatch (pid lock) │
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

The whole runtime is **`schedule-task`** — a single zero-dependency Node CLI. The only hard
requirements are **node ≥ 18** and **git**; the old bash/jq/GNU-date/tmux/flock stack is gone.
`jq` is JSON.parse, GNU date is `Date`, tmux sessions are detached process groups (killed via
`kill(-pgid)`), flock is a pid lock file.

```bash
schedule-task --help            # every command
schedule-task doctor            # env health check (node/git/claude/kimi)
schedule-task self-test         # run the node:test suite
```

## Install

```bash
git clone <this-repo-url> ~/agent-skills/schedule-task   # or anywhere
cd ~/agent-skills/schedule-task
./install.sh              # add --dry-run to preview
```

`install.sh` does two things:

1. Symlinks the repo into every agent-skills directory whose parent exists:
   `~/.agents/skills/schedule-task`, `~/.claude/skills/schedule-task`,
   `~/.kimi-code/skills/schedule-task`. Existing entries are left alone (reported as SKIP).
2. Links the CLI at `~/.local/bin/schedule-task` → `bin/schedule-task.js` — no npm needed.

Alternatives: `npm link` / `npm install -g .` (global command), or `npx schedule-task` if the
package is ever published. To update later, run `./install.sh --update` (pulls + relinks).

### Per-tool notes

- **Kimi Code** and **Codex** natively scan `.agents/skills/` (user-level `~/.agents/skills/` +
  project-level) — the `~/.agents` symlink is enough. (Verified: Kimi reads `~/.agents/skills`.)
- **Claude Code** does not read `.agents/skills/` — it only loads `.claude/skills/`, so the
  `~/.claude/skills` symlink is required for it.
- One repo on disk, one source of truth, three entry points.

## Quickstart

1. **Install the runtime into a target repo** (once per repo, once per machine). Open the repo
   in your agent and ask to "initialize automation", or run `schedule-task init`. It asks what
   this machine is (role `author` or `worker`) and its machine id, writes
   `.schedule-tasks-data/state/.machine` (gitignored), creates the data directories
   `.schedule-tasks-data/{tasks,prompts,reports,batches,state,hooks}/` with a no-op
   `hooks/notify.sh`, merges the gitignore snippet, checks dependencies (`node`, `git`, plus
   `claude` or `kimi`), and — only for a `worker` — prints the worker's cron line:
   ```
   */5 * * * * schedule-task dispatch --repo <repo>
   ```
   Add that line to the worker's crontab. `.schedule-tasks-data/state/` stays worker-local
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
├── SKILL.md                  # the skill: create (default) / status / init / archive / cancel / merge-batch / log / doctor
├── README.md                 # this file
├── package.json              # zero runtime deps; bin → bin/schedule-task.js; npm test
├── install.sh                # skill-dir symlinks + ~/.local/bin/schedule-task link
├── bin/schedule-task.js      # CLI launcher (shebang; everything is in src/)
├── src/                      # the whole runtime — one module per concern
│   ├── cli.js                # command table + arg parsing + help
│   ├── core.js               # paths, machine identity, state/notes/pid, notify hook, env seams
│   ├── git.js                # thin `git` wrappers (the only external channel)
│   ├── agents.js             # coding-agent router: claude/kimi profiles, stream-json parsing
│   ├── runner.js             # resilient per-task runner (worktree, resume, limit-park, report)
│   ├── dispatch.js           # watchdog tick (pid lock, eligibility, detached spawn)
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
├── state/                                  # gitignored: .machine, <id>, <id>.notes, <id>.pid, .dispatch.lock
└── hooks/notify.sh                         # per-project notification hook
```

Worker-local run state (per machine, per repo): `~/.local/state/schedule-task/<repo-basename>/`
with `<id>/run.log`, `<id>/attempt-<n>.jsonl`, `<id>/session_id`, `worktrees/<id>`,
`dispatch.log`.

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
