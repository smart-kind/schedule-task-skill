#!/usr/bin/env bash
# install.sh — symlink this skill repo into the skill directories of every
# SKILL.md-compatible agent whose parent config dir exists:
#   ~/.agents/skills/schedule-task    (Kimi Code, Codex — native)
#   ~/.claude/skills/schedule-task    (Claude Code — does not read .agents)
#   ~/.kimi-code/skills/schedule-task (Kimi Code's own dir)
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

echo "----"
echo "install.sh: $linked linked, $replaced replaced, $skipped skipped, $absent parent(s) absent$([ "$DRY_RUN" -eq 1 ] && echo ' (dry-run — nothing changed)')"
echo "Kimi Code and Codex pick up ~/.agents/skills automatically;"
echo "Claude Code picks up ~/.claude/skills."
