#!/usr/bin/env bash
# run-task.sh [<repo-path>] <task-id>
# Resilient headless runner for one automation task. Executes the task's plan-harness
# prompt via a coding CLI — routed through automation/coding-agent.sh so claude and kimi
# share this exact loop — inside an ISOLATED git worktree on the task branch, and
# survives usage-limit windows by parking on the router's exit 75 (until reset_epoch when
# known, LIMIT_FALLBACK otherwise) and resuming the CLI session (full context preserved).
# Verifies completion (TASK_DONE sentinel + a new commit), writes
# automation/reports/<id>.md, pushes, records state, appends milestone notes, and fires
# the notify hook. Deterministic; there is no AI in this control loop — only the
# executor has a brain.
set -uo pipefail

# cron runs with a sparse environment — pin HOME and PATH so git/jq/tmux resolve.
export HOME="${HOME:-/home/david}"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# Repo root: first positional arg if it's a directory, otherwise derive from script location.
if [ -n "${1:-}" ] && [ -d "$1" ]; then
  MAIN_REPO="$(cd "$1" && pwd)"; shift
else
  MAIN_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
ID="${1:?usage: run-task.sh [<repo-path>] <task-id>}"
TASK="$MAIN_REPO/automation/tasks/$ID.json"
STATE_DIR="$MAIN_REPO/automation/state"
LOGD="$HOME/.local/state/automation/$ID"
WT="$HOME/.local/state/automation/worktrees/$ID"
SESS_FILE="$LOGD/session_id"   # persisted CLI session id → cross-process resume
mkdir -p "$STATE_DIR" "$LOGD" "$(dirname "$WT")"

# log — timestamped line to the task's run log (and stdout, so `tmux attach` shows it).
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOGD/run.log"; }
# note — one milestone line in automation/state/<id>.notes (author-facing history).
note() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >> "$STATE_DIR/$ID.notes"; }
# notify — fire the notification hook if present+executable; NEVER fail the runner on it.
notify() {
  local hook="$MAIN_REPO/automation/hooks/notify.sh"
  if [ -x "$hook" ]; then "$hook" "$1" "$ID" "$2" || true; fi
}

[ -f "$TASK" ] || { echo failed > "$STATE_DIR/$ID"; log "no task file $TASK"; exit 1; }

BRANCH="$(jq -r '.branch' "$TASK")"
PROMPT_REL="$(jq -r '.prompt_file' "$TASK")"
MODEL="$(jq -r '.model // "opus"' "$TASK")"
AGENT="$(jq -r '.agent // "claude"' "$TASK")"   # envelope v2; absent = claude (back-compat)
SENTINEL="[[TASK_DONE $ID"
LIMIT_MARGIN="${LIMIT_MARGIN:-60}"      # seconds added past the parsed reset time
LIMIT_FALLBACK="${LIMIT_FALLBACK:-1800}" # wait when the router reports no reset_epoch
MAX_AMBIGUOUS="${MAX_AMBIGUOUS:-12}"     # abort after this many non-limit, non-done exits
AMBIGUOUS_SLEEP="${AMBIGUOUS_SLEEP:-20}" # backoff between ambiguous retries (never tight-loop)
AMBIGUOUS_FRESH_AT="${AMBIGUOUS_FRESH_AT:-6}" # after N ambiguous, drop the session for a clean fresh run
ROUTER="${CODING_AGENT_BIN:-$(dirname "${BASH_SOURCE[0]}")/coding-agent.sh}" # CLI router (central skill by default)

echo running > "$STATE_DIR/$ID"
log "start id=$ID branch=$BRANCH model=$MODEL agent=$AGENT"
note "start agent=$AGENT model=$MODEL branch=$BRANCH"
notify started "agent=$AGENT model=$MODEL branch=$BRANCH"

