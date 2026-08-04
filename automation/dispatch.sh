#!/usr/bin/env bash
# dispatch.sh — the trigger-layer watchdog. Runs from cron every 5 min (under flock).
# Deterministic and cheap: pull the inbox, land finished work onto dev, merge finished
# batches, then launch due + eligible tasks in detached tmux sessions — bounded by
# FL_MAX_CONCURRENCY instead of v1's global "any task running → idle" serialization
# (cap=1 reproduces v1 exactly; envelopes without batch/depends_on behave as before).
# The multi-hour resilient part is owned by run-task.sh, not by this tick.
set -uo pipefail

# cron runs with a sparse environment — pin HOME and PATH so git/jq/tmux resolve.
export HOME="${HOME:-/home/david}"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$REPO/automation/state"
mkdir -p "$STATE_DIR"
cd "$REPO" || exit 1
dlog() { printf '[%s] dispatch: %s\n' "$(date -u +%FT%TZ)" "$*"; }
# notify — fire the notification hook if present+executable; NEVER fail the dispatcher on it.
notify() {
  local hook="$REPO/automation/hooks/notify.sh"
  if [ -x "$hook" ]; then "$hook" "$1" "$2" "$3" || true; fi
}

MAX_CONCURRENCY="${FL_MAX_CONCURRENCY:-2}"   # 1 == v1 strict serialization
# Count runners by state file (first line = state word; <id>.notes and batch-* files
# never read exactly "running", so -x matching keeps the count clean).
running_count="$(grep -rlx 'running' "$STATE_DIR" 2>/dev/null | wc -l | tr -d ' ')"

# At capacity: leave everything alone this tick (with cap=1 this IS the v1 guard).
if [ "$running_count" -ge "$MAX_CONCURRENCY" ]; then
  dlog "at capacity ($running_count/$MAX_CONCURRENCY running); idle"; exit 0
fi

# Only touch git when tracked files are clean (untracked stray files are benign and ignored;
# this guard exists to avoid fighting an in-flight edit / interactive session).
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  dlog "main tree has tracked changes; skipping tick"; exit 0
fi

git checkout dev >/dev/null 2>&1 || { dlog "cannot checkout dev"; exit 0; }
git pull --rebase origin dev >/dev/null 2>&1 || dlog "pull failed (offline?)"

# Land any completed automation work onto dev (add-only design → conflict-free).
# Task branches are automation/tip-* now (per-task isolation); nothing merges into
# automation/dev any more, so skip this when it doesn't exist locally.
if git show-ref --verify --quiet refs/heads/automation/dev; then
  if git merge --no-edit automation/dev >/dev/null 2>&1; then
    git push origin dev >/dev/null 2>&1 || true
  else
    git merge --abort >/dev/null 2>&1 || true
    dlog "merge automation/dev -> dev needs attention"
  fi
fi

