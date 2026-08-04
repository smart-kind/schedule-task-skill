# Architecture

How the automation runtime works and why it is shaped this way. Self-contained; this is the
canonical description of the design.

## Two-layer architecture

The core insight: **triggering is instantaneous; execution is multi-hour.** The two are separate
layers with different owners, so the fragile part (long-running, limit-prone) is hardened while
the trigger stays trivial.

```
  TRIGGER layer  →  decides WHEN + WHAT   (cron → dispatch.sh)         ← deterministic, seconds
  DRIVER layer   →  runs it to completion (run-task.sh in tmux)        ← resilient, hours-long
  EXECUTOR       →  does the actual work  (coding-agent.sh → claude|kimi -p)
```

- **`dispatch.sh`** (worker, cron every 5 min under `flock`) — refuses to run unless
  `automation/state/.machine` says `role=worker`; then pulls the inbox branch, finds due +
  eligible tasks **whose envelope `.worker` equals this machine's id** (absent `.worker` = any
  worker may take it), launches each in a detached tmux session (`task-<id>`). Concurrency is
  capped by `FL_MAX_CONCURRENCY` (default 2; `=1` reproduces the old fully-serial behavior). It
  never merges anything. Returns immediately — the multi-hour part is not the cron tick's job.
- **`run-task.sh <id>`** (worker, inside tmux) — executes the task's prompt in an isolated git
  worktree on the task branch; survives usage-limit windows by parking until the reset time and
  resuming the same CLI session with full context; verifies completion (the `[[TASK_DONE <id> …]]`
  sentinel **and** a new commit — trust-but-verify, the executor never self-certifies); commits an
  autosave + `automation/reports/<id>.md`, pushes the branch, records state.
- **Executor** — the coding agent CLI running the plan-harness prompt. It is the only component
  with a brain; it fans out its own sub-agents, discovers the repo's build/test commands, and
  decides when the gates pass.

**No AI in the control loop.** dispatch.sh and run-task.sh are deterministic shell. Every
decision that requires judgment happens inside the executor, never in the orchestrator.

## Topology: author box ⟷ git ⟷ one or more workers

```
 Author box (laptop)            Git remote           Worker boxes (VPS, worker-a, …)
       │                            │                      │
  /schedule-task (NL)               │                      │
  commit envelope+prompt            │                      │
  + batch manifest ──push──────────►│                      │
  (each task names its worker)      │◄── git pull ─────────┤  cron tick every 5 min (flock)
       │                            │     scan tasks/*.json: .worker == my id?
       │                            │     due? pending? depends_on all done?
       │                            │     launch ──► tmux task-<id> ──► run-task.sh
       │                            │                      │   worktree on automation/<id>
       │                            │                      │   claude|kimi -p runs the prompt
       │                            │                      │   ┌─ usage limit ─┐
       │                            │                      │   │ park → resume │
       │                            │                      │   └───────────────┘
       │                            │◄── push results ─────┤   sentinel + new commit → done
       │                            │     task branch + reports/<id>.md (per worker)
       │  git fetch ◄───────────────┤                      │
       │  status: read reports      │                      │
       │  from each origin/<branch> │                      │
       │  merge-batch.sh: land all  │                      │
       │  done branches → dev       │                      │
       │  push (PR optional)        │                      │
```

Git is the only channel. The author pushes *intent*; each worker pushes back *results* on its own
branches. No service, no API, no shared filesystem.

## Core invariants

1. **No AI in the control loop.** The orchestrator is deterministic; only the executor thinks.
   This keeps the multi-hour resilience logic reviewable and testable.
2. **Add-only design → conflict-free merges.** Each side only ever *adds* new files: the author
   adds `tasks/*.json` + `prompts/*.md` (+ `batches/*.json`); the worker adds `reports/*.md` and
   commits on per-task branches. One file per task — a shared mutable file would be a guaranteed
   merge conflict. Mutable runtime status lives off-git in `state/` (gitignored, worker-local).
3. **Gates are prose, never fields.** Acceptance criteria live in the prompt as natural language;
   the executor discovers the concrete commands for the repo it lands in (`npm test` vs `pytest`
   vs `cargo test`). The envelope stays polyglot — the same machinery drives a JS repo today, a
   Python/Rust repo tomorrow.
4. **Resume via CLI session ids.** When a usage limit hits mid-run, the runner parks until the
   reset time, then resumes the *same* CLI session (`--resume` / `-S`) with full context. Session
   ids are persisted to disk the moment they appear in the stream, and recovered from the newest
   attempt log if the runner died before persisting (e.g. reboot). Between checkpoints, the git
   commit is the durable state and the prompt's "If interrupted and resumed" section tells the
   executor to continue from the last commit — never redo, never revert.
5. **Worktree isolation per task.** Each task runs in its own git worktree on its own branch
   (`automation/<id>`, cut from the inbox-branch tip). Concurrent tasks never share a working
   tree; the main checkout stays untouched for the dispatcher.
6. **Per-task branches; never `main`/`dev` directly.** The executor's blast radius is bounded by
   branch guardrails ("never touch main"), and results arrive as reviewable branch commits.
7. **Machine identity, no cross-machine racing.** Every machine that runs the runtime declares
   itself at `init` in gitignored `automation/state/.machine`: `role=author|worker` +
   `id=<machine-id>`. Only `role=worker` machines dispatch; a task runs only on its named
   `worker` (absent = any worker may take it). Because state/ never crosses git, this declaration
   is the only coordination between machines — and it is enough, because each task has exactly
   one owner. (This replaces the old assumption "only the single VPS installs cron", which broke
   the moment a second machine — even the author's laptop — also pulled the inbox.)
8. **The author is the only merger.** Workers never merge. When every task in a batch is done,
   the author runs `automation/merge-batch.sh <batch-id>`: it fetches origin, lands each task
   branch whose committed report says `(done)` onto the manifest's `merge_target` (default `dev`)
   in manifest (dependency) order, and pushes (PR optional). A conflict aborts the merge
   (`git merge --abort`) and exits non-zero — resolution is a human/agent decision, never an
   automatic force-through. Idempotent, so a fix + re-run resumes where it stopped.
9. **Liveness by PID, not by silence.** A task is dead only when its process is gone. An executor
   fanning out sub-agents can legitimately emit nothing for 10+ minutes — never kill on "the pane
   went quiet".

## The coding-agent.sh router

`run-task.sh` never calls a CLI directly. It delegates to `automation/coding-agent.sh`:

```
coding-agent.sh <agent> fresh|resume <model> <session-id|-> <prompt-text>
```

- `<agent>` selects a **profile** (`claude` | `kimi`); each profile encapsulates four things:
  invocation flags, resume mechanics, session-id extraction from the stream, and usage-limit
  detection (including parsing the reset time). run-task.sh sees no CLI differences.
- Stream-json events go to stdout (captured as `attempt-<n>.jsonl`); the session id is extracted
  from the profile-specific meta event.
- **Exit-code contract** — this is the interface run-task.sh's resilience loop is built on:
  - `0` — normal exit (check for the `TASK_DONE` sentinel)
  - `75` — usage/session limit hit (park until reset, then resume)
  - anything else — ambiguous (bounded retry with backoff; after repeated ambiguous exits the
    runner drops the session and does one clean fresh run; past the hard cap it aborts as `failed`)

Adding a new executor CLI = adding one profile to coding-agent.sh. Nothing else changes.
