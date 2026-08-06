#!/usr/bin/env bash
# merge-batch.sh [<repo-path>] <batch-id> — AUTHOR-side batch finalization.
# Workers NEVER merge (machine-identity contract in dispatch.sh); the author lands every
# finished task's branch onto the manifest's merge_target (default dev), in manifest
# (dependency) order, then pushes. Run on the author box after `git fetch` — works in any
# working tree, no worker needed.
#
# "Finished" = the task branch has a committed automation/reports/<id>.md whose H1 says
# (done) — read from origin/<branch>, because the reports live on the task branches, not
# on dev, until this script merges them. Tasks without a done report (still running /
# pending / cancelled-unknown on the author box) are skipped and reported, never merged.
#
# On conflict: abort the merge and exit non-zero — resolution is human/agent work, never
# an automatic force-through. Idempotent: re-running after a fix continues from where it
# stopped (already-merged branches merge cleanly as no-ops).
set -uo pipefail

# Repo root: first positional arg if it's a directory, otherwise derive from script location.
if [ -n "${1:-}" ] && [ -d "$1" ]; then
  REPO="$(cd "$1" && pwd)"; shift
else
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
BID="${1:?usage: merge-batch.sh [<repo-path>] <batch-id>}"
MANIFEST="$REPO/automation/batches/$BID.json"
[ -f "$MANIFEST" ] || { echo "merge-batch: no manifest automation/batches/$BID.json" >&2; exit 1; }

cd "$REPO" || exit 1
mlog() { printf '[%s] merge-batch: %s\n' "$(date -u +%FT%TZ)" "$*"; }

TARGET="$(jq -r '.merge_target // "dev"' "$MANIFEST")"
TIDS="$(jq -r '.tasks // [] | .[]' "$MANIFEST")"
[ -n "$TIDS" ] || { echo "merge-batch: manifest $BID has no tasks" >&2; exit 1; }

git fetch origin >/dev/null 2>&1 || { echo "merge-batch: git fetch failed (offline?)" >&2; exit 1; }

# Bring the merge target up to date on top of origin; refuse to invent a merge commit.
git checkout "$TARGET" >/dev/null 2>&1 || { echo "merge-batch: cannot checkout $TARGET" >&2; exit 1; }
if ! git merge --ff-only "origin/$TARGET" >/dev/null 2>&1; then
  echo "merge-batch: $TARGET cannot fast-forward from origin/$TARGET (local commits?); aborting" >&2
  exit 1
fi

merged=0; skipped=0; conflict=0
for tid in $TIDS; do
  # Envelope may be archived by the time the batch completes — check both locations.
  ef="$REPO/automation/tasks/$tid.json"
  [ -f "$ef" ] || ef="$REPO/automation/tasks/archive/$tid.json"
  [ -f "$ef" ] || { mlog "$tid: no envelope (archived?); skipped"; skipped=$((skipped + 1)); continue; }
  br="$(jq -r '.branch // empty' "$ef")"
  [ -n "$br" ] || { mlog "$tid: no branch field; skipped"; skipped=$((skipped + 1)); continue; }
  # Done is judged from the committed report ON THE BRANCH (not on dev / not locally).
  if ! git cat-file -e "origin/$br:automation/reports/$tid.md" 2>/dev/null; then
    mlog "$tid: no report on origin/$br (not finished / no push); skipped"
    skipped=$((skipped + 1)); continue
  fi
  if ! git show "origin/$br:automation/reports/$tid.md" 2>/dev/null | grep -q '(done)'; then
    mlog "$tid: report on origin/$br is not (done); skipped"
    skipped=$((skipped + 1)); continue
  fi
  if git merge --no-edit "origin/$br" >/dev/null 2>&1; then
    mlog "merged $br -> $TARGET"; merged=$((merged + 1))
  else
    git merge --abort >/dev/null 2>&1 || true
    mlog "CONFLICT merging $br into $TARGET; batch halted (later branches unmerged)"
    conflict=1; break
  fi
done

if [ "$conflict" -eq 1 ]; then
  echo "merge-batch: conflict on a task branch; $TARGET left clean — resolve by hand, then re-run" >&2
  exit 1
fi

git push origin "$TARGET" >/dev/null 2>&1 || { echo "merge-batch: push $TARGET failed" >&2; exit 1; }
echo "merge-batch: $BID — merged $merged branch(es) into $TARGET, skipped $skipped (no done report); pushed"
