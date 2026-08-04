#!/usr/bin/env bash
# install.sh — symlink this skill repo into the skill directories of every
# SKILL.md-compatible agent whose parent config dir exists:
#   ~/.agents/skills/schedule-task    (Kimi Code, Codex — native)
#   ~/.claude/skills/schedule-task    (Claude Code — does not read .agents)
#   ~/.kimi-code/skills/schedule-task (Kimi Code's own dir)
# Idempotent: existing entries are reported as SKIP, never overwritten.
# Usage: ./install.sh [--dry-run]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

run() { # print, then execute unless dry-run
  echo "+ $*"
  [ "$DRY_RUN" -eq 0 ] && "$@"
  return 0
}

linked=0; skipped=0; absent=0

for parent in "$HOME/.agents" "$HOME/.claude" "$HOME/.kimi-code"; do
  skills="$parent/skills"
  dest="$skills/schedule-task"
  if [ ! -d "$parent" ]; then
    echo "ABSENT  $parent (not installed) — skipping"
    absent=$((absent + 1))
    continue
  fi
  [ -d "$skills" ] || run mkdir -p "$skills"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    target="$(readlink "$dest" 2>/dev/null || echo "(real directory)")"
    echo "SKIP    $dest already exists -> $target"
    skipped=$((skipped + 1))
    continue
  fi
  run ln -s "$REPO_ROOT" "$dest"
  echo "LINKED  $dest -> $REPO_ROOT"
  linked=$((linked + 1))
done

echo "----"
echo "install.sh: $linked linked, $skipped skipped, $absent parent(s) absent$([ "$DRY_RUN" -eq 1 ] && echo ' (dry-run — nothing changed)')"
echo "Kimi Code and Codex pick up ~/.agents/skills automatically;"
echo "Claude Code picks up ~/.claude/skills."
