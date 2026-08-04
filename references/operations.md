# Operations

Running and babysitting a live schedule-task system. Read this when something is scheduled,
running, or stuck.

## Status: worker vs author mode

`bash automation/status.sh` is the single read-only entry point. It auto-detects what the current
machine can know (force with `FL_MODE=worker|author`):

- **Worker mode** (the VPS): live truth. Reads `automation/state/<id>` flags and
  `~/.local/state/automation/<id>/run.log`. Shows live detail for running tasks: attempt count,
  start time, latest `[[CHECKPOINT …]]` marker.
- **Author mode** (your laptop after `git pull`): committed truth only. `state/` is gitignored,
  so state is inferred from `reports/<id>.md` (the H1 encodes `done|failed`) plus presence in
  `tasks/`. A task mid-run reads as `pending` here — that is correct, not a bug: the author box
  only knows the last committed truth.

Output is grouped by batch: a batch header (title, notes, `x/y done` progress, next eligible
task), one row per member task with its trailing notes lines, and ungrouped legacy tasks under
`(ungrouped)`. It ends with a counts line (`N done · N failed · N running · N pending · N archived`).
`bash automation/status.sh --self-test` fabricates a throwaway tree and verifies the reporter.

## Where things live

| What | Path |
|---|---|
| Task inbox (committed) | `automation/tasks/<id>.json` (+ `tasks/archive/`) |
| Prompts (committed) | `automation/prompts/<id>.md` (+ `prompts/archive/`) |
| Reports (committed, durable) | `automation/reports/<id>.md` |
| Batch manifests (committed) | `automation/batches/<batch>.json` |
| Live state (worker-local, gitignored) | `automation/state/<id>`, `automation/state/<id>.notes`, `automation/state/batch-<batch>` |
| Per-task run log (worker) | `~/.local/state/automation/<id>/run.log` |
| Raw executor streams (worker) | `~/.local/state/automation/<id>/attempt-<n>.jsonl` |
| Persisted CLI session id (worker) | `~/.local/state/automation/<id>/session_id` |
| Task worktrees (worker) | `~/.local/state/automation/worktrees/<id>` |
| Dispatcher log (worker) | `automation/dispatch.log` (written by the cron line's redirect) |

## Watching a task live

On the worker:

```
tmux attach -t task-<id>        # live pane of the runner (detach: Ctrl-b d)
tail -f ~/.local/state/automation/<id>/run.log
cat automation/state/<id>.notes # milestone timeline, one timestamped line each
```

The notes file is the fastest answer to "what has this task been doing": start, every attempt,
limit-park durations, final state. `state/batch-<batch>` (`merged` / `merge-conflict`) plus its
notes tell you how batch finalization went.

## When a task is stuck

**Task is `failed` after ambiguous exits.** The runner aborts after a bounded number of exits
that were neither done nor a usage limit. Diagnose from the run log and the last
`attempt-*.jsonl`. To re-drive:

1. Fix the cause — usually on the task branch (bad prompt assumption, broken base commit).
2. Delete the state file: `rm automation/state/<id>` (and optionally archive the old
   `state/<id>.notes`). No state file = `pending` again.
3. Wait for the next dispatch tick (≤ 5 min). The existing worktree is reused, so committed work
   is not lost; if the worktree itself is corrupt, remove
   `~/.local/state/automation/worktrees/<id>` too for a clean cut.

**Task stuck `running` but nothing is alive** (e.g. worker rebooted mid-task): same re-drive —
delete the state file, next tick relaunches; the persisted session id lets the runner resume with
context.

**Batch flagged `merge-conflict`.** All member tasks finished, but merging their branches into
the merge target conflicted, so the dispatcher aborted the merge and flagged it. Nothing retries
this automatically. Resolve by hand (or hand it to an agent): merge the member branches
(locally or on the worker) in the manifest's dependency order, push, then set
`automation/state/batch-<batch>` to `merged` so status stops flagging it. The member task states
stay `done` — only the landing step failed.

**Task keeps hitting usage limits.** That's normal operation, not a fault: the runner parks until
the reset time and resumes the same session. Expect `limit-wait` lines in notes and gaps in the
run log. Worry only if attempts accrue *without* limit lines.

**Never kill a task because its pane went quiet.** An executor fanning out sub-agents can be
silent for 10+ minutes. A task is dead only when its process is gone (`tmux ls`, `ps`). When you
really do want it dead, use `cancel-task.sh` (below) — never `tmux kill-session` by hand, which
would leave the state file stuck at `running`.

## Cancelling tasks

```bash
bash automation/cancel-task.sh <id> [reason...]     # one task
bash automation/cancel-task.sh --all [reason...]    # every pending + running task
```

- **Pending** task: state set to `cancelled`, the dispatcher skips it from then on.
- **Running** task: its tmux session is killed — runner, limit-park `sleep`, and the
  coding-agent CLI child all die with the pane, so this works even mid limit-wait.
- **Cascade**: active tasks whose `depends_on` chain includes a cancelled id are cancelled too
  (they could never become eligible); the notes line names the root cause.
- Terminal tasks (`done`/`failed`/`cancelled`) are refused. The worktree
  (`~/.local/state/automation/worktrees/<id>`) is left in place — inspect, then delete by hand.
- Batch interplay: a batch whose tasks are all terminal still merges the **done** branches
  (cancelled ones are skipped); an all-cancelled batch is flagged `cancelled`, no merge.
- Worker-only (needs live `state/` + tmux). To un-cancel: `rm automation/state/<id>` → the task
  is `pending` again at the next tick.

## Notifications: hooks/notify.sh

`automation/hooks/notify.sh` is the extension point for push notifications. It ships as a no-op
(`exit 0`) and is called by run-task.sh / dispatch.sh only when it exists and is executable:

```
hooks/notify.sh <event> <task-id> <message>
```

Events: `started`, `attempt`, `limit-wait`, `done`, `failed`, `merged`, `merge-conflict`,
`cancelled`.

Replace the body with whatever delivery you want — e.g. a mattermost CLI call:

```bash
#!/usr/bin/env bash
event="$1"; id="$2"; msg="$3"
mattermost-channel-cli send --channel automation "[$event] $id — $msg"
exit 0
```

Keep it fast and failure-tolerant: it runs inside the dispatcher/runner path, so it must never
hang or exit non-zero (that would poison the caller's control flow).

## Housekeeping

- **Retire finished tasks** with `bash automation/archive-task.sh <id>` — moves envelope + prompt
  into `tasks/archive/` and `prompts/archive/`, refuses anything not `done` or `cancelled`.
  Reports stay put.
- **Concurrency** is `FL_MAX_CONCURRENCY` (default 2) in the dispatcher's environment;
  `FL_MAX_CONCURRENCY=1` reproduces the old fully-serial behavior.
- **`git pull --rebase` conflicts on the worker** should be impossible by the add-only design; if
  one happens the dispatcher logs and skips the tick rather than forcing anything. Investigate
  what non-add-only change crossed the bus.