# --- isolated worktree on the task branch (created fresh, or reused on resume) ---
session_id=""   # set here so the reuse path can rehydrate a persisted session for resume
if [ -e "$WT/.git" ]; then
  log "reusing existing worktree (resume path)"
  session_id="$(cat "$SESS_FILE" 2>/dev/null || true)"
  # Fallback (claude only): a hard kill (reboot) can die before SESS_FILE is written, but the
  # session id was already streamed to disk — recover it from the newest attempt log so resume
  # still works. kimi session ids aren't greppable from the log the same way, so kimi simply
  # starts fresh.
  if [ -z "$session_id" ] && [ "$AGENT" = claude ]; then
    last="$(ls -1t "$LOGD"/attempt-*.jsonl 2>/dev/null | head -1)"
    [ -n "$last" ] && session_id="$(jq -r 'select(.type=="system") | .session_id // empty' "$last" 2>/dev/null | head -1)"
    [ -n "$session_id" ] && log "recovered session $session_id from $last"
  fi
  [ -n "$session_id" ] && log "will resume $session_id"
  cd "$WT" || { echo failed > "$STATE_DIR/$ID"; exit 1; }
else
  # Base the task branch on the current local dev tip (dispatcher keeps dev fresh).
  if git -C "$MAIN_REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$MAIN_REPO" branch -f "$BRANCH" dev >>"$LOGD/run.log" 2>&1 || true
  else
    git -C "$MAIN_REPO" branch "$BRANCH" dev >>"$LOGD/run.log" 2>&1 || git -C "$MAIN_REPO" branch "$BRANCH" >>"$LOGD/run.log" 2>&1
  fi
  git -C "$MAIN_REPO" worktree add -f "$WT" "$BRANCH" >>"$LOGD/run.log" 2>&1 \
    || { echo failed > "$STATE_DIR/$ID"; log "worktree add failed"; exit 1; }
  cd "$WT" || { echo failed > "$STATE_DIR/$ID"; exit 1; }
fi

PROMPT_FILE="$WT/$PROMPT_REL"
[ -f "$PROMPT_FILE" ] || { echo failed > "$STATE_DIR/$ID"; log "no prompt $PROMPT_FILE"; exit 1; }
COMMIT_BEFORE="$(git rev-parse HEAD)"

