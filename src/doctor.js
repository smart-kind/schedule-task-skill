'use strict';
// doctor.js — `schedule-task doctor`: environment health check.
// The runtime's only hard dependencies are node + git; the executor CLIs
// (claude/kimi) are needed on workers. Reports without failing hard.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('./core.js');
const { findInPath } = require('./init.js');

function doctor({ repo }) {
  let bad = 0;
  const row = (name, found, ok) => {
    console.log(`  ${name.padEnd(10)} ${String(found).padEnd(38)} ${ok ? 'ok' : 'PROBLEM'}`);
    if (!ok) bad += 1;
  };

  console.log('schedule-task doctor');
  console.log(`node        ${process.version}`);
  row('node', process.version, true);
  row('git', findInPath('git') || 'not on PATH', Boolean(findInPath('git')));
  row('claude', findInPath('claude') || 'not on PATH', Boolean(findInPath('claude')));
  row('kimi', findInPath('kimi') || 'not on PATH', Boolean(findInPath('kimi')));
  const graphify = findInPath('graphify');
  row('graphify', graphify || 'not on PATH (optional)', true);
  if (!graphify) console.log('  hint: graphify — knowledge-graph queries for executors (saves tokens); install: uv tool install graphifyy');

  // The skill copy the CLI ships from must be complete (bin + src). There is no
  // global install anymore — the copy itself is the whole runtime.
  const skillRoot = core.skillRoot();
  console.log(`skill-root  ${skillRoot}`);
  const hasBin = fs.existsSync(path.join(skillRoot, 'bin', 'schedule-task.js'));
  const hasSrc = fs.existsSync(path.join(skillRoot, 'src'));
  row('skill bin/', hasBin ? 'present' : 'MISSING', hasBin);
  row('skill src/', hasSrc ? 'present' : 'MISSING', hasSrc);
  if (!hasBin || !hasSrc) console.log('  hint: this skill copy is incomplete — re-run ./install.sh (or ./install.sh --update) to restore it');

  // Old-scheme leftovers: a `schedule-task` on PATH that is not this skill's own
  // copy (npm global binary / ~/.local/bin symlink). The skill is now fully
  // self-contained, so these are unused. Detect + advise — never remove anything.
  const leftover = findInPath('schedule-task');
  if (leftover) {
    let real = leftover;
    try { real = fs.realpathSync(leftover); } catch { /* broken symlink */ }
    const mine = fs.realpathSync(path.join(skillRoot, 'bin', 'schedule-task.js'));
    if (real !== mine) {
      const homeBin = path.join(os.homedir(), '.local', 'bin', 'schedule-task');
      console.log(`leftover  schedule-task on PATH at ${leftover} (old-scheme install)`);
      if (path.resolve(leftover) === path.resolve(homeBin)) {
        console.log(`  hint: old-scheme CLI symlink (~/.local/bin) — unused now; remove it by hand: rm "${leftover}"`);
      } else if (/[\\/]node_modules[\\/]schedule-task/.test(real) || underNpmGlobalBin(leftover)) {
        console.log('  hint: npm-global install — unused now; remove it by hand: npm uninstall -g schedule-task');
      } else {
        console.log("  hint: not this skill's copy — if it is an old install, remove it by hand");
      }
    }
  }

  const dataRoot = core.dataDir(repo);
  const stateDir = core.stateDir(repo);
  if (fs.existsSync(dataRoot)) {
    const machine = core.readMachine(stateDir);
    row('.machine', `role=${machine.role} id=${machine.id}`, machine.role === 'author' || machine.role === 'worker');
    const subs = ['tasks', 'prompts', 'reports', 'batches', 'state', 'hooks'];
    for (const s of subs) row(`data/${s}/`, fs.existsSync(path.join(dataRoot, s)) ? 'present' : 'MISSING', fs.existsSync(path.join(dataRoot, s)));
    row('gitignore', fs.existsSync(path.join(repo, '.gitignore')) ? 'present' : 'missing (init will add)', true);
  } else {
    row('.schedule-tasks-data', 'not initialized — run `schedule-task init`', false);
  }

  const logRoot = core.logRoot(repo);
  row('run-state', logRoot, fs.existsSync(logRoot) || true); // created lazily — informational
  console.log(bad === 0 ? 'all checks passed' : `${bad} problem(s) found`);
  return bad === 0 ? 0 : 1;
}

// Is p the npm global bin shim (`npm prefix -g`/bin/<name>)? npm writes either a
// symlink into node_modules (covered above) or a wrapper script here; this
// catches the wrapper form (e.g. nvm-installed node). npm is optional — when
// absent we just fall through to the generic hint.
function underNpmGlobalBin(p) {
  if (!findInPath('npm')) return false;
  const r = require('node:child_process').spawnSync('npm', ['prefix', '-g'], {
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0 || !r.stdout) return false;
  const prefix = r.stdout.trim();
  return prefix !== '' && p.startsWith(path.join(prefix, 'bin', '') + path.sep);
}

module.exports = { doctor };