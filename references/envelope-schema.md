# Envelope schema — `.schedule-tasks-data/tasks/<id>.json`

One JSON file per task. The filename IS the id: `tasks/<id>.json` must contain `"id": "<id>"`.
Every field below is read by exactly one consumer (or none); adding unknown fields is harmless but
pointless — nothing forwards them.

**id convention** (batches and tasks, unified): `<B|T><YYMMDD>-<seq>-<tag>` — `B` = batch,
`T` = task; `YYMMDD` = year+date; `seq` = two-digit counter (`01`, `02`, …; batches: the day's
batch number, tasks: position within the batch ≈ dependency order); `tag` = topic. Examples:
batch `B260805-01-combat-improvement`, tasks `T260805-01-formation`, `T260805-02-combat`. A task
belongs to its batch via the `batch` field (the full batch id), never via the id prefix.

## Field table

| Field | Required | Consumed by | Semantics |
|---|---|---|---|
| `id` | yes | dispatch, runner, status | Task identity. Must equal the envelope filename (minus `.json`). Used for state files, logs, report name, and the `[[TASK_DONE <id> ...]]` sentinel. |
| `type` | yes | label only | `dev` \| `test` \| `audit`. A routing/report label shown by status; changes no behavior. |
| `worker` | no | dispatch (eligibility) | Which machine executes the task: the machine id configured at `init` in `.schedule-tasks-data/state/.machine` (default hostname). dispatch only launches tasks whose `worker` equals its own id. **Absent = any worker may take it** (single-worker setups can ignore it). A batch may split its tasks across several workers — each runs its own branches in parallel; merging is always the author's. |
| `repo` | no | **no command reads it** | Human/documentation label for the target repo path. Kept for provenance only — the runner always operates on the repo the dispatcher lives in. |
| `branch` | yes | runner, status, merge-batch | The task's own branch, e.g. `automation/<id>`. The runner cuts/reuses it from the local inbox-branch tip inside an isolated git worktree, commits results there, and pushes it. One branch per task — never `main`/`dev`. (The `automation/` prefix is kept for continuity with in-flight tasks; it is unrelated to the data dir name.) |
| `prompt_file` | yes | runner | Repo-relative path to the plan-harness prompt, resolved **inside the worktree** — so it must be committed to the inbox branch before dispatch, not just present on the author's disk. Default convention: `.schedule-tasks-data/prompts/<id>.md`. |
| `schedule.run_at` | yes | dispatch | ISO-8601 UTC one-shot (e.g. `2026-08-05T02:00:00Z`). The task is eligible once `now >= run_at`. One-shot only — recurring `cron` schedules are not supported. |
| `model` | no | runner | CLI-specific model alias passed to the executor (e.g. `opus`). Meaning depends on the `agent` profile. Defaults to the profile's built-in default when absent. |
| `agent` | no | runner → agents.js | Which coding-agent CLI executes the task: `"claude"` (default when absent) or `"kimi"`. runner routes the prompt through `agents.invoke(...)`; see `references/architecture.md`. |
| `batch` | no | status (grouping), merge-batch (finalization) | The full batch id (see convention above) of the batch this task belongs to. Tasks sharing a `batch` are a unit: status groups them; the author's `merge-batch` lands all done branches on `merge_target` together. Absent = single-task batch. |
| `depends_on` | no | dispatch (eligibility) | Array of task ids that must all be in state `done` before this task is eligible, regardless of `run_at`. Absent/empty = no dependencies. |

Backwards compatibility: an old envelope with none of `batch` / `worker` / `depends_on` / `agent`
behaves as a single-task batch with no dependencies and no machine assignment (any worker), on
the `claude` profile — semantics unchanged. Old envelopes whose `prompt_file` still points at
`automation/...` are rewritten by `schedule-task init`'s migration.

## Batch manifest — `.schedule-tasks-data/batches/<batch>.json`

Committed to git (author-side durable record); created only when a pass authors more than one
task. Read by the author's merge-batch for finalization and by status for grouped rendering.

```json
{
  "id": "B260805-01-combat-improvement",
  "title": "combat improvement — formation, combat, retreat",
  "notes": "formation must land before combat touches the same config",
  "tasks": ["T260805-01-formation", "T260805-02-combat", "T260805-03-retreat"],
  "merge_target": "dev"
}
```

| Field | Semantics |
|---|---|
| `id` | The batch id — equals the `batch` field on each member envelope. Filename is `<id>.json`. |
| `title` | Short human label, shown in status output. |
| `notes` | Free text. Also surfaced by status. |
| `tasks` | Member task ids **in dependency order** — the author's merge-batch lands their branches in this order. |
| `merge_target` | Branch the author's merge-batch lands the finished batch onto (default/typical `dev`). |

Finalization is the **author's** job: `schedule-task merge-batch <id>` fetches origin, merges
every task branch whose committed report says `(done)` onto `merge_target` in `tasks` order, and
pushes. Workers never merge.

## State files — `.schedule-tasks-data/state/` (gitignored, worker-local)

- `.machine` — the machine identity written by `init`: `role=author|worker` + `id=<machine-id>`
  (default hostname). The watchdog exits immediately unless `role=worker`; envelope `.worker` is
  matched against `id`. status uses it for mode detection.
- `state/<id>` — the first line is the state word. This contract is load-bearing (status and
  archive parse it): `pending` (implicit — no file exists), `running`, `done`, `failed`,
  `cancelled` (via cancel).
- `state/<id>.notes` — append-only free text. runner appends one timestamped line at each
  milestone (start, every attempt, limit-wait, done, failed); cancel appends the cancel reason.
  Humans may append lines too. Never edited in place, never truncated by the runtime.
- `state/<id>.pid` — the detached runner's pid (== its process-group id). The watchdog writes it
  at launch; cancel kills `-pid` to stop a running task. Stale pids are detected via signal 0.
- `state/.watchdog.pid` — the resident watchdog daemon's pid (written by `watchdog start` and by
  the daemon itself; `watchdog stop` clears it; `watchdog status` probes it via signal 0).
- `state/.watchdog.status` — JSON with `{startedAt, lastCheckAt, lastResult, launched, ticks}`;
  the daemon rewrites it after every check, so `watchdog status` works even without the process.
- `state/.dispatch.lock` — the per-tick pid lock (atomic `wx` create + stale detection).
  Replaces the old `flock` dependency; per-repo, so several projects' watchdogs on one machine
  never serialize each other.

Because `state/` is gitignored, it never crosses the git bus: the author box infers state from
the committed `reports/<id>.md` on each task branch — read locally after a merge, or directly
from `origin/<branch>` via status (see `references/operations.md`).