# --- resilient execute/resume loop ---
attempt=0; ambiguous=0    # session_id already set above (empty=fresh, or rehydrated for resume)
MAX_ATTEMPTS=60           # backstop across many limit windows (~days); not a time limit
while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  S="$LOGD/attempt-$attempt.jsonl"
  E="$LOGD/attempt-$attempt.stderr"   # router's stderr: CLI stderr + session_id=/reset_epoch= lines

  if [ -z "$session_id" ]; then
    log "attempt $attempt: fresh run"; note "attempt $attempt fresh"
    "$ROUTER" "$AGENT" fresh "$MODEL" - "$(cat "$PROMPT_FILE")" >"$S" 2>"$E"; rc=$?
  else
    log "attempt $attempt: resume $session_id"; note "attempt $attempt resume $session_id"
    "$ROUTER" "$AGENT" resume "$MODEL" "$session_id" \
      "Continue this task. Re-read $PROMPT_REL and the latest commit on this branch, then resume from the last checkpoint. Do NOT redo or revert already-committed work." \
      >"$S" 2>"$E"; rc=$?
  fi
  # The router reports the session id on stderr (mixed with the CLI's own stderr) — grep ONLY
  # the ^session_id= line. Refresh SESS_FILE on every attempt, not just fresh ones: kimi
  # resumes may mint a new session id, and a crash/reboot mid-task must resume the LATEST one.
  sid="$(grep '^session_id=' "$E" 2>/dev/null | head -1 | cut -d= -f2)"
  if [ -n "$sid" ]; then session_id="$sid"; printf '%s' "$session_id" > "$SESS_FILE"; fi
  cat "$E" >> "$LOGD/run.log" 2>/dev/null || true
  log "session_id=$session_id rc=$rc"

  if grep -qF "$SENTINEL" "$S" 2>/dev/null; then
    log "TASK_DONE detected"; note "TASK_DONE detected (attempt $attempt)"; break
  fi

  # usage/session/rate limit? The router owns the per-CLI patterns and signals with exit 75
  # (+ an optional reset_epoch on stderr); we park until that instant (+ margin) — or the
  # fallback wait when no epoch was parsed — then resume with full context.
  if [ "$rc" -eq 75 ]; then
    ep="$(grep '^reset_epoch=' "$E" 2>/dev/null | head -1 | cut -d= -f2)"
    case "$ep" in ''|*[!0-9]*) ep="";; esac
    now="$(date -u +%s)"
    if [ -n "$ep" ] && [ "$ep" -gt "$now" ] && [ "$ep" -lt "$((now + 700000))" ]; then
      w=$((ep - now + LIMIT_MARGIN))
    else
      w=$LIMIT_FALLBACK
    fi
    log "limit hit; sleeping ${w}s then resuming with context"
    note "limit park ${w}s (attempt $attempt)"
    notify limit-wait "sleeping ${w}s before resume (attempt $attempt)"
    sleep "$w"; continue
  fi

  ambiguous=$((ambiguous + 1))
  log "no sentinel, no limit (rc=$rc); ambiguous exit #$ambiguous/$MAX_AMBIGUOUS"
  [ "$ambiguous" -ge "$MAX_AMBIGUOUS" ] && { log "too many ambiguous exits; aborting"; break; }
  # A wedged resume can fail instantly; after a few tries drop it for a clean fresh run.
  if [ -n "$session_id" ] && [ "$ambiguous" -ge "$AMBIGUOUS_FRESH_AT" ]; then
    log "ambiguous >= $AMBIGUOUS_FRESH_AT; discarding session, next attempt is a fresh run"
    session_id=""; : > "$SESS_FILE"
  fi
  sleep "$AMBIGUOUS_SLEEP"
done

# --- finalize: capture any leftover work, write report, push, record state ---
git add -A >>"$LOGD/run.log" 2>&1
git commit -m "task $ID: autosave uncommitted work" >>"$LOGD/run.log" 2>&1 || true
COMMIT_AFTER="$(git rev-parse HEAD)"

status=failed
if grep -qhF "$SENTINEL" "$LOGD"/attempt-*.jsonl 2>/dev/null && [ "$COMMIT_AFTER" != "$COMMIT_BEFORE" ]; then
  status=done
fi

REPORT="$WT/automation/reports/$ID.md"
mkdir -p "$(dirname "$REPORT")"
{
  echo "# Report — $ID ($status)"
  echo
  echo "- Branch: \`$BRANCH\`"
  echo "- Commit before: \`$COMMIT_BEFORE\`"
  echo "- Commit after:  \`$COMMIT_AFTER\`"
  echo "- Attempts: $attempt"
  echo "- Finished: $(date -u +%FT%TZ)"
  echo
  echo "## Executor final message"
  echo '```'
  jq -r 'select(.type=="result") | .result // empty' "$LOGD"/attempt-*.jsonl 2>/dev/null | tail -60
  echo '```'
} > "$REPORT"

git add -A >>"$LOGD/run.log" 2>&1
git commit -m "report: task $ID ($status)" >>"$LOGD/run.log" 2>&1 || true
git push origin "$BRANCH" >>"$LOGD/run.log" 2>&1 || log "push $BRANCH failed (non-fatal)"

echo "$status" > "$STATE_DIR/$ID"
log "finished status=$status before=$COMMIT_BEFORE after=$COMMIT_AFTER attempts=$attempt"
note "finished $status attempts=$attempt before=$COMMIT_BEFORE after=$COMMIT_AFTER"
notify "$status" "attempts=$attempt commit=$COMMIT_AFTER"
