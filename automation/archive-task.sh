#!/usr/bin/env bash
# archive-task.sh <task-id>
# Retire a COMPLETED automation task by moving its prompt + envelope into the sibling
# archive/ dirs instead of deleting them (the old manual `rm` lost the authored spec).
# The dispatcher scans automation/tasks/*.json non-recursively, so an archived task in
# automation/tasks/archive/ is out of the active inbox yet stays in git as a faithful
# record. Move-only; never touches automation/reports/ (the durable run record).
set -uo pipefail

ID="${1:?usage: archive-task.sh <task-id>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK="$REPO/automation/tasks/$ID.json"
[ -f "$TASK" ] || { echo "archive-task: no active task automation/tasks/$ID.json" >&2; exit 1; }

# Refuse to archive a task that hasn't finished (done or cancelled) — state lives in the
# VPS-only state dir.
st="$(cat "$REPO/automation/state/$ID" 2>/dev/null || echo unknown)"
case "$st" in
  done|cancelled) ;;
  *) echo "archive-task: $ID state is '$st' (not done/cancelled); refusing to retire" >&2; exit 1;;
esac

# Resolve the prompt path from the envelope so we archive the exact pair that ran.
PROMPT_REL="$(jq -r '.prompt_file' "$TASK")"
PROMPT="$REPO/$PROMPT_REL"

mkdir -p "$REPO/automation/tasks/archive" "$REPO/automation/prompts/archive"
# git mv when tracked, plain mv otherwise — keeps history where possible.
mv_one() { git -C "$REPO" mv "$1" "$2" 2>/dev/null || mv "$1" "$2"; }

mv_one "$TASK"   "$REPO/automation/tasks/archive/$ID.json"
[ -f "$PROMPT" ] && mv_one "$PROMPT" "$REPO/automation/prompts/archive/$(basename "$PROMPT_REL")"

echo "archive-task: retired $ID -> automation/{tasks,prompts}/archive/"
