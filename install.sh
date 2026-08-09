#!/usr/bin/env bash
# install.sh — three-layer install of schedule-task. Works two ways:
#   A. From a clone:     git clone <repo> && cd <repo> && ./install.sh
#   B. From a URL (public repo): curl -fsSL <raw install.sh URL> | bash
#
# Three layers (see docs/refactor-three-layer-separation.md):
#   1. TOOL layer — the CLI: `npm install -g <source>`, once per machine. The
#      `schedule-task` command is the runtime everywhere.
#   2. KNOWLEDGE layer — the skill (SKILL.md/references/templates; bin/src as
#      reference only) copied into each agent's skills dir as a REAL copy (no
#      symlinks — same layout on macOS and a VPS), then .git and graphify-out
#      are deleted from the copy and .installed-from is stamped.
#   3. DATA layer — per-project .schedule-tasks-data/, created and managed by
#      the CLI (init/migrate), committed with git — this script never touches it.
#
# Flow:
#   1. If not running inside the repo (no repo markers in cwd), clone the repo
#      into ~/.local/share/schedule-task/src first, then work from there.
#   2. npm install -g the CLI (skipped with a warning when npm is missing).
#   3. Ask which agent platform(s) to install the skill into
#      (kimi-code / claude / agents), or take --platform / --yes.
#
# Non-interactive: --platform=kimi-code,claude,agents (or all) and/or --yes.
# Idempotent: existing copies are SKIPped unless --update replaces them; the
# npm global install is refreshed on every run.
#
# Usage: ./install.sh [--platform=kimi-code,claude|all] [--yes] [--update] [--dry-run]
set -uo pipefail

REPO_URL="${SCHEDULE_TASK_REPO_URL:-https://github.com/smart-kind/schedule-task-skill.git}"
STATE_DIR="$HOME/.local/share/schedule-task"
SRC_DIR="$STATE_DIR/src"
DRY_RUN=0
UPDATE=0
YES=0
SKIP_GLOBAL=0
PLATFORM_ARG=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --update)  UPDATE=1 ;;
    --yes)     YES=1 ;;
    --skip-global) SKIP_GLOBAL=1 ;;
    --platform=*) PLATFORM_ARG="${arg#--platform=}" ;;
    *) echo "install.sh: unknown option '$arg' (use --platform=all or --platform=kimi-code,claude)" >&2; exit 2 ;;
  esac
done

run() { # print to stderr (stdout may be a pipe), then execute unless dry-run
  echo "+ $*" >&2
  [ "$DRY_RUN" -eq 0 ] && "$@"
  return 0
}

# --- Source: are we inside the repo, or fetched from a URL? ---
if [ -f package.json ] && [ -d bin ] && [ -d src ] && [ -f SKILL.md ]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "source: running inside the repo ($REPO_ROOT)"
  if [ "$UPDATE" -eq 1 ] && [ -d "$REPO_ROOT/.git" ]; then
    echo "update: pulling latest skill source..."
    run git -C "$REPO_ROOT" pull origin main
  fi
else
  echo "source: not inside the repo — cloning into $SRC_DIR"
  if [ "$DRY_RUN" -eq 0 ] || [ "$UPDATE" -eq 1 ] || [ ! -d "$SRC_DIR/package.json" ]; then
    run rm -rf "$SRC_DIR"
    run mkdir -p "$STATE_DIR"
    run git clone --depth 1 "$REPO_URL" "$SRC_DIR"
  fi
  REPO_ROOT="$SRC_DIR"
fi
[ "$UPDATE" -eq 1 ] && echo "----"

MARKER=".installed-from"
copied=0; skipped=0; absent=0; replaced=0

# Copy the skill into $parent/skills/schedule-task as a plain directory copy,
# minus VCS metadata and the machine-local graphify-out/ artifacts.
copy_skill() {
  local parent="$1"
  local skills="$parent/skills"
  local dest="$skills/schedule-task"
  if [ ! -d "$parent" ]; then
    echo "ABSENT  $parent (not installed) — skipped"
    absent=$((absent + 1))
    return
  fi
  [ -d "$skills" ] || run mkdir -p "$skills"

  if [ -f "$dest/$MARKER" ]; then
    if [ "$UPDATE" -eq 1 ]; then
      echo "REPLACE $dest (copy from $REPO_ROOT)"
      run rm -rf "$dest"
      copy_skill_into "$dest"
      replaced=$((replaced + 1))
    else
      echo "SKIP    $dest already a schedule-task copy (use --update to replace)"
      skipped=$((skipped + 1))
    fi
  elif [ -L "$dest" ]; then
    # Old global-install-era symlink leftover (no marker): never convert
    # silently. Plain installs only warn; --update is the fix path (replaces
    # the symlink with a fresh copy), or delete it by hand and reinstall.
    if [ "$UPDATE" -eq 1 ]; then
      echo "REPLACE $dest (old-scheme symlink -> $(readlink "$dest" 2>/dev/null || echo '?') — replacing with a fresh copy)"
      run rm "$dest"
      copy_skill_into "$dest"
      replaced=$((replaced + 1))
    else
      echo "NOTE    $dest is an old-scheme symlink (旧方案) — use --update, or delete it manually and reinstall"
      skipped=$((skipped + 1))
    fi
  elif [ -e "$dest" ]; then
    echo "SKIP    $dest exists but is not a schedule-task copy; refusing to touch it"
    skipped=$((skipped + 1))
  else
    copy_skill_into "$dest"
    echo "COPIED  $dest (from $REPO_ROOT)"
    copied=$((copied + 1))
  fi
}

