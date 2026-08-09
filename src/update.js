'use strict';
// update.js — `schedule-task update`: actually refresh the skill installation.
// Installed copies are self-contained (no .git, no global install), so this
// pulls the source recorded in `.installed-from` (or clones the repo when there
// is no recorded source), then re-runs that source's install.sh --update to
// re-copy every platform's skill dir on this machine. Old-scheme leftovers
// (npm global binary, ~/.local/bin symlink) are NOT touched — removing them is
// a manual step.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('./core.js');

const DEFAULT_REPO_URL = process.env.SCHEDULE_TASK_REPO_URL || 'https://github.com/smart-kind/schedule-task-skill.git';

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) console.error(`update: ${cmd} failed: ${r.error.message}`);
  return r.error ? false : r.status === 0;
}

// Does the source have an `origin` remote? Only pull real remotes — a local
// source without one is authoritative as-is.
function hasOrigin(source) {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: source, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  return r.status === 0;
}

function update() {
  // 1. Find the source this copy was installed from (the .installed-from marker),
  //    or fall back to cloning the repo — mirroring install.sh's URL path.
  const marker = path.join(core.skillRoot(), '.installed-from');
  let source = '';
  try {
    source = fs.readFileSync(marker, 'utf8').trim();
  } catch {
    source = '';
  }
  if (source && !fs.existsSync(path.join(source, 'package.json'))) source = ''; // stale marker

  if (source) {
    console.log(`update: source ${source} (from .installed-from)`);
    if (fs.existsSync(path.join(source, '.git')) && hasOrigin(source)) {
      console.log('update: pulling latest skill source...');
      if (!run('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: source })) return 1;
    }
  } else {
    const stateDir = path.join(os.homedir(), '.local', 'share', 'schedule-task');
    source = path.join(stateDir, 'src');
    console.log(`update: no recorded source — cloning the repo into ${source}`);
    fs.rmSync(source, { recursive: true, force: true });
    fs.mkdirSync(stateDir, { recursive: true });
    if (!run('git', ['clone', '--depth', '1', DEFAULT_REPO_URL, source])) return 1;
  }

  // 2. Re-copy every platform from the (refreshed) source.
  const inst = path.join(source, 'install.sh');
  if (!fs.existsSync(inst)) {
    console.error(`update: ${inst} not found — cannot re-copy the skill`);
    return 1;
  }
  console.log('update: re-copying skill copies (install.sh --update --yes)');
  if (!run('bash', [inst, '--update', '--yes'], { cwd: source })) return 1;
  console.log('update: done — every platform copy now matches the latest source.');
  console.log('  Old-scheme leftovers (npm global `schedule-task`, ~/.local/bin/schedule-task symlink)');
  console.log('  are not touched; remove them by hand if present.');
  return 0;
}

module.exports = { update };
