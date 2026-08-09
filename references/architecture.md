# Architecture

How the schedule-task runtime works and why it is shaped this way. Self-contained; this is the
canonical description of the design.

> 业务视角的流程梳理（含 SVG 流程图：角色分工 / init / status / 看门狗 / 任务执行 / 取消 / 批次验收）见
> [`docs/business-flow.md`](../docs/business-flow.md)。本文档讲「为什么这么设计」，那份讲「怎么用」。

## Two-layer architecture

The core insight: **triggering is instantaneous; execution is multi-hour.** The two are separate
layers with different owners, so the fragile part (long-running, limit-prone) is hardened while
the trigger stays trivial.

```
  TRIGGER layer  →  decides WHEN + WHAT   (watchdog loop → dispatch tick)        ← deterministic, seconds
  DRIVER layer   →  runs it to completion (runner in a detached process)      ← resilient, hours-long
  EXECUTOR       →  does the actual work  (agents.js → claude|kimi -p)
```

- **`watchdog`** (worker, a resident daemon spawned by `watchdog start`) — every 300 s (default;
  `--interval <s>` to change) runs the dispatch tick. The tick refuses to run unless
  `.schedule-tasks-data/state/.machine` says `role=worker`; acquires a per-repo **pid lock file**
  (`state/.dispatch.lock`, with stale-lock detection — the flock replacement), pulls the inbox
  branch, finds due + eligible tasks **whose envelope `.worker` equals this machine's id**
  (absent `.worker` = any worker may take it), marks each `running` + writes its pid, and spawns
  each as a **detached runner process** (new session → its pid is its process-group id, so
  `cancel` can kill the whole tree). Concurrency is capped by `FL_MAX_CONCURRENCY` (default 2;
  `=1` reproduces the old fully-serial behavior). It never merges anything. `watchdog start`
  daemonizes itself (`state/.watchdog.pid`, cross-platform), records each tick's outcome in
  `state/.watchdog.status`, and is managed with `watchdog stop | status` — no cron, systemd, or
  launchd needed.
