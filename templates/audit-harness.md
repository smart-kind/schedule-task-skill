# Audit — <title>            ($id, $type=audit, mode=$mode)

> MUST read `templates/harness-common.md` first — it is a binding constraint on
> this plan (knowledge graph, execution protocol, TEST_HEADER convention, resume).

## Mission
Independently audit the completed development task(s). You are a DIFFERENT mind
from the developer: do not assume the developer's code or tests are correct. The
purpose is quality — code review, test meaningfulness, and a clear verdict.

## Scope
- Batch: <batch-id>; granularity: <per-task | batch>
- Dev task(s) under audit: <dev-ids>
- For each: read the dev report `.schedule-tasks-data/reports/<dev-id>.md` — the
  commit SHAs listed there are your review scope.
- Diff to review: the listed SHAs in `<inbox>` history
  (`git log <inbox>` / `git show <sha>`), i.e. the merged dev commits.

## Review checklist
1. **Production code** — correctness against the acceptance gates' intent,
   architecture invariants, edge cases, security. Fan out independent reviewer
   sub-agents with different perspectives; never the developer's view.
2. **Existing test meaningfulness** — the developer's tests: do they test REAL
   behavior? Watch for the classic failure: tests that pass but use fake data or
   assert nothing meaningful, so the behavior is broken while the suite is green.
   Classify each existing test: meaningful / meaningless. Unscoped test files
   (no TEST_HEADER) get a header inferred from their first lines.
3. Test policy per mode below.

## Test policy ($mode)
- READONLY: you may NOT write new tests and may NOT modify existing tests. Run
  the repo's full suite as the baseline — it must pass. Report findings on
  meaningless tests, change nothing.
- EDIT: you MAY rewrite/remove meaningless existing tests and write NEW tests
  from your own angle. Rules:
  * Record the baseline suite result (before any of your changes) in the report.
  * Every existing test you rewrite or remove is a FIRST-CLASS finding with
    evidence (e.g. "this test passes while the behavior is broken — reproduce").
  * New tests follow the TEST_HEADER convention and must pass.
  * NEVER modify production code.

## Verdict & report (REQUIRED)
Write `.schedule-tasks-data/reports/<id>.md`:
- First line: `# Report — <id> (audit-pass)` or `(audit-fail)`
- Scope reviewed (commits/SHAs)
- Findings by severity (blocking / major / minor), each with evidence
- Test assessment: baseline suite result, existing-test findings, new tests added
- Verdict: `audit-pass` or `audit-fail`
Commit the report on your branch.

## Merge protocol
- audit-pass: your branch lands on `<inbox>` (dev) the same way the dev merge
  protocol does: fetch, rebase/merge `origin/<inbox>` into your branch, re-run
  the relevant gates, commit (your added tests + report). Do NOT push on
  success — the runner fast-forwards `<inbox>`, pushes, and cleans up. Then
  print `[[TASK_DONE $id commit=<sha>]]`.
- audit-fail: DO NOT merge. Commit everything on your branch, `git push origin
  <branch>`, and end FAILED — do NOT print `[[TASK_DONE]]`. The author reviews
  your findings and re-dispatches.
