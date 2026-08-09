'use strict';
// doctor.js — `schedule-task doctor`: environment health check.
// The runtime's only hard dependencies are node + git; the executor CLIs
// (claude/kimi) are needed on workers. Reports without failing hard.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('./core.js');
const { findInPath } = require('./init.js');

// The CLI version this skill copy ships (package.json next to the source).
const CLI_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(core.skillRoot(), 'package.json'), 'utf8')).version;
  } catch {
    return '?';
  }
})();

function doctor({ repo }) {
  let bad = 0;
  const row = (name, found, ok) => {
    console.log(`  ${name.padEnd(10)} ${String(found).padEnd(38)} ${ok ? 'ok' : 'PROBLEM'}`);
    if (!ok) bad += 1;
  };

  const schema = core.readSchemaVersion(core.dataDir(repo));
  console.log(`schedule-task doctor  ·  CLI v${CLI_VERSION} · data schema v${schema === null ? '—' : schema}`);
  console.log(`node        ${process.version}`);
  row('node', process.version, true);
  row('git', findInPath('git') || 'not on PATH', Boolean(findInPath('git')));
  row('claude', findInPath('claude') || 'not on PATH', Boolean(findInPath('claude')));
  row('kimi', findInPath('kimi') || 'not on PATH', Boolean(findInPath('kimi')));
  const graphify = findInPath('graphify');
  row('graphify', graphify || 'not on PATH (optional)', true);
  if (!graphify) console.log('  hint: graphify — knowledge-graph queries for executors (saves tokens); install: uv tool install graphifyy');

  // The skill copy the CLI ships from must be complete (bin + src). Under
  // three-layer separation the copy is knowledge (the runtime is the npm global
  // CLI installed by install.sh), but a broken copy still deserves a flag.
  const skillRoot = core.skillRoot();
  console.log(`skill-root  ${skillRoot}`);
  const hasBin = fs.existsSync(path.join(skillRoot, 'bin', 'schedule-task.js'));
  const hasSrc = fs.existsSync(path.join(skillRoot, 'src'));
  row('skill bin/', hasBin ? 'present' : 'MISSING', hasBin);
  row('skill src/', hasSrc ? 'present' : 'MISSING', hasSrc);
  if (!hasBin || !hasSrc) console.log('  hint: this skill copy is incomplete — re-run ./install.sh (or ./install.sh --update) to restore it');

  // Runtime CLI. Under three-layer separation the running CLI is the npm global
  // install (`npm install -g` by install.sh); the copy's bin/ is reference
  // only. Old-scheme leftovers — a ~/.local/bin schedule-task symlink — are
  // still flagged. Detect + advise, never remove anything.
  const homeBin = path.join(os.homedir(), '.local', 'bin', 'schedule-task');
  const cliPath = findInPath('schedule-task');
  let cliDesc = 'not on PATH';
  let cliOk = false;
  if (cliPath) {
    let real = cliPath;
    try { real = fs.realpathSync(cliPath); } catch { /* broken symlink */ }
    const mine = fs.realpathSync(path.join(skillRoot, 'bin', 'schedule-task.js'));
    if (path.resolve(cliPath) === path.resolve(homeBin)) {
      cliDesc = `${cliPath} (old-scheme ~/.local/bin symlink)`;
      console.log(`leftover  schedule-task on PATH at ${cliPath} (old-scheme install)`);
      console.log(`  hint: unused under three-layer separation — remove it: rm "${cliPath}"`);
    } else if (/[\\/]lib[\\/]node_modules[\\/]schedule-task[\\/]/.test(real) || underNpmGlobalBin(cliPath)) {
      // npm global install — the expected runtime under three-layer separation.
      // On a dev machine the global install symlinks to the source tree, so
      // `real` may equal this copy's bin — npm-prefix detection still wins.
      cliDesc = `${cliPath} (npm global)`;
      let ver = '';
      try {
        ver = JSON.parse(fs.readFileSync(path.join(real, '..', '..', 'package.json'), 'utf8')).version;
      } catch { /* no readable package.json next to the global bin */ }
      if (ver && ver !== CLI_VERSION) {
        cliDesc += ` v${ver} — mismatch with skill copy v${CLI_VERSION}`;
        console.log(`  hint: global CLI v${ver} does not match the skill copy v${CLI_VERSION} — re-run ./install.sh --update`);
      } else {
        cliDesc += ver ? ` v${ver}` : '';
        cliOk = true;
      }
    } else if (real === mine) {
      cliDesc = `${cliPath} (this skill copy's bin — reference only; the global CLI is the runtime)`;
      cliOk = true;
    } else {
      cliDesc = `${cliPath} (not this skill's copy — check what it is)`;
    }
  }
  row('cli', cliDesc, cliOk);
  if (!cliOk && !cliPath) console.log('  hint: no global schedule-task CLI on PATH — re-run ./install.sh (installs the skill copies + `npm install -g`)');

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