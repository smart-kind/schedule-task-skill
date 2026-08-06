#!/usr/bin/env bash
# cancel-task.sh [<repo-path>] <task-id>|--all [reason...]
# Cancel a scheduled task — pending ones simply never dispatch again; RUNNING ones get
# their tmux session killed (run-task.sh, its limit-park `sleep`, and the coding-agent
# CLI child all die with the pane), so cancel works even mid limit-wait.
#
# Semantics:
#   - state/<id> is set to `cancelled` (first-line word contract preserved); dispatch.sh
#     skips it from then on, and a notes line + notify hook record the reason.
#   - CASCADE: an active task whose depends_on chain includes a cancelled id can never
#     become eligible, so it is cancelled too (reason names the root cause). A dependent
#     that is somehow already running is left alone and warned about.
#   - Terminal tasks (done/failed/cancelled) and archived envelopes are refused.
#   - The task's worktree (~/.local/state/automation/worktrees/<id>) is LEFT in place —
#     it may hold uncommitted work worth inspecting; delete it by hand if unwanted.
#   - No git mutations: cancelling is worker-local state, same as running.
set -uo pipefail

export HOME="${HOME:-/home/david}"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# Repo root: first positional arg if it's a directory, otherwise derive from script location.
if [ -n "${1:-}" ] && [ -d "$1" ]; then
  REPO="$(cd "$1" && pwd)"; shift
else
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
STATE_DIR="$REPO/automation/state"
mkdir -p "$STATE_DIR"
shopt -s nullglob

notify() { local h="$REPO/automation/hooks/notify.sh"; if [ -x "$h" ]; then "$h" "$1" "$2" "$3" || true; fi; }
note() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$2" >> "$STATE_DIR/$1.notes"; }
state_of() { head -1 "$STATE_DIR/$1" 2>/dev/null || echo pending; }

TARGET="${1:-}"
case "$TARGET" in -h|--help|"") grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;; esac
shift || true
REASON="${*:-cancelled by user}"

# Collect target ids: --all = every active task that is still pending or running.
ids=()
if [ "$TARGET" = --all ]; then
  for tf in "$REPO"/automation/tasks/*.json; do
    id="$(jq -r '.id // empty' "$tf" 2>/dev/null)"; [ -n "$id" ] || continue
    case "$(state_of "$id")" in pending|running) ids+=("$id");; esac
  done
  [ "${#ids[@]}" -gt 0 ] || { echo "cancel-task: no active (pending/running) tasks"; exit 0; }
else
  [ -f "$REPO/automation/tasks/$TARGET.json" ] || {
    echo "cancel-task: no active task automation/tasks/$TARGET.json" >&2; exit 1; }
  ids=("$TARGET")
fi

# cancel_one <id> <reason> — kill if running, mark cancelled, record. Refuses terminal tasks.
cancel_one() {
  local id="$1" why="$2" st
  st="$(state_of "$id")"
  case "$st" in
    done|failed|cancelled)
      echo "cancel-task: $id is '$st' — nothing to cancel"; return 1;;
  esac
  if tmux has-session -t "task-$id" 2>/dev/null; then
    tmux kill-session -t "task-$id"
    echo "cancel-task: killed tmux session task-$id (runner + CLI child terminated)"
  fi
  echo cancelled > "$STATE_DIR/$id"
  note "$id" "cancelled: $why"
  notify cancelled "$id" "$why"
  echo "cancel-task: $id cancelled ($why)"
  [ -d "$HOME/.local/state/automation/worktrees/$id" ] &&
    echo "  note: worktree kept at ~/.local/state/automation/worktrees/$id — inspect or delete by hand"
  return 0
}

# BFS over the requested ids, cascading to dependents until fixpoint. Queue entries are
# "id<TAB>reason" so cascaded cancels name their root cause. (`cancelled` doubles as the
# visited set; bash 3.2-safe — no assoc arrays.)
queue=()
for id in "${ids[@]}"; do queue+=("$id	$REASON"); done
cancelled=" "
while [ "${#queue[@]}" -gt 0 ]; do
  entry="${queue[0]}"; queue=("${queue[@]:1}")
  id="${entry%%	*}"; why="${entry#*	}"
  case "$cancelled" in *" $id "*) continue;; esac
  cancel_one "$id" "$why" || continue
  cancelled+="$id "
  for tf in "$REPO"/automation/tasks/*.json; do
    dep_id="$(jq -r '.id // empty' "$tf" 2>/dev/null)"; [ -n "$dep_id" ] || continue
    case "$cancelled" in *" $dep_id "*) continue;; esac
    jq -e --arg x "$id" '.depends_on // [] | index($x)' "$tf" >/dev/null 2>&1 || continue
    case "$(state_of "$dep_id")" in
      running) echo "cancel-task: WARNING dependent $dep_id is already running; leaving it (kill manually if unwanted)";;
      done|failed) :;;                 # already terminal — nothing to cascade
      *) queue+=("$dep_id	dependency $id cancelled");;
    esac
  done
done
