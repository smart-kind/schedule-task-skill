# graphify — optional knowledge-graph integration

## What it is

[graphify](https://github.com/safishamsi/graphify) turns the repo into a queryable knowledge
graph. Code files are extracted structurally via AST (free, deterministic); docs/papers/images
are extracted semantically (LLM). Output lives in `graphify-out/` (`graph.json` + `graph.html` +
`GRAPH_REPORT.md` + a semantic `cache/`).

It is **optional** — schedule-task's only hard dependencies are node + git. Its value: a task
executor answers code/doc questions with `graphify query` instead of reading source files,
which the built-in token benchmark measures at roughly **8x fewer tokens** per question.

## Env check & install (per machine — author and worker)

`schedule-task init` and `schedule-task doctor` check for the `graphify` binary on PATH and
print an install hint when it is missing. The check is informational — graphify being absent
never makes the runtime fail.

Install once per machine. The CLI is agent-agnostic — the same commands work under Kimi Code,
Claude Code, Codex, etc.:

- with uv: `uv tool install graphifyy`
- with pip: `pip install graphifyy`

Verify: `graphify --help`. Optional richer semantic extraction (docs/papers/images) uses Gemini
when `GEMINI_API_KEY` / `GOOGLE_API_KEY` is set; without a key the host agent does the semantic
pass itself — never block on a missing key.

## Refresh before task work

The plan-harness template (`templates/plan-harness.md`) instructs every executor:

1. Before starting real work, refresh the graph if the repo has one:
   `graphify update` — refreshes **code nodes only** (incremental, no LLM needed, always safe).
   When docs/papers/images are in scope or changed, ALSO run the full incremental via the
   graphify skill: `/graphify --update` — it re-extracts changed code AND docs; the host agent
   is the LLM for the semantic pass (the CLI prints this same tip after `graphify update`).
2. During the run, answer code/doc questions with `graphify query "<question>"` /
   `graphify path "A" "B"` / `graphify explain "<Node>"`, quoting `source_location` for facts.
3. Never edit `graphify-out/` — it is generated.

## Commit policy for graphify-out/

Commit the core so a worker can query the graph right after `git fetch`, without rebuilding:

- `graph.json` — the graph
- `GRAPH_REPORT.md` — audit report (god nodes, communities, suggested questions)
- `manifest.json` — incremental-update baseline (`graphify update` diffs against it)
- `cache/` — semantic extraction cache; re-hitting it on workers avoids re-paying LLM
  extraction tokens

Ignore the regenerable / machine-local files (already covered by the repo `.gitignore`):

- `graph.html` — large, regenerable snapshot; paths are relative to the machine that built it,
  so regenerate per machine
- `cost.json`, `.graphify_*` temp files — per-run accounting / local state

`graph.html` is the one thing to regenerate on each machine (it embeds repo-relative paths):
`graphify export html`, or `graphify cluster-only .` to rebuild everything from an existing
`graph.json`.
