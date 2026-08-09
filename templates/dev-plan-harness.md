# Task — <title>              ($id, $type=dev)

> MUST read `templates/harness-common.md` first — it is a binding constraint on
> this plan (knowledge graph, execution protocol, TEST_HEADER convention, resume).

## Mission
<the outcome and why — one short paragraph>

## References
- Plan / spec: <path or "none">
- Relevant code / docs: <paths>

## Acceptance gates  (natural language — YOU discover the concrete commands for this repo)
- <gate 1, e.g. "the full test suite passes">
- <gate 2, e.g. "browser smoke run has no console errors">

## Guardrails
- Branch: <branch> — your own `automation/<id>` branch, inside your task worktree.
  Never touch main. Commit cadence: <...>.
- Work in the task worktree only; your branch is an isolated workspace. You merge
  ONLY your own work (see the merge protocol below) — never anyone else's.
- Architecture invariants: <...>.
- Batch (optional): Batch: <batch-id>; this task depends on <ids, or "nothing">.

## Development report (REQUIRED before finishing)
You are a developer finishing a work item. When ALL acceptance gates pass, write
your development report to `.schedule-tasks-data/reports/<id>.md` — a developer's
handover summary, NOT a changelog dump:
- What was done: the feature/fix in one short paragraph, from the user's view.
- Files changed: the key files/dirs touched and why.
- Commits: `git log <inbox>..HEAD --oneline` — the audit will review exactly these SHAs.
- Gates verified: which acceptance gates you ran and their results.
- Tests: what you ran/wrote (with TEST_HEADER blocks); anything skipped or fragile.
- Caveats: known limitations, design decisions, and what the reviewer should
  scrutinize first.
Commit the report on your branch.

## Merge protocol (REQUIRED after the report is committed)
Your work lands on `<inbox>` (default dev) — YOU resolve the integration; the
runner does the mechanical fast-forward:
1. `git fetch origin`.
2. Rebase (or merge) `origin/<inbox>` into your branch. Resolve conflicts
   yourself — you wrote the code, the repo's tests are the referee. Never punt.
3. Re-run the acceptance gates on the integrated result — they must pass on the
   merged branch, not just your original work.
4. Commit the report (already done above). Do NOT push anything on success.
5. Print exactly `[[TASK_DONE $id commit=<sha>]]`. The runner then fast-forwards
   `<inbox>` to your branch, pushes it, and deletes your worktree + branch.

If you genuinely cannot resolve a merge conflict: DO NOT delete anything —
commit all work on your branch, `git push origin <branch>`, write the report
including the exact conflict details, and end FAILED (no `[[TASK_DONE]]`). The
author will re-dispatch against your branch.
