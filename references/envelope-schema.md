# Envelope schema — `automation/tasks/<id>.json`

One JSON file per task. The filename IS the id: `tasks/<id>.json` must contain `"id": "<id>"`.
Every field below is read by exactly one consumer (or none); adding unknown fields is harmless but
pointless — nothing forwards them.

## Field table

| Field | Required | Consumed by | Semantics |
|---|---|---|---|
| `id` | yes | dispatch.sh, run-task.sh, status.sh | Task identity. Must equal the envelope filename (minus `.json`). Used for state files, logs, tmux session name (`task-<id>`), report name, and the `[[TASK_DONE <id> ...]]` sentinel. |
| `type` | yes | label only | `dev` \| `test` \| `audit`. A routing/report label shown by status.sh; changes no behavior. |
| `repo` | no | **no script reads it** | Human/documentation label for the target repo path. Kept for provenance only — the runner always operates on the repo the dispatcher lives in. |
| `branch` | yes | run-task.sh | The task's own branch, e.g. `automation/<slug>`. The runner cuts/reuses it from the local inbox-branch tip inside an isolated git worktree, commits results there, and pushes it. One branch per task — never `main`/`dev`, and the shared `automation/dev` convention is dead. |
| `prompt_file` | yes | run-task.sh | Repo-relative path to the plan-harness prompt, resolved **inside the worktree** — so it must be committed to the inbox branch before dispatch, not just present on the author's disk. |
| `schedule.run_at` | yes | dispatch.sh | ISO-8601 UTC one-shot (e.g. `2026-08-05T02:00:00Z`). The task is eligible once `now >= run_at`. One-shot only — recurring `cron` schedules are not supported. |
| `model` | no | run-task.sh | CLI-specific model alias passed to the executor (e.g. `opus`). Meaning depends on the `agent` profile. Defaults to the profile's built-in default when absent. |
| `agent` | no | run-task.sh → coding-agent.sh | Which coding-agent CLI executes the task: `"claude"` (default when absent) or `"kimi"`. run-task.sh routes the prompt through `coding-agent.sh <agent> ...`; see `references/architecture.md`. |
| `batch` | no | dispatch.sh (grouping/merge), status.sh (grouping) | Shared batch prefix, conventionally `YYYY-MM-DD-<batch>` — the common prefix of the batch's task ids. Tasks with the same `batch` are merged into `merge_target` together when all are `done`. Absent = single-task batch. |
| `depends_on` | no | dispatch.sh (eligibility) | Array of task ids that must all be in state `done` before this task is eligible, regardless of `run_at`. Absent/empty = no dependencies. |

Backwards compatibility: an old envelope with none of `batch` / `depends_on` / `agent` behaves as
a single-task batch with no dependencies on the `claude` profile — semantics unchanged.

## Batch manifest — `automation/batches/<batch>.json`

Committed to git (author-side durable record); created only when a pass authors more than one
task. Read by dispatch.sh for batch finalization and by status.sh for grouped rendering.

```json
{
  "id": "2026-08-05-p0805",
  "title": "P0805 formation + retreat rework",
  "notes": "free text — why these tasks belong together, ordering caveats",
  "tasks": ["2026-08-05-p0805-formation", "2026-08-05-p0805-retreat"],
  "merge_target": "dev"
}
```

| Field | Semantics |
|---|---|
| `id` | The batch id — equals the `batch` field on each member envelope. Filename is `<id>.json`. |
| `title` | Short human label, shown in status output. |
| `notes` | Free text. Also surfaced by status.sh. |
| `tasks` | Member task ids **in dependency order** — the dispatcher merges their branches in this order. |
| `merge_target` | Branch the finished batch merges into (default/typical `dev`). |

## State files — `automation/state/` (gitignored, worker-local)

- `state/<id>` — the first line is the state word. This contract is load-bearing (status.sh and
  archive-task.sh parse it): `pending` (implicit — no file exists), `running`, `done`, `failed`,
  `cancelled` (via cancel-task.sh).
  Batch-level merge states live on a synthetic id: `state/batch-<batch>` can be `merged`,
  `merge-conflict`, or `cancelled` (every member task cancelled — nothing to merge).
- `state/<id>.notes` — append-only free text. run-task.sh appends one timestamped line at each
  milestone (start, every attempt, limit-wait, done, failed); dispatch.sh appends batch-merge
  outcomes; cancel-task.sh appends the cancel reason. Humans may append lines too. Never edited
  in place, never truncated by the runtime.

Because `state/` is gitignored, it never crosses the git bus: the author box infers state from
committed `reports/<id>.md` + `tasks/` presence instead (see `references/operations.md`).