# Plain copy, then drop .git and graphify-out from the copy, then stamp.
copy_skill_into() {
  local dest="$1"
  run mkdir -p "$dest"
  run cp -R "$REPO_ROOT/." "$dest/"
  run rm -rf "$dest/.git" "$dest/graphify-out"
  run sh -c "printf '%s\n' '$REPO_ROOT' > '$dest/$MARKER'"
}

# --- Which platforms? ---
# (bash 3.2 on macOS has no associative arrays — use a case map instead)
platform_dir() {
  case "$1" in
    kimi-code) echo "$HOME/.kimi-code" ;;
    claude)    echo "$HOME/.claude" ;;
    agents)    echo "$HOME/.agents" ;;
    *)         echo "" ;;
  esac
}

echo "schedule-task installer — source: $REPO_ROOT"
echo "Detected agent platforms:"
SELECT=""
for name in kimi-code claude agents; do
  dir="$(platform_dir "$name")"
  if [ -d "$dir" ]; then
    echo "  [x] $name  ($dir)"
    SELECT="$SELECT,$name"
  else
    echo "  [ ] $name  ($dir — not installed)"
  fi
done
SELECT="${SELECT#,}"

if [ -n "$PLATFORM_ARG" ]; then
  if [ "$PLATFORM_ARG" != "all" ]; then
    SELECT="$PLATFORM_ARG"
  fi
elif [ "$YES" -eq 0 ] && [ -t 0 ]; then
  printf 'Install the skill into which platform(s)? [%s, none] (default: %s) ' "$SELECT" "$SELECT"
  read -r ANSWER
  if [ -n "$ANSWER" ] && [ "$ANSWER" != "all" ]; then
    SELECT="$ANSWER"
  fi
fi

if [ "$SELECT" = "none" ] || [ -z "$SELECT" ]; then
  echo "no skill copy requested — only the global CLI will be installed."
fi

IFS=',' read -r -a SELECTED <<< "$SELECT"
for name in "${SELECTED[@]}"; do
  name="$(echo "$name" | tr -d ' ')"
  [ -z "$name" ] && continue
  case "$name" in
    kimi-code|claude|agents) copy_skill "$(platform_dir "$name")" ;;
    *) echo "SKIP    unknown platform '$name' (want kimi-code|claude|agents)" ;;
  esac
done

echo "----"
# Tool layer: the global CLI, one copy per machine, used by every skill copy.
# `npm install -g <repo>` installs bin/schedule-task.js + src/ into the npm
# prefix; the `schedule-task` command then works from anywhere. update.js passes
# --skip-global because it already ran the npm install itself.
if [ "$SKIP_GLOBAL" -eq 1 ]; then
  echo "CLI: global install skipped (--skip-global — already installed by \`schedule-task update\`)"
elif command -v npm >/dev/null 2>&1; then
  echo "CLI: npm install -g \"$REPO_ROOT\" (global command: schedule-task)"
  run npm install -g "$REPO_ROOT"
else
  echo "WARN npm not found — the global \`schedule-task\` CLI was NOT installed."
  echo "     install node/npm first, then re-run ./install.sh (the skill copies above"
  echo "     still work standalone via node <copy>/bin/schedule-task.js)."
fi

echo "----"
echo "install.sh: $copied copied, $replaced replaced, $skipped skipped, $absent parent(s) absent$([ "$DRY_RUN" -eq 1 ] && echo ' (dry-run — nothing changed)')"
echo "Three-layer separation:"
echo "  tool      — global CLI \`schedule-task\` (npm install -g$([ "$DRY_RUN" -eq 1 ] && echo ' — dry-run, not executed' || echo ' — done above'))"
echo "  knowledge — skill copies in each agent's skills/schedule-task (SKILL.md/references/templates; bin/src reference-only)"
echo "  data      — per project .schedule-tasks-data/ (created by \`schedule-task init\`, rides git)"
echo "Run the CLI as: schedule-task <subcommand>  (e.g. schedule-task doctor)"
echo "To update later, re-run ./install.sh --update (or the curl one-liner) after a new release."
echo "Old ~/.local/bin/schedule-task symlink leftovers are unused — remove them by hand at your convenience."