# Launch due + eligible tasks until the free slots are filled.
now="$(date -u +%s)"
free=$((MAX_CONCURRENCY - running_count))
launched=0
shopt -s nullglob
for tf in "$REPO"/automation/tasks/*.json; do
  [ "$free" -gt 0 ] || break
  id="$(jq -r '.id' "$tf" 2>/dev/null)"; [ -n "$id" ] || continue
  st="$(cat "$STATE_DIR/$id" 2>/dev/null || echo pending)"
  case "$st" in running|done|failed|cancelled) continue;; esac

  runat="$(jq -r '.schedule.run_at // empty' "$tf" 2>/dev/null)"
  if [ -n "$runat" ]; then
    due="$(date -u -d "$runat" +%s 2>/dev/null || echo 0)"
    [ "$now" -ge "$due" ] || { dlog "$id not due yet ($runat)"; continue; }
  fi

  # depends_on (envelope v2): every listed task id must be done. Missing dep state = not done.
  blocked=""
  for dep in $(jq -r '.depends_on // [] | .[]' "$tf" 2>/dev/null); do
    depst="$(cat "$STATE_DIR/$dep" 2>/dev/null || echo pending)"
    [ "$depst" = done ] || { blocked="$dep"; break; }
  done
  [ -n "$blocked" ] && { dlog "$id blocked by $blocked (not done)"; continue; }

  dlog "launching $id"
  tmux new-session -d -s "task-$id" "bash '$REPO/automation/run-task.sh' '$id'"
  free=$((free - 1)); launched=$((launched + 1))
done
[ "$launched" -eq 0 ] && dlog "nothing due"

# --- batch completion merge ---
# A batch is finished when every task in its manifest is TERMINAL (done|cancelled); then
# land each done task's branch on the manifest's merge_target (default dev), skipping
# cancelled tasks' branches. An all-cancelled batch is flagged cancelled with no merge.
# Manifests are authored in dependency order, so plain manifest order is the topological
# order. On conflict: abort, flag the batch merge-conflict, and stop it (later branches
# stay unmerged) — resolution is human/agent work, not this script's. Singleton tasks
# (no batch) never reach this block; their branches are merged by humans as before.
for bf in "$REPO"/automation/batches/*.json; do
  bid="$(jq -r '.id // empty' "$bf" 2>/dev/null)"
  [ -n "$bid" ] || bid="$(basename "$bf" .json)"   # id == filename convention, as with tasks
  bstate="$(cat "$STATE_DIR/batch-$bid" 2>/dev/null || echo pending)"
  # merged: nothing to do. merge-conflict: awaiting human resolution — don't retry-spam each tick.
  case "$bstate" in merged|merge-conflict) continue;; esac

  tids="$(jq -r '.tasks // [] | .[]' "$bf" 2>/dev/null)"
  [ -n "$tids" ] || continue
  all_term=1; done_count=0
  for tid in $tids; do
    tst="$(cat "$STATE_DIR/$tid" 2>/dev/null || echo pending)"
    case "$tst" in
      done)      done_count=$((done_count+1));;
      cancelled) :;;
      *) all_term=0; break;;
    esac
  done
  [ "$all_term" -eq 1 ] || continue
  if [ "$done_count" -eq 0 ]; then
    echo cancelled > "$STATE_DIR/batch-$bid"
    printf '[%s] cancelled: every task cancelled; nothing to merge\n' \
      "$(date -u +%FT%TZ)" >> "$STATE_DIR/batch-$bid.notes"
    notify cancelled "$bid" "batch cancelled: nothing to merge"
    dlog "batch $bid: all tasks cancelled; no merge"
    continue
  fi

  target="$(jq -r '.merge_target // "dev"' "$bf")"
  dlog "batch $bid: all tasks done; merging into $target"
  git checkout "$target" >/dev/null 2>&1 || { dlog "batch $bid: cannot checkout $target"; continue; }
  git pull --rebase origin "$target" >/dev/null 2>&1 || true
  ok=1
  for tid in $tids; do
    # Cancelled tasks have no branch to land — skip them.
    [ "$(cat "$STATE_DIR/$tid" 2>/dev/null || echo '')" = cancelled ] && {
      dlog "batch $bid: $tid cancelled; branch skipped"; continue; }
    # Task envelopes may have been archived by the time the batch completes — check both.
    ef="$REPO/automation/tasks/$tid.json"
    [ -f "$ef" ] || ef="$REPO/automation/tasks/archive/$tid.json"
    br="$(jq -r '.branch // empty' "$ef" 2>/dev/null)"
    [ -n "$br" ] || { dlog "batch $bid: no branch for $tid; skipped"; continue; }
    if git merge --no-edit "$br" >/dev/null 2>&1; then
      dlog "batch $bid: merged $br -> $target"
    else
      git merge --abort >/dev/null 2>&1 || true
      echo merge-conflict > "$STATE_DIR/batch-$bid"
      printf '[%s] merge-conflict: %s -> %s; batch halted (later branches unmerged)\n' \
        "$(date -u +%FT%TZ)" "$br" "$target" >> "$STATE_DIR/batch-$bid.notes"
      notify merge-conflict "$bid" "conflict merging $br into $target"
      dlog "batch $bid: conflict on $br; batch halted"
      ok=0; break
    fi
  done
  if [ "$ok" -eq 1 ]; then
    git push origin "$target" >/dev/null 2>&1 || dlog "batch $bid: push $target failed (non-fatal)"
    echo merged > "$STATE_DIR/batch-$bid"
    printf '[%s] merged: %s task branches -> %s\n' "$(date -u +%FT%TZ)" "$done_count" "$target" >> "$STATE_DIR/batch-$bid.notes"
    notify merged "$bid" "merged $done_count branches into $target"
    dlog "batch $bid: merged into $target"
  fi
done
