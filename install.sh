#!/usr/bin/env bash
# install.sh — install the schedule-task skill + CLI.
#  1. Symlink this skill repo into the skill directories of every SKILL.md-compatible
#     agent whose parent config dir exists:
#       ~/.agents/skills/schedule-task    (Kimi Code, Codex — native)
#       ~/.claude/skills/schedule-task    (Claude Code — does not read .agents)
#       ~/.kimi-code/skills/schedule-task (Kimi Code's own dir)
#  2. Link the CLI into ~/.local/bin/schedule-task so `schedule-task` is on PATH
#     (no npm needed). `npm link` / `npm install -g .` / a published npx work too.
# Idempotent: existing entries are reported as SKIP, never overwritten.
# Usage: ./install.sh [--update] [--dry-run]
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
UPDATE=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --update)  UPDATE=1 ;;
    *) echo "install.sh: unknown option '$arg'" >&2; exit 2 ;;
  esac
done

run() { # print, then execute unless dry-run
  echo "+ $*"
  [ "$DRY_RUN" -eq 0 ] && "$@"
  return 0
}

# --update: pull the latest source before re-linking.
if [ "$UPDATE" -eq 1 ]; then
  if [ -d "$REPO_ROOT/.git" ]; then
    echo "update: pulling latest skill source..."
    run git -C "$REPO_ROOT" pull origin main
  else
    echo "update: $REPO_ROOT is not a git repo; skipping git pull" >&2
  fi
  echo "----"
fi

linked=0; skipped=0; absent=0; replaced=0

for parent in "$HOME/.agents" "$HOME/.claude" "$HOME/.kimi-code"; do
  skills="$parent/skills"
  dest="$skills/schedule-task"
  if [ ! -d "$parent" ]; then
    echo "ABSENT  $parent (not installed) — skipping"
    absent=$((absent + 1))
    continue
  fi
  [ -d "$skills" ] || run mkdir -p "$skills"

  if [ -L "$dest" ]; then
    target="$(readlink "$dest" 2>/dev/null || true)"
    if [ "$target" = "$REPO_ROOT" ]; then
      echo "SKIP    $dest already points to $REPO_ROOT"
      skipped=$((skipped + 1))
      continue
    fi
    if [ "$UPDATE" -eq 1 ]; then
      echo "REPLACE $dest was -> $target; relinking to $REPO_ROOT"
      run rm "$dest"
      run ln -s "$REPO_ROOT" "$dest"
      replaced=$((replaced + 1))
    else
      echo "SKIP    $dest already exists -> $target (use --update to replace)"
      skipped=$((skipped + 1))
      continue
    fi
  elif [ -e "$dest" ]; then
    echo "SKIP    $dest exists but is not a symlink (real directory/file); refusing to touch it"
    skipped=$((skipped + 1))
    continue
  else
    run ln -s "$REPO_ROOT" "$dest"
    echo "LINKED  $dest -> $REPO_ROOT"
    linked=$((linked + 1))
  fi
done

# --- CLI link: `schedule-task` on PATH without npm ---
BIN_DIR="$HOME/.local/bin"
CLI_LINK="$BIN_DIR/schedule-task"
CLI_TARGET="$REPO_ROOT/bin/schedule-task.js"
[ -x "$CLI_TARGET" ] || run chmod +x "$CLI_TARGET"
if [ -d "$BIN_DIR" ] || run mkdir -p "$BIN_DIR"; then
  if [ -L "$CLI_LINK" ]; then
    if [ "$(readlink "$CLI_LINK" 2>/dev/null || true)" = "$CLI_TARGET" ]; then
      echo "SKIP    $CLI_LINK already points to $CLI_TARGET"
      skipped=$((skipped + 1))
    elif [ "$UPDATE" -eq 1 ]; then
      echo "REPLACE $CLI_LINK was -> $(readlink "$CLI_LINK"); relinking to $CLI_TARGET"
      run rm "$CLI_LINK"
      run ln -s "$CLI_TARGET" "$CLI_LINK"
      replaced=$((replaced + 1))
    else
      echo "SKIP    $CLI_LINK already exists -> $(readlink "$CLI_LINK") (use --update to replace)"
      skipped=$((skipped + 1))
    fi
  elif [ -e "$CLI_LINK" ]; then
    echo "SKIP    $CLI_LINK exists but is not a symlink; refusing to touch it"
    skipped=$((skipped + 1))
  else
    run ln -s "$CLI_TARGET" "$CLI_LINK"
    echo "LINKED  $CLI_LINK -> $CLI_TARGET"
    linked=$((linked + 1))
  fi
fi

echo "----"
echo "install.sh: $linked linked, $replaced replaced, $skipped skipped, $absent parent(s) absent$([ "$DRY_RUN" -eq 1 ] && echo ' (dry-run — nothing changed)')"
echo "Kimi Code and Codex pick up ~/.agents/skills automatically;"
echo "Claude Code picks up ~/.claude/skills."
echo "The CLI is linked at ~/.local/bin/schedule-task (add that dir to PATH if needed)."
