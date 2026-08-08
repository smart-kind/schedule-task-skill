# graphify — optional knowledge-graph integration

## What it is

[graphify](https://github.com/safishamsi/graphify) turns the repo into a queryable knowledge
graph. Code files are extracted structurally via AST (free, deterministic); docs/papers/images
are extracted semantically (LLM). Output lives in `graphify-out/` (`graph.json` + `graph.html` +
`GRAPH_REPORT.md` + a semantic `cache/`).

It is **optional** — schedule-task's only hard dependencies are node + git. Its value: a task
executor answers code/doc questions with `graphify query` instead of reading source files,
which the built-in token benchmark measures at roughly **8x fewer tokens** per question.

## Detect-only behavior (the skill never installs it)

`schedule-task init` and `schedule-task doctor` only **detect** the `graphify` binary on PATH:

- present → reported `ok`; executors will save tokens (the plan-harness template activates the
  knowledge-graph section).
- absent → a `warn` row plus the install command is printed, and nothing else happens —
  graphify being absent never fails the runtime, and the skill never downloads or installs it.

The detection is exactly one check: is `graphify` on PATH? It does **not** check agent skill
directories, does **not** infer platforms, does **not** clone anything.

## Installing it (you do this once per machine, the skill does not)

### The binary

```bash
uv tool install graphifyy     # or: pip install graphifyy
```

Verify with `graphify --help`.

### The skill for Kimi Code / Claude Code

`graphify install --platform <p>` supports many agents but **not Kimi Code** (upstream lists
`kimi` — which targets `~/.kimi/skills/` — but there is no `kimi-code` entry). Kimi Code reads
skills from `~/.kimi-code/skills/`, a different directory from Kimi's `~/.kimi/skills/`. The
practical installs:

- **Claude Code**: `graphify install --platform claude` → `~/.claude/skills/graphify/`
- **Kimi Code**: install the Kimi variant first, then copy it over (both are real user-level
  copies; no symlinks):

```bash
graphify install --platform kimi                    # -> ~/.kimi/skills/graphify/ (complete: SKILL.md + references/)
cp -r ~/.kimi/skills/graphify ~/.kimi-code/skills/graphify
```

`graphify install` installs a complete skill for progressive platforms (SKILL.md + the
`references/` sidecar + a `.graphify_version` stamp), so copying the Kimi install gives Kimi
Code the same complete copy. Alternatively, clone the upstream repo (the repo root IS the
skill) and copy it into `~/.kimi-code/skills/graphify/`.

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
- `cost.json`, `.graphify_*` temp files, dated `graphify-out/20xx-xx-xx/` backups — per-run
  accounting / local state

`graph.html` is the one thing to regenerate on each machine (it embeds repo-relative paths):
`graphify export html`, or `graphify cluster-only .` to rebuild everything from an existing
`graph.json`.
