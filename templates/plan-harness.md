# Task — <title>              ($id, $type)

## Mission
<the outcome and why — one short paragraph>

## References
- Plan / spec: <path or "none">
- Relevant code / docs: <paths>

## Execution protocol
- <e.g. fan out one implementer sub-agent per work item + one INDEPENDENT strict reviewer
   (never the implementer); loop implement → review until the reviewer passes every acceptance
   item — "差不多 / good enough" counts as fail>
- Work in small increments; commit at each checkpoint.

## Acceptance gates  (natural language — YOU discover the concrete commands for this repo)
- <gate 1, e.g. "the full test suite passes">
- <gate 2, e.g. "browser smoke run has no console errors">

## Guardrails
- Branch: <branch — the task's own `automation/<slug>` branch, cut from the inbox branch by the
  runner>. Never touch main. Commit cadence: <...>.
- Architecture invariants: <...>.
- Batch (optional): Batch: <batch-id>; this task depends on <ids, or "nothing">; do not merge
  sibling branches yourself — the dispatcher merges when the whole batch is done.

## Progress & checkpoints
- Emit `[[CHECKPOINT $id <step>]]` after each completed step.
- When ALL gates pass: commit, then print exactly `[[TASK_DONE $id commit=<sha>]]`.

## If interrupted and resumed
- Re-read THIS file and the latest commit on <branch>. Continue from the last checkpoint.
- Do NOT redo or revert already-committed work.
