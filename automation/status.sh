#!/usr/bin/env bash
# status.sh — read-only status reporter for scheduled automation tasks (v2: batch-aware).
# Prints one row per task (active + archived) with its current state, derived from
# whatever signals the current machine actually has. It NEVER mutates anything.
#
# Environment auto-detect (the author asked for one command that adapts, not two):
#   - WORKER mode: automation/state/<id> live flags and ~/.local/state/automation/<id>/run.log
#     exist (the VPS that runs run-task.sh). Shows live running/attempt/checkpoint detail,
#     per-task notes tails (state/<id>.notes) and batch runtime state (state/batch-<id>).
#   - AUTHOR mode: only committed artifacts exist after `git pull` (state/ is gitignored).
#     State is inferred from reports/<id>.md (H1 encodes done|failed) + tasks/ presence.
#
# Batch grouping (envelope schema v2 — every new field optional, old envelopes unchanged):
#   - envelope "batch": "<id>" groups the task under batches/<id>.json, a committed
#     manifest {id,title,notes,tasks[],merge_target}; "depends_on": [ids] gates "next".
#   - Output: one "== batch <id> — <title> — x/y done, next: <id>" header per manifest
#     (x/y = done-count/total over the manifest's task list), the manifest notes line,
#     then member rows (indented 2, same columns) in manifest order; in worker mode a
#     task's last 2 state/<id>.notes lines follow its row prefixed "note:".
#   - Batch runtime state state/batch-<id> (one word: merged|merge-conflict, worker mode
#     only) shows in the header; merge-conflict also surfaces the last line of
#     state/batch-<id>.notes. Tasks without a batch manifest fall under "(ungrouped)",
#     rendered exactly like v1 flat rows; with no manifests at all the output is pure v1.
#   - STATE words come from the same task_row logic batched or not: live state in worker
#     mode, report-H1 inference in author mode, pending fallback.
#
# Overridable seams (used by --self-test and reusable on any box):
#   FL_AUTO_ROOT  root that contains tasks/ reports/ state/ batches/ (default: this script's dir)
#   FL_LOG_ROOT   per-task run-log root (default: ~/.local/state/automation)
#   FL_MODE       force 'worker' or 'author' (default: auto-detect)
set -uo pipefail

FL_AUTO_ROOT="${FL_AUTO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
FL_LOG_ROOT="${FL_LOG_ROOT:-$HOME/.local/state/automation}"
NOW="$(date -u +%s)"

# detect_mode — decide worker vs author from which runtime signals are present locally.
detect_mode() {
  [ -n "${FL_MODE:-}" ] && { echo "$FL_MODE"; return; }
  if ls "$FL_AUTO_ROOT"/state/* >/dev/null 2>&1 || [ -d "$FL_LOG_ROOT" ]; then
    echo worker
  else
    echo author
  fi
}

# reltime — render a signed epoch delta from NOW as a coarse "in 3h" / "2d ago" string.
reltime() {
  local t="$1" d a u
  d=$(( t - NOW )); a=${d#-}
  if   [ "$a" -lt 3600 ];  then u="$((a/60))m"
  elif [ "$a" -lt 86400 ]; then u="$((a/3600))h"
  else                          u="$((a/86400))d"; fi
  if [ "$d" -ge 0 ]; then echo "in $u"; else echo "$u ago"; fi
}

# iso_epoch — convert an ISO-8601 UTC timestamp to epoch seconds (echo 0 on failure).
# GNU date is the production target; gdate (coreutils) is tried as a macOS fallback.
iso_epoch() { date -u -d "$1" +%s 2>/dev/null || gdate -u -d "$1" +%s 2>/dev/null || echo 0; }

# task_row — compute "state<TAB>detail" for one task file, honouring the current MODE.
# Args: <task-json-path> <archived:0|1> <mode>
task_row() {
  local tf="$1" archived="$2" mode="$3"
  local id type state detail live report att fin ckpt started rl
  id="$(jq -r '.id' "$tf")"; type="$(jq -r '.type' "$tf")"
  report="$FL_AUTO_ROOT/reports/$id.md"
  live=""
  [ "$mode" = worker ] && live="$(cat "$FL_AUTO_ROOT/state/$id" 2>/dev/null || echo "")"

  if [ "$mode" = worker ] && [ "$live" = running ]; then
    rl="$FL_LOG_ROOT/$id/run.log"
    att="$(grep -cE 'attempt [0-9]' "$rl" 2>/dev/null)"; att="${att:-0}"
    ckpt="$(grep -oE '\[\[CHECKPOINT[^]]*\]\]' "$rl" 2>/dev/null | tail -1)"
    started="$(head -1 "$rl" 2>/dev/null | grep -oE '^\[[^]]*\]' | tr -d '[]')"
    state=running
    detail="attempt=$att; started=${started:-?}; ${ckpt:-no-checkpoint}"
  elif [ -f "$report" ]; then
    state="$(grep -m1 -oE '\((done|failed)\)' "$report" | tr -d '()')"; state="${state:-done}"
    fin="$(grep -m1 'Finished:' "$report" | sed 's/.*Finished: *//')"
    att="$(grep -m1 'Attempts:' "$report" | sed 's/.*Attempts: *//')"
    detail="attempts=${att:-?}; finished=${fin:-?}"
    [ -n "$live" ] && [ "$live" != "$state" ] && detail="$detail; live=$live"
  elif [ "$archived" = 1 ]; then
    state=archived; detail="retired to tasks/archive/"
  elif [ -n "$live" ]; then
    state="$live"; detail="(live state only)"
  else
    state=pending; detail="awaiting dispatch"
  fi
  [ "$archived" = 1 ] && [ "$state" != archived ] && detail="$detail; ARCHIVED"
  printf '%s\t%s\t%s\n' "$state" "$type" "$detail"
}

