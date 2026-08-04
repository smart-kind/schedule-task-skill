#!/usr/bin/env bash
# runtime-self-test.sh — VPS-free end-to-end tests for the automation runtime:
#   (a) run-task.sh happy path through a mock coding-agent router
#   (b) run-task.sh limit → park → resume path (agent=kimi envelope)
#   (c) dispatch.sh dependency eligibility + concurrency cap + machine gating,
#       and confirmation that it NEVER merges (workers never merge)
#   (d) coding-agent.sh profiles (claude/kimi) via fake CLI binaries
#   (e) cancel-task.sh: kill running (mock tmux), cascade to dependents, --all
#   (f) merge-batch.sh author-side finalization against a mock git remote
# Everything runs in temp dirs (temp git repos with a copied automation/ tree, temp HOME
# for run-task state). No VPS, no real CLIs, no network. Safe on macOS bash 3.2.
set -uo pipefail

SKILL_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/schedtask-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT

PASS=0; FAIL=0
ok()    { PASS=$((PASS + 1)); printf 'ok   %s\n' "$*"; }
bad()   { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$*"; }
check() { # check <desc> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got [$2] want [$3])"; fi
}

# The production scripts require GNU date (`date -u -d ...`); macOS ships BSD date.
# Nothing below exercises those code paths (dispatch fixtures omit schedule.run_at, and
# no fake CLI emits clock-phrase reset times) — say so plainly instead of faking it.
if ! command -v gdate >/dev/null 2>&1 && ! date -u -d today >/dev/null 2>&1; then
  echo "note: no GNU date (gdate) found — schedule.run_at due-checks and clock-phrase"
  echo "      reset parsing are NOT exercised here. Install coreutils to cover them."
fi

# make_repo <path> — temp git repo on branch `dev` with the skill's automation/ tree.
make_repo() {
  local r="$1"
  mkdir -p "$r"
  git -C "$r" init -q -b dev 2>/dev/null || { git -C "$r" init -q; git -C "$r" symbolic-ref HEAD refs/heads/dev; }
  git -C "$r" config user.email test@example.com
  git -C "$r" config user.name test
  cp -R "$SKILL_REPO/automation" "$r/"
  chmod +x "$r"/automation/*.sh "$r"/automation/hooks/*.sh 2>/dev/null || true
  echo init > "$r/README.md"
  git -C "$r" add -A; git -C "$r" commit -qm init
}

# Mock coding-agent.sh — same interface: <agent> fresh|resume <model> <sessid|-> <prompt>.
# Knobs (env): MOCK_CALLS (append one line per invocation), MOCK_COUNT (per-run counter),
# MOCK_BEHAVIOR = happy | limit, TASK_ID = sentinel id. Cwd is the task worktree, so the
# mock drops a file there to produce the new commit the runner verifies.
MOCK="$T/mock-coding-agent.sh"
cat > "$MOCK" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
printf 'agent=%s mode=%s sessid=%s\n' "$1" "$2" "$4" >> "$MOCK_CALLS"
n=0; [ -f "$MOCK_COUNT" ] && n="$(cat "$MOCK_COUNT")"
n=$((n + 1)); printf '%s' "$n" > "$MOCK_COUNT"
case "$MOCK_BEHAVIOR" in
  happy)
    echo "work $n" > "mock-work-$n.txt"
    printf '{"type":"system","session_id":"sess-123"}\n'
    printf '{"type":"result","result":"all done [[TASK_DONE %s"}\n' "$TASK_ID"
    printf 'session_id=sess-123\n' >&2
    exit 0;;
  limit)
    if [ "$n" -eq 1 ]; then
      # A limited attempt still streams a session id (real CLIs do) → the runner resumes it.
      printf 'session_id=sess-123\n' >&2
      printf 'usage limit reached\n'
      exit 75
    fi
    echo "work $n" > "mock-work-$n.txt"
    printf '{"type":"system","session_id":"sess-123"}\n'
    printf '{"type":"result","result":"all done [[TASK_DONE %s"}\n' "$TASK_ID"
    printf 'session_id=sess-123\n' >&2
    exit 0;;
esac
exit 2
EOF
chmod +x "$MOCK"

# ---------------------------------------------------------------- (a) happy path
echo "== (a) run-task.sh happy path (agent defaults to claude) =="
R1="$T/repo-a"; make_repo "$R1"
cat > "$R1/automation/tasks/t-happy.json" <<'EOF'
{"id":"t-happy","branch":"automation/t-happy","prompt_file":"automation/prompts/t-happy.md","model":"opus"}
EOF
echo "do the thing; end with the TASK_DONE sentinel" > "$R1/automation/prompts/t-happy.md"
git -C "$R1" add -A; git -C "$R1" commit -qm "task t-happy"

H1="$T/home-a"; mkdir -p "$H1"; : > "$T/calls-a"
HOME="$H1" CODING_AGENT_BIN="$MOCK" MOCK_CALLS="$T/calls-a" MOCK_COUNT="$T/count-a" \
MOCK_BEHAVIOR=happy TASK_ID=t-happy \
  bash "$R1/automation/run-task.sh" t-happy >"$T/a.out" 2>&1
rc=$?
check "a: runner exits 0" "$rc" 0
check "a: state = done" "$(cat "$R1/automation/state/t-happy" 2>/dev/null)" "done"
WT_A="$H1/.local/state/automation/worktrees/t-happy"
[ -f "$WT_A/automation/reports/t-happy.md" ] && ok "a: report written" || bad "a: report written (missing $WT_A/automation/reports/t-happy.md)"
grep -q '(done)' "$WT_A/automation/reports/t-happy.md" 2>/dev/null && ok "a: report says done" || bad "a: report says done"
NOTES_A="$R1/automation/state/t-happy.notes"
[ -s "$NOTES_A" ] && ok "a: notes file has lines" || bad "a: notes file has lines"
grep -q 'start agent=claude model=opus branch=automation/t-happy' "$NOTES_A" 2>/dev/null && ok "a: notes: start line" || bad "a: notes: start line"
grep -q 'TASK_DONE detected' "$NOTES_A" 2>/dev/null && ok "a: notes: TASK_DONE line" || bad "a: notes: TASK_DONE line"
grep -q 'finished done' "$NOTES_A" 2>/dev/null && ok "a: notes: finished line" || bad "a: notes: finished line"
check "a: session id persisted" "$(cat "$H1/.local/state/automation/t-happy/session_id" 2>/dev/null)" "sess-123"
grep -q 'agent=claude mode=fresh sessid=-' "$T/calls-a" 2>/dev/null && ok "a: fresh attempt routed through router" || bad "a: fresh attempt routed through router"

# ---------------------------------------------------- (b) limit → park → resume
echo "== (b) run-task.sh limit park + resume (agent=kimi, LIMIT_FALLBACK=1) =="
R2="$T/repo-b"; make_repo "$R2"
cat > "$R2/automation/tasks/t-limit.json" <<'EOF'
{"id":"t-limit","branch":"automation/t-limit","prompt_file":"automation/prompts/t-limit.md","model":"kimi-k2","agent":"kimi"}
EOF
echo "do the thing; end with the TASK_DONE sentinel" > "$R2/automation/prompts/t-limit.md"
git -C "$R2" add -A; git -C "$R2" commit -qm "task t-limit"

H2="$T/home-b"; mkdir -p "$H2"; : > "$T/calls-b"
HOME="$H2" CODING_AGENT_BIN="$MOCK" MOCK_CALLS="$T/calls-b" MOCK_COUNT="$T/count-b" \
MOCK_BEHAVIOR=limit TASK_ID=t-limit LIMIT_FALLBACK=1 \
  bash "$R2/automation/run-task.sh" t-limit >"$T/b.out" 2>&1
rc=$?
check "b: runner exits 0" "$rc" 0
check "b: state = done" "$(cat "$R2/automation/state/t-limit" 2>/dev/null)" "done"
grep -q 'agent=kimi mode=resume sessid=sess-123' "$T/calls-b" 2>/dev/null && ok "b: resume happened with parked session" || bad "b: resume happened with parked session"
grep -q 'limit park 1s' "$R2/automation/state/t-limit.notes" 2>/dev/null && ok "b: notes: limit park line" || bad "b: notes: limit park line"
check "b: attempts = 2" "$(wc -l < "$T/calls-b" | tr -d ' ')" "2"

# ----------------------------- (c) dispatch eligibility + concurrency + machine gating
echo "== (c) dispatch.sh eligibility, concurrency cap, machine gating, NO merge =="
R3="$T/repo-c"; make_repo "$R3"
# Task branches with real (tiny, conflict-free) commits off dev.
for t in A B C; do
  git -C "$R3" checkout -qb "automation/$t" dev
  echo "$t" > "$R3/file-$t.txt"
  git -C "$R3" add -A; git -C "$R3" commit -qm "branch $t"
done
git -C "$R3" checkout -q dev
for t in A B; do
  cat > "$R3/automation/tasks/$t.json" <<EOF
{"id":"$t","batch":"b1","branch":"automation/$t","prompt_file":"automation/prompts/$t.md"}
EOF
done
cat > "$R3/automation/tasks/C.json" <<'EOF'
{"id":"C","batch":"b1","branch":"automation/C","prompt_file":"automation/prompts/C.md","depends_on":["A","B"]}
EOF
for t in A B C; do echo "prompt $t" > "$R3/automation/prompts/$t.md"; done
cat > "$R3/automation/batches/b1.json" <<'EOF'
{"id":"b1","title":"test batch","notes":"","tasks":["A","B","C"],"merge_target":"dev"}
EOF
git -C "$R3" add -A; git -C "$R3" commit -qm "batch b1 fixtures"

# Mock tmux: record `new-session -d -s <name> ...` session names, launch nothing.
# has-session consults $MOCK_TMUX_LIVE (one session name per line); kill-session records.
cat > "$T/tmux" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  new-session) printf '%s\n' "$4" >> "$MOCK_TMUX_CALLS";;
  has-session) grep -qx "$3" "${MOCK_TMUX_LIVE:-/dev/null}" 2>/dev/null; exit $?;;
  kill-session) printf 'killed %s\n' "$3" >> "$MOCK_TMUX_CALLS";;
esac
exit 0
EOF
chmod +x "$T/tmux"
: > "$T/tmux-calls"
tick() { MOCK_TMUX_CALLS="$T/tmux-calls" PATH="$T:$PATH" FL_MAX_CONCURRENCY="$1" bash "$R3/automation/dispatch.sh"; }

tick 1 >"$T/c1.out" 2>&1   # cap=1: only the first eligible task launches
check "c: tick1 (cap=1) launches only A" "$(cat "$T/tmux-calls")" "task-A"

echo running > "$R3/automation/state/A"   # simulate A actually running
tick 2 >"$T/c2.out" 2>&1   # cap=2: one free slot → B launches; C still blocked by deps
check "c: tick2 launches B, not C" "$(tail -1 "$T/tmux-calls")" "task-B"
check "c: tick2 total launched" "$(wc -l < "$T/tmux-calls" | tr -d ' ')" "2"

echo done > "$R3/automation/state/A"      # A and B finish
echo done > "$R3/automation/state/B"
tick 2 >"$T/c3.out" 2>&1   # deps satisfied → C launches
check "c: tick3 launches C once deps done" "$(tail -1 "$T/tmux-calls")" "task-C"

echo done > "$R3/automation/state/C"      # whole batch done — but workers never merge
tick 2 >"$T/c4.out" 2>&1
[ -f "$R3/automation/state/batch-b1" ] && bad "c: worker wrote a batch merge state (must not)" || ok "c: worker wrote a batch merge state (must not)"
for t in A B C; do
  [ -f "$R3/file-$t.txt" ] && bad "c: branch $t landed on dev (worker must not merge)" || ok "c: branch $t not landed on dev"
done
check "c: done tick launched nothing" "$(wc -l < "$T/tmux-calls" | tr -d ' ')" "3"

# Machine gating (separate repo): no .machine → unassigned tasks launch, mismatched
# .worker is skipped; role=author dispatches nothing; matching id launches the task.
R3B="$T/repo-c2"; make_repo "$R3B"
cat > "$R3B/automation/tasks/M1.json" <<'EOF'
{"id":"M1","branch":"automation/M1","prompt_file":"automation/prompts/M1.md"}
EOF
cat > "$R3B/automation/tasks/M2.json" <<'EOF'
{"id":"M2","worker":"other-box","branch":"automation/M2","prompt_file":"automation/prompts/M2.md"}
EOF
for t in M1 M2; do echo "prompt $t" > "$R3B/automation/prompts/$t.md"; done
git -C "$R3B" add -A; git -C "$R3B" commit -qm "gating fixtures"
tick2() { MOCK_TMUX_CALLS="$T/tmux-calls" PATH="$T:$PATH" FL_MAX_CONCURRENCY=2 bash "$R3B/automation/dispatch.sh"; }
: > "$T/tmux-calls"
tick2 >"$T/c5.out" 2>&1   # default: role=worker, id=hostname → M1 launches, M2 skipped
check "c: unassigned task launches (no .machine)" "$(cat "$T/tmux-calls")" "task-M1"
mkdir -p "$R3B/automation/state"
printf 'role=author\nid=hostbox\n' > "$R3B/automation/state/.machine"
: > "$T/tmux-calls"
tick2 >"$T/c6.out" 2>&1   # role=author → nothing dispatches
check "c: role=author dispatches nothing" "$(wc -l < "$T/tmux-calls" | tr -d ' ')" "0"
printf 'role=worker\nid=other-box\n' > "$R3B/automation/state/.machine"
echo done > "$R3B/automation/state/M1"
tick2 >"$T/c7.out" 2>&1   # id matches → assigned task launches
check "c: matching worker id launches assigned task" "$(cat "$T/tmux-calls")" "task-M2"

# ------------------------------------------------------- (d) coding-agent.sh profiles
echo "== (d) coding-agent.sh profiles (fake CLIs) =="
CA="$SKILL_REPO/automation/coding-agent.sh"

FAKEC="$T/fake-claude"   # claude: normal exit, session id in system event
cat > "$FAKEC" <<'EOF'
#!/usr/bin/env bash
printf '{"type":"system","session_id":"csess-1"}\n{"type":"result","result":"ok"}\n'
exit 0
EOF
chmod +x "$FAKEC"
CLAUDE_BIN="$FAKEC" bash "$CA" claude fresh opus - "hi" >"$T/d1.out" 2>"$T/d1.err"; rc=$?
check "d: claude normal rc=0" "$rc" 0
check "d: claude stdout verbatim" "$(grep -c '^{' "$T/d1.out")" "2"
check "d: claude session_id on stderr" "$(grep '^session_id=' "$T/d1.err")" "session_id=csess-1"

FAKEC2="$T/fake-claude-limit"   # claude: limit text + future epoch, non-zero CLI exit
EPOCH="$(( $(date -u +%s) + 3600 ))"
cat > "$FAKEC2" <<EOF
#!/usr/bin/env bash
printf '{"type":"system","session_id":"csess-2"}\n'
printf 'You hit your usage limit; resets at %s\n' "$EPOCH"
exit 1
EOF
chmod +x "$FAKEC2"
CLAUDE_BIN="$FAKEC2" bash "$CA" claude resume opus csess-2 "continue" >"$T/d2.out" 2>"$T/d2.err"; rc=$?
check "d: claude limit rc=75 (CLI rc=1 overridden)" "$rc" 75
check "d: claude reset_epoch on stderr" "$(grep '^reset_epoch=' "$T/d2.err")" "reset_epoch=$EPOCH"
check "d: claude session_id still reported" "$(grep '^session_id=' "$T/d2.err")" "session_id=csess-2"

FAKEK="$T/fake-kimi-limit"   # kimi: meta session id + 429 event
cat > "$FAKEK" <<'EOF'
#!/usr/bin/env bash
printf '{"type":"meta","session_id":"ksess-9","reason":"session.resume_hint"}\n'
printf '{"type":"error","message":"APIProviderRateLimitError"}\n'
exit 1
EOF
chmod +x "$FAKEK"
KIMI_BIN="$FAKEK" bash "$CA" kimi fresh kimi-k2 - "hi" >"$T/d3.out" 2>"$T/d3.err"; rc=$?
check "d: kimi 429 rc=75" "$rc" 75
check "d: kimi session_id from meta event" "$(grep '^session_id=' "$T/d3.err")" "session_id=ksess-9"
check "d: kimi has no reset_epoch" "$(grep -c '^reset_epoch=' "$T/d3.err")" "0"

FAKEK2="$T/fake-kimi-ok"   # kimi: normal exit
cat > "$FAKEK2" <<'EOF'
#!/usr/bin/env bash
printf '{"type":"meta","session_id":"ksess-1","reason":"session.resume_hint"}\n'
printf '{"type":"result","result":"ok"}\n'
exit 0
EOF
chmod +x "$FAKEK2"
KIMI_BIN="$FAKEK2" bash "$CA" kimi resume kimi-k2 ksess-1 "continue" >"$T/d4.out" 2>"$T/d4.err"; rc=$?
check "d: kimi normal rc=0" "$rc" 0

# ------------------------- (e) cancel-task.sh: kill, cascade, --all, batch interplay
echo "== (e) cancel-task.sh =="
R4="$T/repo-e"; make_repo "$R4"
git -C "$R4" checkout -qb "automation/P" dev
echo P > "$R4/file-P.txt"; git -C "$R4" add -A; git -C "$R4" commit -qm "branch P"
git -C "$R4" checkout -q dev
# X = pending singleton; Y(running)+Z(depends_on Y) = batch b2; P(done)+Q = batch b3.
cat > "$R4/automation/tasks/X.json" <<'EOF'
{"id":"X","branch":"automation/X","prompt_file":"automation/prompts/X.md"}
EOF
cat > "$R4/automation/tasks/Y.json" <<'EOF'
{"id":"Y","batch":"b2","branch":"automation/Y","prompt_file":"automation/prompts/Y.md"}
EOF
cat > "$R4/automation/tasks/Z.json" <<'EOF'
{"id":"Z","batch":"b2","branch":"automation/Z","prompt_file":"automation/prompts/Z.md","depends_on":["Y"]}
EOF
cat > "$R4/automation/tasks/P.json" <<'EOF'
{"id":"P","batch":"b3","branch":"automation/P","prompt_file":"automation/prompts/P.md"}
EOF
cat > "$R4/automation/tasks/Q.json" <<'EOF'
{"id":"Q","batch":"b3","branch":"automation/Q","prompt_file":"automation/prompts/Q.md"}
EOF
cat > "$R4/automation/batches/b2.json" <<'EOF'
{"id":"b2","title":"cancel batch","notes":"","tasks":["Y","Z"],"merge_target":"dev"}
EOF
cat > "$R4/automation/batches/b3.json" <<'EOF'
{"id":"b3","title":"partial batch","notes":"","tasks":["P","Q"],"merge_target":"dev"}
EOF
for t in X Y Z P Q; do echo "prompt $t" > "$R4/automation/prompts/$t.md"; done
git -C "$R4" add -A; git -C "$R4" commit -qm "cancel fixtures"
mkdir -p "$R4/automation/state"   # make_repo doesn't create the gitignored state dir
echo running > "$R4/automation/state/Y"
echo done    > "$R4/automation/state/P"
echo task-Y > "$T/tmux-live"; : > "$T/tmux-calls-e"
CAN="$R4/automation/cancel-task.sh"
cancel_e() { MOCK_TMUX_LIVE="$T/tmux-live" MOCK_TMUX_CALLS="$T/tmux-calls-e" PATH="$T:$PATH" bash "$CAN" "$@"; }
tick_e() { MOCK_TMUX_CALLS="$T/tmux-calls-e" MOCK_TMUX_LIVE="$T/tmux-live" PATH="$T:$PATH" FL_MAX_CONCURRENCY=2 bash "$R4/automation/dispatch.sh"; }

cancel_e Y no longer needed >"$T/e1.out" 2>&1
check "e: running task cancelled" "$(cat "$R4/automation/state/Y")" "cancelled"
check "e: tmux session killed" "$(grep -c 'killed task-Y' "$T/tmux-calls-e")" "1"
check "e: cascade cancels dependent" "$(cat "$R4/automation/state/Z")" "cancelled"
grep -q 'cancelled: dependency Y cancelled' "$R4/automation/state/Z.notes" 2>/dev/null && ok "e: cascade reason recorded" || bad "e: cascade reason recorded"
[ -f "$R4/automation/state/X" ] && bad "e: unrelated task untouched" || ok "e: unrelated task untouched"

cancel_e P >"$T/e2.out" 2>&1
grep -q "is 'done' — nothing to cancel" "$T/e2.out" 2>/dev/null && ok "e: done task refused" || bad "e: done task refused"

cancel_e Q superseded >"$T/e3.out" 2>&1
check "e: pending task cancelled" "$(cat "$R4/automation/state/Q")" "cancelled"

tick_e >"$T/e4.out" 2>&1   # only X is still dispatchable; batches are NOT touched by workers
check "e: dispatch skips cancelled, launches X" "$(grep -c 'task-X' "$T/tmux-calls-e")" "1"
[ -f "$R4/automation/state/batch-b2" ] && bad "e: worker wrote batch state for all-cancelled batch (must not)" || ok "e: worker wrote batch state for all-cancelled batch (must not)"
[ -f "$R4/automation/state/batch-b3" ] && bad "e: worker wrote batch state for partial batch (must not)" || ok "e: worker wrote batch state for partial batch (must not)"
[ -f "$R4/file-P.txt" ] && bad "e: worker merged a done branch (must not)" || ok "e: worker merged a done branch (must not)"

cancel_e --all cleanup >"$T/e5.out" 2>&1
check "e: --all cancels remaining pending" "$(cat "$R4/automation/state/X")" "cancelled"
tick_e >"$T/e6.out" 2>&1
check "e: nothing left to launch" "$(wc -l < "$T/tmux-calls-e" | tr -d ' ')" "2"

# ------------------------------------------- (f) merge-batch.sh author-side finalization
echo "== (f) merge-batch.sh (author-side batch finalization) =="
R5="$T/repo-f"; make_repo "$R5"
ORIGIN="$T/origin-f"; git -C "$R5" init -q --bare "$ORIGIN"
git -C "$R5" remote add origin "$ORIGIN"
git -C "$R5" push -q origin dev
# Task branches off dev; T1/T2 carry a (done) report, T3 has NO report (still running).
for t in T1 T2 T3; do
  git -C "$R5" checkout -qb "automation/$t" dev
  echo "$t" > "$R5/file-$t.txt"
  if [ "$t" != T3 ]; then
    mkdir -p "$R5/automation/reports"
    printf '# Report — %s (done)\n- Attempts: 1\n- Finished: now\n' "$t" > "$R5/automation/reports/$t.md"
  fi
  git -C "$R5" add -A; git -C "$R5" commit -qm "task $t"
  git -C "$R5" push -q origin "automation/$t"
done
git -C "$R5" checkout -q dev
for t in T1 T2 T3; do
  cat > "$R5/automation/tasks/$t.json" <<EOF
{"id":"$t","batch":"b1","branch":"automation/$t","prompt_file":"automation/prompts/$t.md"}
EOF
done
cat > "$R5/automation/batches/b1.json" <<'EOF'
{"id":"b1","title":"merge batch","notes":"","tasks":["T1","T2","T3"],"merge_target":"dev"}
EOF
git -C "$R5" add -A; git -C "$R5" commit -qm "merge fixtures"
git -C "$R5" push -q origin dev

bash "$R5/automation/merge-batch.sh" b1 >"$T/f.out" 2>&1
check "f: merge-batch exits 0" "$?" "0"
[ -f "$R5/file-T1.txt" ] && ok "f: T1 branch landed on dev" || bad "f: T1 branch landed on dev"
[ -f "$R5/file-T2.txt" ] && ok "f: T2 branch landed on dev" || bad "f: T2 branch landed on dev"
[ -f "$R5/file-T3.txt" ] && bad "f: T3 landed despite no done report (must not)" || ok "f: T3 not landed (no done report)"
grep -q 'skipped 1' "$T/f.out" 2>/dev/null && ok "f: skipped task reported" || bad "f: skipped task reported"
git -C "$R5" fetch -q origin
git -C "$R5" show "origin/dev:file-T1.txt" >/dev/null 2>&1 && ok "f: merge pushed to origin/dev" || bad "f: merge pushed to origin/dev"

echo
echo "runtime-self-test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
