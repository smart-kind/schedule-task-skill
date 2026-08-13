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
| `type` | yes | label only | `dev` (legacy `audit` / `test` labels still parse). A routing/report label shown by status; changes no behavior. |
| `worker` | no | dispatch (eligibility) | Worker profile id (e.g. `W01`). The profile's `agent` and per-stage `models` are resolved at dispatch time. dispatch matches against `.machine` id. **Absent = any worker may take it**. |
| `repo` | no | **no command reads it** | Human/documentation label for the target repo path. Kept for provenance only — the runner always operates on the repo the dispatcher lives in. |
| `branch` | yes | runner, status | The task's own branch, e.g. `automation/<id>`. The runner cuts/reuses it from the local inbox-branch tip inside an isolated git worktree, commits results there. It is a disposable workspace: on success the runner fast-forwards `dev` to it and deletes worktree + branch; on failure it is pushed for the author. One branch per task — never `main`/`dev`. (The `automation/` prefix is kept for continuity with in-flight tasks; it is unrelated to the data dir name.) |
| `prompt_file` | yes | runner | Repo-relative path to the plan-harness prompt, resolved **inside the worktree** — so it must be committed to the inbox branch before dispatch, not just present on the author's disk. Default convention: `.schedule-tasks-data/prompts/<id>.md`. |
| `schedule.run_at` | yes | dispatch | ISO-8601 UTC one-shot (e.g. `2026-08-05T02:00:00Z`). The task is eligible once `now >= run_at`. One-shot only — recurring `cron` schedules are not supported. |
| `model` | no | runner | CLI-specific model alias passed to the executor (e.g. `opus`). Resolved from the worker profile's `models.dev` when the envelope omits it. |
| `agent` | no | runner → agents.js | Which coding-agent CLI executes the task: `"claude"` or `"kimi"`. Resolved from the worker profile when the envelope omits it. runner routes the prompt through `agents.invoke(...)`; see `references/architecture.md`. |
| `batch` | no | status (grouping), archive (current batch) | The full batch id (see convention above) of the batch this task belongs to. Tasks sharing a `batch` are a unit: status groups them; `archive` closes the whole batch. Absent = single-task batch. |
| `depends_on` | no | dispatch (eligibility) | Array of task ids that must all be in state `done` before this task is eligible, regardless of `run_at`. Absent/empty = no dependencies. |

Backwards compatibility: an old envelope with none of `batch` / `worker` / `depends_on` / `agent`
behaves as a single-task batch with no dependencies and no machine assignment (any worker), on
the `claude` profile — semantics unchanged. Old envelopes whose `prompt_file` still points at
`automation/...` are rewritten by `schedule-task init`'s migration.

## Batch manifest — `.schedule-tasks-data/batches/<batch>.json`

Committed to git (author-side durable record); created only when a pass authors more than one
task. Read by `archive` (batch close-out) and by status for grouped rendering. The current batch
= the newest non-archived manifest (the system runs one batch at a time).

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
| `tasks` | Member task ids **in dependency order**. |
| `merge_target` | Legacy: kept for compatibility, no longer consumed — workers merge their own work to the inbox branch (default `dev`) directly. |

Batch lifecycle is author-driven: `archive` closes the batch once every member is terminal
(moves the manifest + envelopes + prompts to `archive/`, writes the batch summary report, and
empties the current batch).

## State files — `.schedule-tasks-data/state/` (gitignored, worker-local)

- `.machine` — the machine identity written by `init`: `role=author|worker` + `id=<machine-id>`
  (default hostname). The watchdog exits immediately unless `role=worker`; envelope `.worker` is
  matched against `id`. status uses it for mode detection.
- `state/<id>` — the first line is the state word. This contract is load-bearing (status and
  archive parse it): `pending` (implicit — no file exists), `running`, `done`,
  `merge-failed`, `failed`, `cancelled`. Back-compat aliases normalise legacy state words:
  `dev-done` → `done`, `audit-pass` → `done`, `audit-fail` → `failed`.
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
the committed `reports/<id>.md` **merged to the inbox branch (`dev`)** — read locally after a
pull, or directly from `origin/<inbox>` via status (see `references/operations.md`).

## Data schema version — `.schedule-tasks-data/version` (committed)

The data-format contract. A single integer, written by `init` (fresh installs) and upgraded by
`schedule-task migrate`; it rides git with the data (never inside `state/`). It is **not** the
package version — `package.json` bumps on any code change, this file only when the envelope /
prompt / report / state formats change.

The rule (`src/core.js` `schemaCheck`, compared against the CLI's compile-time `SCHEMA_VERSION`):

- data **<** CLI → legacy/stale: `status`/`doctor` warn and keep working; write commands
  (`run`/`cancel`/`archive`) hard-stop with a hint to run `schedule-task migrate`.
- data **>** CLI → the CLI is too old to read the data safely: refuse and upgrade the CLI
  (re-run install.sh).
- equal → normal operation.

`migrate` is deterministic (no AI) — commit the current state first, run it, and rollback is a
git revert. v0 (unversioned, pre-3.1.0) → v1 only stamps the version file; the formats
themselves did not change in that release. v1 → v2 (3.3.0) simplifies state words (`dev-done` →
`done`, audit states removed) and adds `workers.json`; back-compat aliases handle old state
files transparently.

## Workers profile — `.schedule-tasks-data/workers.json` (committed)

A JSON file listing available workers, each with an id, name, agent platform, and per-stage
model configuration. Read by the author during dispatch (worker selection) and by the runner
(model resolution).

```json
{
  "workers": [
    {
      "id": "W01",
      "name": "kimi-130",
      "agent": "kimi",
      "models": {
        "dev": "K3",
        "review": "K3",
        "mutation": "K3",
        "test": "K3"
      }
    }
  ]
}
```

| Field | Semantics |
|---|---|
| `id` | Worker id (W01, W02…). Matches the envelope's `worker` field and the `.machine` id on the worker box. |
| `name` | Human-readable label (e.g. `kimi-130`, `cc-opus`). |
| `agent` | Coding-agent CLI: `kimi` or `cc` (→ mapped to `claude` internally). |
| `models` | Per-stage model aliases. Stages: `dev`, `review`, `mutation`, `test`. The runner uses `models.dev` as the primary model. |

Managed via `schedule-task profile` subcommands (list / add / edit / remove).
