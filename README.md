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
 │ /schedule-task       │   │ tasks/*.json   │   │ dispatch.sh (flock, FL_MAX_CONC.) │
 │  DISCUSS→DRAFT→      │──►│ prompts/*.md   │──►│  reads state/.machine role+id     │
 │  REVIEW→COMMIT       │   │ batches/*.json │   │  only launches .worker == my id  │
 │  envelope + prompt   │   │                │   │  └─ tmux task-<id> → run-task.sh │
 │  + batch manifest    │   │                │   │      worktree on automation/<id>  │
 │  (assigns .worker)   │   │                │   │      coding-agent.sh → claude|kimi│
 └──────────────────────┘   │                │   │      limit? park → resume session│
        ▲                   │ reports/*.md   │◄──│      done → reports/<id>.md, push│
 │  git fetch + status ─────┤ task branches  │   │      (never merges)              │
 │  merge-batch.sh: land ──►│                │   └───────────────────────────────────┘
 │  done branches → dev     │                │
 └──────────────────────────┘                └─── workers only execute; author merges
```

Key properties: no AI in the control loop (the orchestrator is deterministic shell); add-only git
design (no merge conflicts on the bus); gates as prose (polyglot — any language's repo); resume
via CLI session ids (no work lost or redone across limit windows); per-task worktrees + branches;
machine identity (`state/.machine`) so an author box and several workers never race; workers only
execute, the author merges finished batches (dependency-ordered, PR optional).

## Install

```bash
git clone <this-repo-url> ~/agent-skills/schedule-task   # or anywhere
cd ~/agent-skills/schedule-task
./install.sh              # add --dry-run to preview
```

`install.sh` symlinks the repo into every agent-skills directory whose parent exists:
`~/.agents/skills/schedule-task`, `~/.claude/skills/schedule-task`, `~/.kimi-code/skills/schedule-task`.
Existing entries are left alone (reported as SKIP). To update later, run `./install.sh --update`.
Manual equivalent:

```bash
ln -s "$PWD" ~/.agents/skills/schedule-task
```

### Per-tool notes

- **Kimi Code** and **Codex** natively scan `.agents/skills/` (user-level `~/.agents/skills/` +
  project-level) — the `~/.agents` symlink is enough. (Verified: Kimi reads `~/.agents/skills`.)
- **Claude Code** does not read `.agents/skills/` — it only loads `.claude/skills/`, so the
  `~/.claude/skills` symlink is required for it.
- One repo on disk, one source of truth, three entry points.

## Quickstart

1. **Install the runtime into a target repo** (once per repo, once per machine). Open the repo
   in your agent and ask to "initialize automation", or run the skill's `init` flow. It asks what
   this machine is (role `author` or `worker`) and its machine id, writes
   `automation/state/.machine` (gitignored), creates the data directories
   `automation/{tasks,prompts,reports,batches,state}/` and a no-op `automation/hooks/notify.sh`,
   merges the gitignore snippet, checks dependencies (`jq`, `tmux`, `git`, plus `claude` or
   `kimi`), and — only for a `worker` — prints the worker's cron line. The executable scripts
   stay in the user-level skill installation; the cron line passes the repo path as the first
   argument (`<lock>` = repo basename, so each project's dispatcher on a machine gets its own
   flock):
   ```
   */5 * * * * flock -n /tmp/<lock>-dispatch.lock bash ~/.agents/skills/schedule-task/automation/dispatch.sh <repo> >> <repo>/automation/dispatch.log 2>&1
   ```
   Add that line to the worker's crontab. `automation/state/` stays worker-local (gitignored).
2. **Schedule your first task.** In the repo, tell your agent: "schedule a task: <what you want
   done>, run it tonight at 02:00 UTC". The skill interviews you (mission, gates in plain
   language, worker assignment, guardrails, schedule), drafts `automation/tasks/<id>.json` +
   `automation/prompts/<id>.md`, shows them for review, and commits to the inbox branch (`dev`).
3. **Watch it.** From the worker: `bash ~/.agents/skills/schedule-task/automation/status.sh <repo>`
   (live state). From the author box: `git fetch && bash ~/.agents/skills/schedule-task/automation/status.sh <repo>`
   (infers state from each task branch's committed report). Live on the worker:
   `tmux attach -t task-<id>`. Results arrive as commits on `automation/<id>` plus
   `automation/reports/<id>.md`.
4. **Batches**: describe one requirement that needs several tasks and the skill drafts a
   dependency-ordered batch (`depends_on`, shared `batch` id, `batches/<batch>.json` manifest),
   assigning each task to a worker if you have more than one. When all members finish, the
   **author** lands them: `bash automation/merge-batch.sh <batch-id>` (PR optional) — workers
   never merge.

## Repo layout

```
schedule-task/
├── SKILL.md                  # the skill: create (default) / status / init / archive
├── README.md                 # this file
├── install.sh                # symlink into ~/.agents ~/.claude ~/.kimi-code skill dirs
├── templates/
│   └── plan-harness.md       # prompt skeleton every task prompt is built from
├── references/
│   ├── envelope-schema.md    # tasks/<id>.json + batches/<batch>.json + state contract
│   ├── architecture.md       # two-layer design, topology, invariants, agent router
│   └── operations.md         # logs, tmux, stuck-task recovery, notify hook
└── automation/               # runtime scripts (user-level); data dirs live in each target repo
    ├── dispatch.sh           # trigger-layer watchdog (cron; machine-identity + .worker gating)
    ├── run-task.sh           # resilient per-task runner (tmux, worktree, resume)
    ├── coding-agent.sh       # CLI router: claude/kimi profiles, exit-code contract
    ├── status.sh             # read-only status reporter (worker/author modes)
    ├── merge-batch.sh        # AUTHOR-side batch finalization (workers never merge)
    ├── archive-task.sh       # retire finished tasks into archive/
    ├── hooks/notify.sh       # default no-op notification hook (copied per repo as customization point)
    ├── tasks/  prompts/  reports/  batches/   # inboxes/outboxes (.gitkeep'd) — copied into target repos
    └── gitignore.snippet     # automation/state/ (incl. state/.machine)
```

## Back-compat & rollback

- Old envelopes (no `batch` / `worker` / `depends_on` / `agent`) run unchanged as single-task
  batches with no machine assignment (any worker) on the default `claude` profile. Old-style ids
  (`YYYY-MM-DD-<slug>`) remain valid — the id is just the filename.
- **Behavior change:** workers no longer auto-merge finished batches. If you relied on that,
  merge by hand or use `automation/merge-batch.sh <batch-id>` from the author box — same
  dependency order, same merge target.
- **Behavior change:** a machine without `automation/state/.machine` defaults to
  `role=worker, id=<hostname>` and only launches tasks without a `worker` field (or matching its
  hostname) — exactly the old single-worker behavior.
- `FL_MAX_CONCURRENCY=1` in the dispatcher's environment restores the old fully-serial dispatch
  behavior; the default is 2.
- The `state/<id>` first-line-is-the-state-word contract is unchanged, so older status/archive
  tooling keeps working.

## More

- Authoring tasks: read `SKILL.md` (or just ask your agent to schedule something).
- Field-by-field schema: `references/envelope-schema.md`.
- Design rationale: `references/architecture.md`.
- Operating a live system (stuck tasks, notify hooks): `references/operations.md`.
