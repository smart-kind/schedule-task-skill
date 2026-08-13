# Shared task rules — READ THIS FILE FIRST (mandatory)

This file is part of every task prompt. Read it in full before starting — its
rules are binding constraints on the plan you generate.

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
- Work in small increments; commit at each checkpoint.
- Fan out sub-agents where it helps: one implementer per work item plus an
  INDEPENDENT strict reviewer (never the implementer); loop implement → review until the
  reviewer passes every acceptance item — "差不多 / good enough" counts as fail.
- The full chain (dev → mutation check → self-review → testing → report) is a single
  task. Complete each stage before moving to the next.

## TEST_HEADER convention (for tests you create)
Every test file you CREATE must start with a structured header block, in the repo's
comment syntax:

```
# TEST <filename> — <one-line purpose>
# SCOPE: <module / behavior under test>
# ENV:   <fixtures, fake data, dependencies, time/network assumptions>
# GATES: <what passing this test actually proves>
# RISK:  <when it could pass while the real behavior is broken (false success)>
```

Why: other agents (audits) must be able to decide in ~30 lines whether a test is in
their scope, without reading the whole file — and the RISK line makes fake tests
visible. A test file without this header is treated as "unscoped": readers infer its
purpose from the first lines and (in an edit audit) may add a header.

## Progress & checkpoints
- Emit `[[CHECKPOINT $id <step>]]` after each completed step.

## If interrupted and resumed
- Re-read THIS file, your harness, and the latest commit on your branch. Continue from the
  last checkpoint.
- Do NOT redo or revert already-committed work.
