#!/usr/bin/env bash
# dispatch.sh [<repo-path>] — the trigger-layer watchdog. Runs from cron every 5 min (under flock)
# on a machine that declared itself a worker in automation/state/.machine.
# If <repo-path> is omitted, the repo is derived from this script's location.
# (role=worker + id=<machine-id>; init writes it). Deterministic and cheap: pull the
# inbox, launch due + eligible tasks in detached tmux sessions — bounded by
# FL_MAX_CONCURRENCY instead of v1's global "any task running → idle" serialization
# (cap=1 reproduces v1 exactly; envelopes without batch/depends_on behave as before).
# Only tasks whose envelope `.worker` equals this machine's id are launched (absent
# `.worker` = any worker may take it). Workers NEVER merge — batch finalization is the
# author's job (automation/merge-batch.sh). The multi-hour resilient part is owned by
# run-task.sh, not by this tick.
set -uo pipefail

# cron runs with a sparse environment — pin HOME and PATH so git/jq/tmux resolve.
export HOME="${HOME:-/home/david}"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# Repo root: first positional arg if it's a directory, otherwise derive from script location.
# This lets the skill live user-level while operating on any project.
if [ -n "${1:-}" ] && [ -d "$1" ]; then
  REPO="$(cd "$1" && pwd)"; shift
else
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
STATE_DIR="$REPO/automation/state"
mkdir -p "$STATE_DIR"
cd "$REPO" || exit 1
dlog() { printf '[%s] dispatch: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# --- machine identity: only a machine declared role=worker dispatches ---
# .machine lives in the gitignored state dir (init writes it): role=author|worker,
# id=<machine-id> (the value envelope `.worker` is matched against).
ROLE=worker; MACHINE_ID="$(hostname 2>/dev/null || echo unknown)"
if [ -f "$STATE_DIR/.machine" ]; then
  while IFS='=' read -r k v; do
    case "$k" in role) ROLE="$v";; id) MACHINE_ID="$v";; esac
  done < "$STATE_DIR/.machine"
fi
if [ "$ROLE" != worker ]; then
  dlog "role=$ROLE — not a worker (automation/state/.machine); idle"
  exit 0
fi

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

git fetch origin dev >/dev/null 2>&1 || { dlog "cannot fetch origin/dev"; exit 0; }
git checkout dev >/dev/null 2>&1 || git checkout -b dev origin/dev >/dev/null 2>&1 || { dlog "cannot checkout dev"; exit 0; }
git pull --rebase origin dev >/dev/null 2>&1 || dlog "pull failed (offline?)"

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

  # Machine assignment (envelope v3): a task naming a worker is only launched there.
  wkr="$(jq -r '.worker // empty' "$tf" 2>/dev/null)"
  if [ -n "$wkr" ] && [ "$wkr" != "$MACHINE_ID" ]; then
    dlog "$id assigned to worker '$wkr' (this box: $MACHINE_ID); skipping"
    continue
  fi

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
  # Use the same script directory as dispatch.sh (works for both central and copied runtimes).
  RUNNER="$(dirname "${BASH_SOURCE[0]}")/run-task.sh"
  tmux new-session -d -s "task-$id" "bash '$RUNNER' '$REPO' '$id'"
  free=$((free - 1)); launched=$((launched + 1))
done
if [ "$launched" -eq 0 ]; then dlog "nothing due"; fi

# Workers NEVER merge: batch finalization (landing every done task's branch on the
# merge target, in dependency order) is the author's job — automation/merge-batch.sh.

