'use strict';
// doctor.js — `schedule-task doctor`: environment health check.
// The runtime's only hard dependencies are node + git; the executor CLIs
// (claude/kimi) are needed on workers. Reports without failing hard.

const fs = require('node:fs');
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

module.exports = { doctor };
