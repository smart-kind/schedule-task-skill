# Task — <title>              ($id, $type)

## Mission
<the outcome and why — one short paragraph>

## References
- Plan / spec: <path or "none">
- Relevant code / docs: <paths>

## Knowledge graph (graphify — optional, saves tokens)
- Before starting real work, refresh the graph if `graphify-out/graph.json` exists:
  - `graphify update` refreshes **code nodes only** — free, deterministic, always safe to run.
  - If docs/papers/images are in scope (or changed since the last build), ALSO run the full
    incremental via the graphify skill: `/graphify --update` — it re-extracts changed code AND
    docs; the assistant itself is the LLM for the semantic (doc) pass. `graphify update` prints
    this same tip ("For doc/paper/image changes run /graphify --update").
  - `graphify` missing → skip (optional) or install once per machine: `uv tool install graphifyy`.
- Answer code/doc questions through the graph instead of grepping the repo:
  `graphify query "<question>"` (BFS context), `graphify path "A" "B"` (shortest path between
  two concepts), `graphify explain "<Node>"` (plain-language node explanation). Quote
  `source_location` when citing a specific fact. This is roughly an order of magnitude cheaper
  than reading source files.
- Never edit `graphify-out/` — it is generated.

## Execution protocol
- <e.g. fan out one implementer sub-agent per work item + one INDEPENDENT strict reviewer
   (never the implementer); loop implement → review until the reviewer passes every acceptance
   item — "差不多 / good enough" counts as fail>
- Work in small increments; commit at each checkpoint.

## Acceptance gates  (natural language — YOU discover the concrete commands for this repo)
- <gate 1, e.g. "the full test suite passes">
- <gate 2, e.g. "browser smoke run has no console errors">

## Guardrails
- Branch: <branch — the task's own `automation/<id>` branch, cut from the inbox branch by the
  runner>. Never touch main. Commit cadence: <...>.
- Architecture invariants: <...>.
- Batch (optional): Batch: <batch-id>; this task depends on <ids, or "nothing">; do not merge
  sibling branches yourself — you commit and push only your own branch; the AUTHOR merges all
  batch branches when the whole batch is done.

## Progress & checkpoints
- Emit `[[CHECKPOINT $id <step>]]` after each completed step.
- When ALL gates pass: commit, then print exactly `[[TASK_DONE $id commit=<sha>]]`.

## If interrupted and resumed
- Re-read THIS file and the latest commit on <branch>. Continue from the last checkpoint.
- Do NOT redo or revert already-committed work.
