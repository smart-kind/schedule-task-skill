#!/usr/bin/env bash
# coding-agent.sh <agent> fresh|resume <model> <session-id-or-dash> <prompt-text>
# CLI router: one profile per coding CLI (claude / kimi), each encapsulating the four
# things run-task.sh must never see — invocation flags, session-resume flags, session-id
# extraction, and usage-limit detection. The CLI's stream-json goes to STDOUT verbatim
# (tee'd to a temp copy for post-analysis). After the CLI exits, exactly one
# `session_id=<id>` line goes to STDERR if one could be extracted; on a limit exit a
# `reset_epoch=<epoch>` line is added when a reset time could be parsed (claude only —
# kimi's 429s are transient and retried inside the CLI, so there is nothing to parse).
# Exit codes: 0 = CLI exited normally (task completion is NOT judged here — the caller
# checks the TASK_DONE sentinel); 75 = usage/session/rate limit (caller parks, then
# resumes); anything else = ambiguous failure (caller applies its retry policy).
set -uo pipefail

# cron runs with a sparse environment — pin HOME and PATH so jq/date/CLIs resolve.
export HOME="${HOME:-/home/david}"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

AGENT="${1:?usage: coding-agent.sh <agent> fresh|resume <model> <session-id-or-dash> <prompt-text>}"
MODE="${2:?mode must be fresh|resume}"
MODEL="${3:?model required}"
SESSID="${4:?session id or - required}"
PROMPT="${5:?prompt text required}"
[ "$MODE" = fresh ] || [ "$MODE" = resume ] || { echo "mode must be fresh|resume" >&2; exit 2; }

CLAUDE="${CLAUDE_BIN:-claude}"   # override to pin the binary path (or mock in tests)
KIMI="${KIMI_BIN:-kimi}"

# Resume without a session id is meaningless — degrade to a fresh invocation.
[ "$MODE" = resume ] && [ "$SESSID" = "-" ] && MODE=fresh

OUT="$(mktemp "${TMPDIR:-/tmp}/coding-agent.XXXXXX")"
trap 'rm -f "$OUT"' EXIT

# --- invoke the CLI; tee keeps stdout a verbatim stream while we keep a copy ---
case "$AGENT" in
  claude)
    if [ "$MODE" = resume ]; then
      "$CLAUDE" -p "$PROMPT" --resume "$SESSID" \
        --model "$MODEL" --fallback-model sonnet --dangerously-skip-permissions \
        --output-format stream-json --verbose | tee "$OUT"
    else
      "$CLAUDE" -p "$PROMPT" \
        --model "$MODEL" --fallback-model sonnet --dangerously-skip-permissions \
        --output-format stream-json --verbose | tee "$OUT"
    fi
    ;;
  kimi)
    # NOTE: no --yolo/--auto — kimi rejects them with -p; -p already runs tools
    # autonomously. Resume is `-S <session-id>` (verified live).
    if [ "$MODE" = resume ]; then
      "$KIMI" -p "$PROMPT" -S "$SESSID" -m "$MODEL" --output-format stream-json | tee "$OUT"
    else
      "$KIMI" -p "$PROMPT" -m "$MODEL" --output-format stream-json | tee "$OUT"
    fi
    ;;
  *)
    echo "unknown agent: $AGENT (want claude|kimi)" >&2; exit 2;;
esac
rc=${PIPESTATUS[0]}   # the CLI's code, not tee's

# --- session id extraction (first matching event wins) ---
sid=""
case "$AGENT" in
  # claude: the opening system event. kimi: the session.resume_hint meta event.
  claude) sid="$(jq -r 'select(.type=="system") | .session_id // empty' "$OUT" 2>/dev/null | sed -n '1p')";;
  kimi)   sid="$(jq -r 'select(.type=="meta" and .session_id) | .session_id // empty' "$OUT" 2>/dev/null | sed -n '1p')";;
esac
[ -n "$sid" ] && printf 'session_id=%s\n' "$sid" >&2

# --- limit detection: per-CLI patterns, signalled uniformly as exit 75 ---
limit=0
case "$AGENT" in
  # Both "usage limit" AND "session limit" park-and-resume (the original pattern missed
  # the session-limit wording → it was misread as an ambiguous exit and aborted).
  claude) grep -qiE 'usage limit|rate limit|session limit|limit reached|hit your (usage|session) limit|resets? (at|[0-9])' "$OUT" 2>/dev/null && limit=1;;
  # kimi: 429s surface as APIProviderRateLimitError events; the CLI retries internally,
  # so reaching us means it gave up — park, but there is no reset time to parse.
  kimi)   grep -qE 'APIProviderRateLimitError|"status_code":429|rate limit' "$OUT" 2>/dev/null && limit=1;;
esac

if [ "$limit" -eq 1 ]; then
  if [ "$AGENT" = claude ]; then
    # Reset time may be a 10-digit epoch OR a clock phrase like "resets 11am (UTC)".
    now="$(date -u +%s)"
    ep="$(grep -m1 -oE '[0-9]{10}' "$OUT" 2>/dev/null)"
    if [ -n "$ep" ] && [ "$ep" -gt "$now" ] && [ "$ep" -lt "$((now + 700000))" ]; then
      printf 'reset_epoch=%s\n' "$ep" >&2
    else
      rt="$(grep -m1 -oiE 'resets? [0-9]{1,2} ?(am|pm)' "$OUT" 2>/dev/null | grep -oiE '[0-9]{1,2} ?(am|pm)')"
      cand=0
      if [ -n "$rt" ]; then
        # Resolve to today's (or tomorrow's, if already past) UTC instant of that hour.
        cand="$(date -u -d "today $rt" +%s 2>/dev/null || echo 0)"
        [ "$cand" -le "$now" ] && cand="$(date -u -d "tomorrow $rt" +%s 2>/dev/null || echo 0)"
      fi
      if [ "$cand" -gt "$now" ] && [ "$cand" -lt "$((now + 700000))" ]; then
        printf 'reset_epoch=%s\n' "$cand" >&2
      fi
      # No parseable reset time → no reset_epoch line; the caller uses its fallback wait.
    fi
  fi
  exit 75
fi

exit "$rc"
