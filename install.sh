#!/usr/bin/env bash
# install.sh — install the schedule-task TOOL layer: the global `schedule-task`
# CLI. That is the only thing this script does. Works two ways:
#   A. From a clone:     git clone <repo> && cd <repo> && ./install.sh
#   B. From a URL (public repo): curl -fsSL <raw install.sh URL> | bash
#
# The three layers (see docs/refactor-three-layer-separation.md) are managed by
# different actors — this script is only layer 1:
#   1. TOOL layer — the global CLI (`npm install -g`), one copy per machine.
#   2. KNOWLEDGE layer — SKILL.md/references/templates bound into each agent's
#      skills dir by the CLI itself: `schedule-task install --target all`.
#   3. DATA layer — per-project .schedule-tasks-data/, created and managed by
#      the CLI (init/migrate), committed with git — never touched here.
#
# Mechanism (URL path): clone the repo into a mktemp dir → npm pack → npm
# install -g the tarball → delete the temp clone. The global install is a
# SELF-CONTAINED copy (npm pack + tarball install, never a symlink — a symlink
# would break the moment the temp clone is cleaned up), so it does not depend
# on any source location. The global package also ships the knowledge items
# (SKILL.md/references/templates), which is what `schedule-task install` copies
# from — no network, no clone needed there.
#
# Updating = re-running install.sh (a fresh install naturally replaces the old
# global command). There is no `update` subcommand and no --platform here —
# binding the skill into an agent is `schedule-task install`, a separate step.
#
# Usage: ./install.sh [--dry-run]
set -uo pipefail

REPO_URL="${SCHEDULE_TASK_REPO_URL:-https://github.com/smart-kind/schedule-task-skill.git}"
DRY_RUN=0
TEMP_DIR=""
PACK_DIR=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "install.sh: unknown option '$arg' (the only option is --dry-run)" >&2; exit 2 ;;
  esac
done

cleanup() { # the temp clone + tarball dir are build inputs only; drop them
  [ -n "$TEMP_DIR" ] && rm -rf "$TEMP_DIR"
  [ -n "$PACK_DIR" ] && rm -rf "$PACK_DIR"
}
trap cleanup EXIT

run() { # print to stderr (stdout may be a pipe), then execute unless dry-run
  echo "+ $*" >&2
  [ "$DRY_RUN" -eq 0 ] && "$@"
  return 0
}

# --- Source: are we inside the repo, or fetched from a URL? ---
if [ -f package.json ] && [ -d bin ] && [ -d src ]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "source: running inside the repo ($REPO_ROOT)"
else
  echo "source: not inside the repo — cloning into a temp dir"
  TEMP_DIR="$(mktemp -d)"
  run git clone --depth 1 "$REPO_URL" "$TEMP_DIR/schedule-task"
  REPO_ROOT="$TEMP_DIR/schedule-task"
fi

echo "----"
# Tool layer: the global CLI, one self-contained copy per machine. `npm pack`
# builds a tarball from the source, then `npm install -g <tarball>` unpacks a
# real copy into the npm prefix. The tarball also carries
# SKILL.md/references/templates, so `schedule-task install` can bind the
# knowledge layer straight from the global package.
if command -v npm >/dev/null 2>&1; then
  echo "CLI: npm pack \"$REPO_ROOT\" + npm install -g <tarball> (global command: schedule-task)"
  if [ "$DRY_RUN" -eq 0 ]; then
    PACK_DIR="$(mktemp -d)"
    TGZ="$(cd "$PACK_DIR" && npm pack "$REPO_ROOT" --silent 2>/dev/null | tail -n 1)"
    run npm install -g "$PACK_DIR/$TGZ"
  fi
else
  echo "WARN npm not found — the global \`schedule-task\` CLI was NOT installed."
  echo "     install node/npm first, then re-run install.sh."
fi

echo "----"
echo "install.sh done ($([ "$DRY_RUN" -eq 1 ] && echo 'dry-run — nothing changed' || echo 'the global \`schedule-task\` CLI is now on PATH'))."
echo "Next — bind the knowledge layer into each agent (SKILL.md/references/templates, zero code):"
echo "  schedule-task install --target all"
echo "Idempotent: re-running install.sh replaces the global CLI; re-running install re-copies the skill."
