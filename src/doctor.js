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

  // The global CLI package must be complete: bin + src (the runtime) AND the
  // knowledge three (SKILL.md/references/templates — what `schedule-task
  // install` copies from). install.sh ships all of them in the global package.
  const skillRoot = core.skillRoot();
  console.log(`skill-root  ${skillRoot}`);
  const hasBin = fs.existsSync(path.join(skillRoot, 'bin', 'schedule-task.js'));
  const hasSrc = fs.existsSync(path.join(skillRoot, 'src'));
  const hasSkill = fs.existsSync(path.join(skillRoot, 'SKILL.md'));
  const hasRefs = fs.existsSync(path.join(skillRoot, 'references'));
  const hasTpl = fs.existsSync(path.join(skillRoot, 'templates'));
  row('cli-pkg bin/', hasBin ? 'present' : 'MISSING', hasBin);
  row('cli-pkg src/', hasSrc ? 'present' : 'MISSING', hasSrc);
  row('cli-pkg SKILL.md', hasSkill ? 'present' : 'MISSING', hasSkill);
  row('cli-pkg references/', hasRefs ? 'present' : 'MISSING', hasRefs);
  row('cli-pkg templates/', hasTpl ? 'present' : 'MISSING', hasTpl);
  if (!hasBin || !hasSrc || !hasSkill || !hasRefs || !hasTpl) {
    console.log('  hint: the global CLI package is incomplete — re-run install.sh to restore it');
  }

  // Bound skill dirs (knowledge layer): each installed platform's
  // skills/schedule-task must hold the knowledge three and NOTHING else.
  // bin/src/tests/package.json/install.sh there are residue from old-form
  // install schemes — re-running `schedule-task install` (whole-dir overwrite)
  // cleans them automatically.
  const { PLATFORM_HOMES } = require('./install.js');
  for (const id of Object.keys(PLATFORM_HOMES)) {
    const home = PLATFORM_HOMES[id]();
    if (!fs.existsSync(home)) continue; // platform not installed on this machine
    const dest = path.join(home, 'skills', 'schedule-task');
    if (!fs.existsSync(dest)) {
      row(`skill ${id}/`, 'not bound — run `schedule-task install`', true);
      continue;
    }
    const missing = ['SKILL.md', 'references', 'templates'].filter((it) => !fs.existsSync(path.join(dest, it)));
    const residue = ['bin', 'src', 'tests', 'package.json', 'install.sh'].filter((it) => fs.existsSync(path.join(dest, it)));
    const ok = missing.length === 0 && residue.length === 0;
    const desc = ok ? 'knowledge three, no code' : (missing.length ? `MISSING: ${missing.join(', ')}` : `code residue: ${residue.join(', ')}`);
    row(`skill ${id}/`, desc, ok);
    if (residue.length > 0) console.log('  hint: old-form code residue — re-run `schedule-task install` (whole-dir overwrite cleans it)');
    if (missing.length > 0) console.log('  hint: incomplete skill copy — re-run `schedule-task install` to restore it');
  }

  // Runtime CLI. Under three-layer separation the running CLI is the npm global
  // install (`npm install -g` by install.sh); a bound skill dir has no bin/ at
  // all. Old-scheme leftovers — a ~/.local/bin schedule-task symlink — are
  // still flagged. Detect + advise, never remove anything.
  const homeBin = path.join(os.homedir(), '.local', 'bin', 'schedule-task');
  const cliPath = findInPath('schedule-task');
  let cliDesc = 'not on PATH';
  let cliOk = false;
  if (cliPath) {
    let real = cliPath;
    try { real = fs.realpathSync(cliPath); } catch { /* broken symlink */ }
    let mine = '';
    try { mine = fs.realpathSync(path.join(skillRoot, 'bin', 'schedule-task.js')); } catch { /* broken cli-pkg */ }
    if (path.resolve(cliPath) === path.resolve(homeBin)) {
      cliDesc = `${cliPath} (old-scheme ~/.local/bin symlink)`;
      console.log(`leftover  schedule-task on PATH at ${cliPath} (old-scheme install)`);
      console.log(`  hint: unused under three-layer separation — remove it: rm "${cliPath}"`);
    } else if (/[\\/]lib[\\/]node_modules[\\/]schedule-task[\\/]/.test(real) || underNpmGlobalBin(cliPath)) {
      // npm global install — the expected runtime under three-layer separation.
      // On a dev machine the global install symlinks to the source tree, so
      // `real` may equal the dev checkout's bin — npm-prefix detection wins.
      cliDesc = `${cliPath} (npm global)`;
      let ver = '';
      try {
        ver = JSON.parse(fs.readFileSync(path.join(real, '..', '..', 'package.json'), 'utf8')).version;
      } catch { /* no readable package.json next to the global bin */ }
      if (ver && ver !== CLI_VERSION) {
        cliDesc += ` v${ver} — mismatch with cli-pkg v${CLI_VERSION}`;
        console.log(`  hint: global CLI v${ver} does not match the cli-pkg v${CLI_VERSION} — re-run install.sh`);
      } else {
        cliDesc += ver ? ` v${ver}` : '';
        cliOk = true;
      }
    } else if (mine && real === mine) {
      cliDesc = `${cliPath} (this dev checkout's bin — reference only; the npm-global CLI is the runtime)`;
      cliOk = true;
    } else {
      cliDesc = `${cliPath} (not this package's copy — check what it is)`;
    }
  }
  row('cli', cliDesc, cliOk);
  if (!cliOk && !cliPath) console.log('  hint: no global schedule-task CLI on PATH — re-run install.sh, then bind the skill with `schedule-task install --target all`');

  const dataRoot = core.dataDir(repo);
  const stateDir = core.stateDir(repo);
  if (fs.existsSync(dataRoot)) {
    const machine = core.readMachine(stateDir);
    row('.machine', `role=${machine.role} id=${machine.id}`, machine.role === 'author' || machine.role === 'worker');
    const subs = ['tasks', 'prompts', 'reports', 'batches', 'state', 'hooks'];
    for (const s of subs) row(`data/${s}/`, fs.existsSync(path.join(dataRoot, s)) ? 'present' : 'MISSING', fs.existsSync(path.join(dataRoot, s)));
    // Workers profile (optional but recommended).
    const workers = core.readWorkers(repo);
    const wFile = path.join(dataRoot, 'workers.json');
    if (fs.existsSync(wFile)) {
      row('workers.json', `${workers.length} worker(s) configured`, workers.length > 0);
      if (workers.length === 0) console.log('  hint: workers.json exists but is empty — add workers with `schedule-task profile add`');
    } else {
      row('workers.json', 'not configured — run `schedule-task profile add`', true);
    }
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