- **`runner <id>`** (worker, detached) — executes the task's prompt in an isolated git worktree
  on the task branch; survives usage-limit windows by parking until the reset time and resuming
  the same CLI session with full context; verifies completion (the `[[TASK_DONE <id> …]]`
  sentinel **and** a new commit — trust-but-verify, the executor never self-certifies). The
  executor writes the handover report and integrates the latest dev into its branch; the runner
  verifies mechanically that dev is an ancestor of the branch, fast-forwards `dev` to it, pushes,
  stamps the report, records state, and deletes the worktree + branch. If the fast-forward
  cannot land (dev advanced after the executor's integration), the runner marks the task
  `merge-failed`, pushes the branch, and keeps the worktree for the author.
- **Executor** — the coding agent CLI running the harness prompt. It is the only component
  with a brain; it fans out its own sub-agents, discovers the repo's build/test commands,
  decides when the gates pass, writes the report, and resolves merge conflicts in its own
  worktree (rebase onto the latest dev).

**No AI in the control loop.** watchdog and runner are deterministic Node. Every decision that
requires judgment happens inside the executor, never in the orchestrator.

## Topology: author box ⟷ git ⟷ one or more workers

```
 Author box (laptop)            Git remote           Worker boxes (VPS, worker-a, …)
       │                            │                      │
  /schedule-task dev/audit          │                      │
  commit envelope+prompt            │                      │
  + batch manifest ──push──────────►│                      │
  (each task names its worker)      │◄── git pull ─────────┤  watchdog tick every 5 min (daemon)
       │                            │     scan tasks/*.json: .worker == my id?
       │                            │     due? pending? depends_on all dev-done?
       │                            │     launch ──► detached runner ──► agents.js
       │                            │                      │   worktree on automation/<id>
       │                            │                      │   claude|kimi -p runs the prompt
       │                            │                      │   ┌─ usage limit ─┐
       │                            │                      │   │ park → resume │
       │                            │                      │   └───────────────┘
       │                            │                      │   executor: report + rebase dev
       │                            │◄── push dev ─────────┤   runner: ff dev ← branch, cleanup
       │                            │     (results + reports/<id>.md land on dev)
       │  git fetch ◄───────────────┤                      │
       │  status: read dev reports  │                      │
       │  audit / archive           │                      │
```

Git is the only channel. The author pushes *intent*; each worker pushes back *results* **on the
inbox branch (`dev`) itself** — task branches are disposable workspaces, not the channel. No
service, no API, no shared filesystem.

## Core invariants

1. **No AI in the control loop.** The orchestrator is deterministic; only the executor thinks.
   This keeps the multi-hour resilience logic reviewable and testable.
2. **Add-only design → conflict-free merges.** Each side only ever *adds* new files: the author
   adds `tasks/*.json` + `prompts/*.md` (+ `batches/*.json`); the worker adds `reports/*.md` and
   merges its own branch to `dev`. One file per task — a shared mutable file would be a guaranteed
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
   tree; the main checkout stays untouched for the watchdog.
6. **Per-task branches, disposable; never `main`/`dev` directly.** The executor's blast radius is
   bounded by branch guardrails ("never touch main"). The branch is an isolation workspace only:
   after a successful merge it is deleted (worktree + branch); on failure it is pushed so the
   author can inspect or re-dispatch.
7. **Machine identity, no cross-machine racing.** Every machine that runs the runtime declares
   itself at `init` in gitignored `.schedule-tasks-data/state/.machine`: `role=author|worker` +
   `id=<machine-id>`. Only `role=worker` machines dispatch; a task runs only on its named
   `worker` (absent = any worker may take it). Because state/ never crosses git, this declaration
   is the only coordination between machines — and it is enough, because each task has exactly
   one owner.
8. **Each worker merges its OWN work; the author never merges.** The executor integrates the
   latest dev into its branch (conflict resolution is its job — never a punt), and the runner
   fast-forwards `dev` to the branch (conflict-free by construction) and pushes. If the
   fast-forward cannot land, the task becomes `merge-failed` with the branch pushed — the author
   inspects and re-dispatches a follow-up task. This makes responsibility precise: nobody merges
   anyone else's work, and there is no author-side merge step to get out of order.
9. **Audit is a mandatory, independent second pass.** When every dev task is `dev-done`, the
   author runs `audit`: audit task(s) review the merged work with the OPPOSITE agent (another
   mind), covering production code, test meaningfulness (fake-data tests are a known failure
   mode), and — in `--edit` mode — rewriting meaningless tests with evidence and writing new
   ones. Verdict `audit-pass` (merged to dev) or `audit-fail` (branch + report pushed for the
   author). The batch is closed by the author's `archive` once every member is terminal.
10. **Liveness by PID, not by silence.** A task is dead only when its process group is gone. An
   executor fanning out sub-agents can legitimately emit nothing for 10+ minutes — never kill on
   "the stream went quiet". `cancel` kills the process group recorded in `state/<id>.pid`
   (SIGTERM, then SIGKILL after a 5 s grace window).

## The agents.js router

`runner` never calls a CLI directly. It delegates to `src/agents.js`:

```
invoke({ agent, mode, model, sessionId, prompt, cwd, attemptFile, sentinel, config })
  → { rc, sessionId, resetEpoch, sentinelHit, stderr }
```

- `<agent>` selects a **profile** (`claude` | `kimi`); each profile encapsulates four things:
  invocation flags, resume mechanics, session-id extraction from the stream, and usage-limit
  detection (including parsing the reset time). runner sees no CLI differences.
- The CLI's stream-json goes to stdout verbatim (captured as `attempt-<n>.jsonl`) and is parsed
  **line by line** while streaming — the bash-era text greps are gone. Session ids come from the
  profile-specific event (claude: the opening `system` event; kimi: the `meta`
  `session.resume_hint` event).
- **Exit-code contract** — this is the interface runner's resilience loop is built on:
  - `0` — normal exit (check for the `TASK_DONE` sentinel)
  - `75` — usage/session limit hit (park until reset, then resume)
  - anything else — ambiguous (bounded retry with backoff; after repeated ambiguous exits the
    runner drops the session and does one clean fresh run; past the hard cap it aborts as `failed`)

Adding a new executor CLI = adding one profile to agents.js. Nothing else changes.

## Process model (replaces tmux)

- dispatch spawns each runner with `spawn(node, [cli, run, id, --repo, repo], {detached: true})`.
  A detached child becomes a session/process-group leader: its pid **is** its pgid, so
  `kill(-pid, SIGTERM)` reaps the runner, its limit-park `sleep`, and the coding-agent CLI child
  in one shot. The tick `unref()`s the child — the watchdog never waits on the multi-hour run.
- The runner writes its own logs (run.log), the agent streams (`attempt-*.jsonl`), and the
  session id itself; `schedule-task log <id> -f` tails the run log, replacing `tmux attach`.
- Concurrency is enforced by the tick (`FL_MAX_CONCURRENCY`) plus the `running` state flags; the
  per-repo pid lock makes the launch decision single-writer, so two overlapping ticks (or two
  watchdog daemons) can never double-launch the same task. `watchdog start` itself refuses to
  run a second daemon for the same repo (`state/.watchdog.pid`).

## Install topology: three-layer separation

How the code is shipped (independent of the trigger/driver layers above) — see
[`docs/refactor-three-layer-separation.md`](../docs/refactor-three-layer-separation.md):

| Layer | Content | Where | Updated by |
|---|---|---|---|
| Knowledge | SKILL.md, references/, templates/ (**zero code**) | each agent's `skills/schedule-task` — copied from the global CLI package, whole-dir overwrite | `schedule-task install` |
| Tool | the whole CLI (`bin/`+`src/` **plus the knowledge three**) | **one** npm-global install per machine — a self-contained tarball copy, never a symlink (`npm install -g`) | `install.sh` |
| Data | `.schedule-tasks-data/` (tasks/prompts/reports/batches/state/hooks + `version`) | per project, committed with git | CLI (`init`/`migrate`) + task runs |

Three separate chains, no `update` subcommand: **install** (`install.sh` → global CLI) and
**bind** (`schedule-task install` → knowledge copies) are two distinct steps, and both are
refreshed by re-running themselves (install.sh replaces the global CLI; install whole-dir
overwrites the skill dirs, cleaning any old-form code residue). The knowledge source is the
global package itself — `install` needs no network and no clone.

**Program version vs data schema.** `package.json` version (`CLI vX`) bumps on any code change;
`.schedule-tasks-data/version` (`data schema vY`) is the envelope/prompt/report/state format
contract and bumps only when those formats change. The rule in `src/core.js` (`schemaCheck`):
data < CLI → read commands warn, write commands (`run`/`audit`/`cancel`/`archive`) hard-stop
until `schedule-task migrate`; data > CLI → refuse everything (upgrade the CLI). `migrate`
(`src/migrate.js`) is deterministic: commit first, run, rollback = git revert.

**Running-task isolation.** `bin/schedule-task.js` preloads every `src/*.js` module at startup,
so an `install.sh` replacing files mid-run can never mix old and new code inside a live process
(Node `require` is runtime, so without preloading, late requires would read replaced files).