# state_of — look up a task id's computed state in the STATES memo built by render
# (bash dynamic scoping: sees render's locals). Empty when the id has no local envelope.
state_of() { printf '%s' "$STATES" | grep -m1 "^$1|" | cut -d'|' -f2; }

# deps_of — comma-joined depends_on list for a task id from the DEPS memo (empty = none).
deps_of() { printf '%s' "$DEPS" | grep -m1 "^$1|" | cut -d'|' -f2; }

# render — print the header, task rows grouped by batch manifest, and a counts summary.
render() {
  local mode; mode="$(detect_mode)"
  echo "schedule-task status  ·  mode: $mode  ·  root: $FL_AUTO_ROOT"
  printf '%-34s %-6s %-14s %-9s %s\n' "ID" "TYPE" "SCHEDULE" "STATE" "DETAIL"
  local done=0 fail=0 run=0 pend=0 arch=0 canc=0
  local tf id runat sched archived st ty de batch sortkey line
  # Pass 1 — compute every task's state/row once (same task_row logic, batched or not).
  # ROWS memoizes "id|sortkey|batch|line"; STATES "id|state"; DEPS "id|dep1,dep2"
  # (states + deps drive the batch x/y progress and the "next" eligibility check).
  local ROWS="" STATES="" DEPS=""
  shopt -s nullglob
  for tf in "$FL_AUTO_ROOT"/tasks/*.json "$FL_AUTO_ROOT"/tasks/archive/*.json; do
    id="$(jq -r '.id' "$tf")"
    case "$tf" in */tasks/archive/*) archived=1;; *) archived=0;; esac
    runat="$(jq -r '.schedule.run_at // empty' "$tf")"
    batch="$(jq -r '.batch // empty' "$tf")"
    if [ -n "$runat" ]; then sortkey="$(iso_epoch "$runat")"; sched="$(reltime "$sortkey")"; else sortkey=0; sched="-"; fi
    IFS=$'\t' read -r st ty de < <(task_row "$tf" "$archived" "$mode")
    case "$st" in done) done=$((done+1));; failed) fail=$((fail+1));; running) run=$((run+1));;
      archived) arch=$((arch+1));; pending) pend=$((pend+1));; cancelled) canc=$((canc+1));; esac
    line="$(printf '%-34s %-6s %-14s %-9s %s' "$id" "$ty" "$sched" "$st" "$de")"
    ROWS+="$id|$sortkey|$batch|$line"$'\n'
    STATES+="$id|$st"$'\n'
    DEPS+="$id|$(jq -r '[.depends_on // [] | .[]] | join(",")' "$tf")"$'\n'
  done

  # Pass 2 — one section per batch manifest (committed, so visible in both modes).
  local mf bid title bnotes total dcnt nxt bstate bnote tid dst dep ok deps
  local batch_count=0 batches_seg=""
  for mf in "$FL_AUTO_ROOT"/batches/*.json; do
    batch_count=$((batch_count+1))
    bid="$(jq -r '.id' "$mf")"; title="$(jq -r '.title // empty' "$mf")"
    bnotes="$(jq -r '.notes // empty' "$mf")"
    total="$(jq '.tasks | length' "$mf")"; dcnt=0; nxt="-"
    for tid in $(jq -r '.tasks[]' "$mf"); do
      dst="$(state_of "$tid")"
      [ "$dst" = done ] && dcnt=$((dcnt+1))
      # next = first manifest-order task that is not done/failed/running/cancelled and
      # whose depends_on are all done (same eligibility rule as dispatch); "-" when none.
      if [ "$nxt" = "-" ] && [ -n "$dst" ] && [ "$dst" != done ] && [ "$dst" != failed ] && [ "$dst" != running ] && [ "$dst" != cancelled ]; then
        ok=1
        deps="$(deps_of "$tid")"
        for dep in ${deps//,/ }; do
          [ "$(state_of "$dep")" = done ] || { ok=0; break; }
        done
        [ "$ok" = 1 ] && nxt="$tid"
      fi
    done
    bstate=""
    [ "$mode" = worker ] && bstate="$(head -1 "$FL_AUTO_ROOT/state/batch-$bid" 2>/dev/null)"
    printf '== batch %s%s — %s/%s done, next: %s%s\n' \
      "$bid" "${title:+ — $title}" "$dcnt" "$total" "$nxt" "${bstate:+  [$bstate]}"
    [ -n "$bnotes" ] && printf '  notes: %.100s\n' "$bnotes"
    if [ "$bstate" = merge-conflict ]; then
      bnote="$(tail -1 "$FL_AUTO_ROOT/state/batch-$bid.notes" 2>/dev/null)"
      [ -n "$bnote" ] && echo "  batch-note: $bnote"
    fi
    for tid in $(jq -r '.tasks[]' "$mf"); do
      line="$(printf '%s' "$ROWS" | grep -m1 "^$tid|" | cut -d'|' -f4-)"
      [ -z "$line" ] && continue  # manifest lists an id whose envelope isn't on this box
      echo "  $line"
      [ "$mode" = worker ] && [ -f "$FL_AUTO_ROOT/state/$tid.notes" ] &&
        tail -2 "$FL_AUTO_ROOT/state/$tid.notes" | sed 's/^/    note: /'
    done
    batches_seg+="${batches_seg:+ · }$bid $dcnt/$total"
  done

  # Ungrouped — tasks with no batch field (or a batch without a manifest), sorted by
  # schedule exactly like v1. Label printed only when batch sections exist above.
  local urows="" id2 sk bt
  while IFS='|' read -r id2 sk bt line; do
    [ -z "$id2" ] && continue
    if [ -z "$bt" ] || [ ! -f "$FL_AUTO_ROOT/batches/$bt.json" ]; then
      urows+="$sk|$line"$'\n'
    fi
  done <<< "$ROWS"
  if [ -n "$urows" ]; then
    [ "$batch_count" -gt 0 ] && echo "(ungrouped)"
    printf '%s' "$urows" | sort -t'|' -k1 -n | cut -d'|' -f2-
  fi
  echo "----"
  local summary="$done done · $fail failed · $run running · $pend pending · $arch archived"
  [ "$canc" -gt 0 ] && summary="$summary · $canc cancelled"
  [ -n "$batches_seg" ] && summary="$summary · batches: $batches_seg"
  echo "$summary"
}

# self_test — fabricate a throwaway automation tree and assert both modes render correctly.
self_test() {
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/tasks/archive" "$tmp/reports" "$tmp/state" "$tmp/batches" "$tmp/logs/run-me/"
  local future=$(( NOW + 7200 )) past=$(( NOW - 3600 ))
  # epoch→ISO for fixtures: gdate (GNU coreutils) when present, else BSD `date -r`
  # (macOS), else GNU `date -d` (Linux without coreutils alias).
  local fiso piso
  if command -v gdate >/dev/null 2>&1; then
    fiso="$(gdate -u -d "@$future" +%FT%TZ)"; piso="$(gdate -u -d "@$past" +%FT%TZ)"
  else
    fiso="$(date -u -r "$future" +%FT%TZ 2>/dev/null || date -u -d "@$future" +%FT%TZ)"
    piso="$(date -u -r "$past" +%FT%TZ 2>/dev/null || date -u -d "@$past" +%FT%TZ)"
  fi
  # A: pending (no report/state, future schedule)
  printf '{"id":"pend-me","type":"dev","schedule":{"run_at":"%s"}}\n' "$fiso" > "$tmp/tasks/pend-me.json"
  # B: done (report + state agree)
  printf '{"id":"done-me","type":"test","schedule":{"run_at":"%s"}}\n' "$piso" > "$tmp/tasks/done-me.json"
  printf '# Report — done-me (done)\n- Attempts: 2\n- Finished: %s\n' "$piso" > "$tmp/reports/done-me.md"
  echo done > "$tmp/state/done-me"
  # C: running (live state + run log with a checkpoint)
  printf '{"id":"run-me","type":"dev","schedule":{"run_at":"%s"}}\n' "$piso" > "$tmp/tasks/run-me.json"
  echo running > "$tmp/state/run-me"
  printf '[t0] start\n[t1] attempt 1: fresh run\n[t2] [[CHECKPOINT step 3/5]]\n' > "$tmp/logs/run-me/run.log"
  # D: archived (envelope in archive/ + done report)
  printf '{"id":"arch-me","type":"audit","schedule":{"run_at":"%s"}}\n' "$piso" > "$tmp/tasks/archive/arch-me.json"
  printf '# Report — arch-me (done)\n- Attempts: 1\n- Finished: %s\n' "$piso" > "$tmp/reports/arch-me.md"
  # E: batch p0805 — 2 done + 1 pending (depends_on satisfied), a task notes file
  # (3 lines; only the last 2 render), and batch runtime state = merge-conflict + notes.
  printf '{"id":"b-done1","type":"dev","batch":"p0805","schedule":{"run_at":"%s"}}\n' "$piso" > "$tmp/tasks/b-done1.json"
  printf '{"id":"b-done2","type":"test","batch":"p0805","schedule":{"run_at":"%s"}}\n' "$piso" > "$tmp/tasks/b-done2.json"
  printf '{"id":"b-pend","type":"dev","batch":"p0805","depends_on":["b-done1"],"schedule":{"run_at":"%s"}}\n' "$fiso" > "$tmp/tasks/b-pend.json"
  printf '# Report — b-done1 (done)\n- Attempts: 1\n- Finished: %s\n' "$piso" > "$tmp/reports/b-done1.md"
  printf '# Report — b-done2 (done)\n- Attempts: 3\n- Finished: %s\n' "$piso" > "$tmp/reports/b-done2.md"
  echo done > "$tmp/state/b-done1"
  echo done > "$tmp/state/b-done2"
  printf '[%s] attempt 1 failed: lint\n[%s] attempt 2 ok\n[%s] done, report written\n' "$piso" "$piso" "$piso" > "$tmp/state/b-done1.notes"
  printf '{"id":"p0805","title":"P0805 flight","notes":"retreat + formation + paint","tasks":["b-done1","b-done2","b-pend"],"merge_target":"dev"}\n' > "$tmp/batches/p0805.json"
  echo merge-conflict > "$tmp/state/batch-p0805"
  printf '[%s] merging 3 branches into dev\n[%s] CONFLICT in src/game.js — needs human\n' "$piso" "$piso" > "$tmp/state/batch-p0805.notes"
  # F: batch tip1 — single pending task whose depends_on is NOT done (blocked → next: -).
  printf '{"id":"t-blocked","type":"dev","batch":"tip1","depends_on":["run-me"],"schedule":{"run_at":"%s"}}\n' "$fiso" > "$tmp/tasks/t-blocked.json"
  printf '{"id":"tip1","title":"Tip1 blocked","notes":"","tasks":["t-blocked"],"merge_target":"dev"}\n' > "$tmp/batches/tip1.json"
  # G: batch canc1 — single cancelled task (live state only, no report; never "next").
  printf '{"id":"g-canc","type":"dev","batch":"canc1","schedule":{"run_at":"%s"}}\n' "$piso" > "$tmp/tasks/g-canc.json"
  echo cancelled > "$tmp/state/g-canc"
  printf '{"id":"canc1","title":"Cancelled batch","notes":"","tasks":["g-canc"],"merge_target":"dev"}\n' > "$tmp/batches/canc1.json"

  local pass=0 fail=0
  check() { if echo "$2" | grep -qE "$3"; then echo "  ok: $1"; pass=$((pass+1)); else echo "  FAIL: $1"; echo "$2" | sed 's/^/    /'; fail=$((fail+1)); fi; }
  check_absent() { if echo "$2" | grep -qE "$3"; then echo "  FAIL: $1 (unexpected match)"; echo "$2" | sed 's/^/    /'; fail=$((fail+1)); else echo "  ok: $1"; pass=$((pass+1)); fi; }

  local out
  out="$(FL_AUTO_ROOT="$tmp" FL_LOG_ROOT="$tmp/logs" FL_MODE=worker render)"
  echo "[worker mode]"
  check "pending row"  "$out" 'pend-me .* pending'
  check "done row"     "$out" 'done-me .* done .*attempts=2'
  check "running row"  "$out" 'run-me .* running .*CHECKPOINT step 3/5'
  check "archived row" "$out" 'arch-me .* done .*ARCHIVED'
  check "counts line"  "$out" '4 done · 0 failed · 1 running · 3 pending'
  check "batch header: title + 2/3"     "$out" '== batch p0805 — P0805 flight — 2/3 done'
  check "batch header: next task"       "$out" 'next: b-pend'
  check "blocked dep is not next"       "$out" '== batch tip1 — Tip1 blocked — 0/1 done, next: -$'
  check "batch header: merge-conflict"  "$out" '== batch p0805 .*\[merge-conflict\]'
  check "batch conflict note line"      "$out" 'batch-note: .*CONFLICT in src/game\.js'
  check "manifest notes line"           "$out" '  notes: retreat \+ formation \+ paint'
  check "task notes under right task"   "$(echo "$out" | grep -A2 'b-done1 ')" '    note:'
  check "task notes tail: line 2"       "$out" 'note: .*attempt 2 ok'
  check "task notes tail: line 3"       "$out" 'note: .*done, report written'
  check_absent "task notes tail: oldest dropped" "$out" 'note: .*attempt 1 failed'
  check "ungrouped section renders"     "$out" '\(ungrouped\)'
  check "summary batches segment"       "$out" 'batches: canc1 0/1 · p0805 2/3 · tip1 0/1'
  check "cancelled row"                 "$out" 'g-canc .* cancelled'
  check "cancelled task is never next"  "$out" '== batch canc1 — Cancelled batch — 0/1 done, next: -$'
  check "counts: cancelled segment"     "$out" '· 1 cancelled'

  out="$(FL_AUTO_ROOT="$tmp" FL_LOG_ROOT="$tmp/nope" FL_MODE=author render)"
  echo "[author mode — no live state]"
  # With no live state and no committed report yet, a mid-run task reads as pending
  # (the author box only knows the last committed truth — correct, not a bug).
  check "running falls back to pending" "$out" 'run-me .* pending'
  check "done still done"               "$out" 'done-me .* done'
  check "pending still pending"         "$out" 'pend-me .* pending'
  check "batch header in author mode"   "$out" '== batch p0805 — P0805 flight — 2/3 done'
  check_absent "no batch runtime state in author" "$out" 'merge-conflict'
  check_absent "no worker notes in author"        "$out" '    note:'

  echo "----"; echo "self-test: $pass passed, $fail failed"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  --self-test) self_test ;;
  -h|--help)   grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)           render ;;
esac
