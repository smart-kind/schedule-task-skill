'use strict';
// init.js — install the runtime into the current repo AND declare this machine's
// role. Creates the per-project private data directory (.schedule-tasks-data/),
// writes the gitignored machine identity, merges the gitignore snippet, checks
// dependencies, prints the worker's cron line, and — when the repo still carries
// the old bash-era `automation/` data dir — offers to migrate it.
//
// Everything the runtime needs lives in these two places:
//   <repo>/.schedule-tasks-data/        committed + gitignored parts (per project)
//   ~/.local/state/schedule-task/<repo> worker-local run state (per machine)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const core = require('./core.js');
const { git } = require('./git.js');

const DATA_DIRS = ['tasks', 'prompts', 'reports', 'batches', 'state', 'hooks'];
const COMMITTED_DIRS = ['tasks', 'prompts', 'reports', 'batches'];
const GITIGNORE_LINE = '.schedule-tasks-data/state/';
const OLD_RUNTIME_SCRIPTS = [
  'dispatch.sh', 'run-task.sh', 'coding-agent.sh', 'status.sh',
  'cancel-task.sh', 'archive-task.sh', 'merge-batch.sh', 'gitignore.snippet',
];

function findInPath(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function ask(question, def) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question}${def !== undefined ? ` [${def}]` : ''} `, (ans) => {
      rl.close();
      const v = (ans || '').trim();
      resolve(v === '' && def !== undefined ? String(def) : v);
    });
  });
}

function gitignoreHas(repo, line) {
  const f = path.join(repo, '.gitignore');
  try {
    return fs.readFileSync(f, 'utf8').split('\n').includes(line);
  } catch {
    return false;
  }
}

function mergeGitignore(repo) {
  const f = path.join(repo, '.gitignore');
  const existing = (() => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  })();
  if (!existing.split('\n').includes(GITIGNORE_LINE)) {
    const add = existing.length && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(f, `${add}${GITIGNORE_LINE}\n`, 'utf8');
    console.log(`gitignore: appended ${GITIGNORE_LINE}`);
  } else {
    console.log(`gitignore: already contains ${GITIGNORE_LINE}`);
  }
}

function depCheck() {
  const results = [];
  results.push(['node', process.version, 'ok']);
  const git = findInPath('git');
  results.push(['git', git ? 'found' : 'MISSING', git ? 'ok' : 'warn']);
  const claude = findInPath('claude');
  results.push(['claude', claude ? 'found' : 'not on PATH', claude ? 'ok' : 'warn']);
  const kimi = findInPath('kimi');
  results.push(['kimi', kimi ? 'found' : 'not on PATH', kimi ? 'ok' : 'warn']);
  console.log('dependencies:');
  for (const [name, found, status] of results) {
    console.log(`  ${name.padEnd(8)} ${found}  ${status}`);
  }
  const missing = results.filter((r) => r[2] !== 'ok');
  if (missing.length) {
    console.log('note: not all deps are present — they matter on the worker, not necessarily on the author machine.');
  }
  return missing.length === 0;
}

// Move one file/dir with `git mv` when tracked, plain rename otherwise.
function mvOne(repo, from, to) {
  if (!git(repo, ['mv', from, to]).ok) fs.renameSync(from, to);
}

async function migrateAutomation({ repo, yes }) {
  const oldRoot = path.join(repo, 'automation');
  const newRoot = core.dataDir(repo);
  if (!fs.existsSync(oldRoot)) return;
  if (!yes) {
    const ans = await ask('Found the old automation/ data dir. Migrate it to .schedule-tasks-data/ ?', 'y');
    if (ans !== 'y' && ans !== 'yes') {
      console.log('migration skipped');
      return;
    }
  }
  // Merge each old subdir's contents into the freshly created data dir. Skip the
  // template stubs (.gitkeep), a stale lock, and an old .machine — the .machine
  // written by THIS init run is the current truth. A customized old notify.sh
  // overwrites the fresh template (POSIX rename overwrites).
  const skip = new Set(['.gitkeep', '.dispatch.lock', '.machine']);
  for (const sub of DATA_DIRS) {
    const from = path.join(oldRoot, sub);
    if (!fs.existsSync(from)) continue;
    core.ensureDir(path.join(newRoot, sub));
    for (const f of fs.readdirSync(from)) {
      if (skip.has(f)) continue;
      const src = path.join(from, f);
      const dst = path.join(newRoot, sub, f);
      if (f === 'notify.sh' && sub === 'hooks') {
        fs.renameSync(src, dst); // customization point: old version wins
        continue;
      }
      if (fs.existsSync(dst)) continue; // dupe — the fresh copy stands
      mvOne(repo, src, dst);
    }
    // What's left in the old subdir is disposable (stubs / stale lock / dupe).
    git(repo, ['rm', '-r', '-f', '--ignore-unmatch', from]);
    fs.rmSync(from, { recursive: true, force: true });
  }
  // Rewrite every envelope's prompt_file from automation/... to .schedule-tasks-data/...
  const tasksDir = path.join(newRoot, 'tasks');
  let rewrote = 0;
  try {
    for (const f of fs.readdirSync(tasksDir)) {
      if (!f.endsWith('.json')) continue;
      const tf = path.join(tasksDir, f);
      let env;
      try {
        env = JSON.parse(fs.readFileSync(tf, 'utf8'));
      } catch {
        continue;
      }
      if (env.prompt_file && env.prompt_file.startsWith('automation/')) {
        env.prompt_file = env.prompt_file.replace(/^automation\//, '.schedule-tasks-data/');
        fs.writeFileSync(tf, `${JSON.stringify(env, null, 2)}\n`, 'utf8');
        rewrote += 1;
      }
    }
  } catch {
    /* no tasks yet */
  }
  if (rewrote) console.log(`migration: rewrote prompt_file in ${rewrote} envelope(s)`);
  // Old runtime scripts copied into the repo are now dead weight — ask before removing.
  const stray = OLD_RUNTIME_SCRIPTS.filter((s) => fs.existsSync(path.join(oldRoot, s)));
  if (stray.length) {
    const remove = yes || ['y', 'yes'].includes(await ask(`Remove ${stray.length} old runtime script(s) from automation/ ?`, 'y'));
    if (remove) {
      for (const s of stray) {
        const p = path.join(oldRoot, s);
        if (!git(repo, ['rm', '-f', p]).ok) fs.rmSync(p, { force: true });
      }
    }
  }
  const left = (() => {
    try {
      return fs.readdirSync(oldRoot);
    } catch {
      return [];
    }
  })();
  if (left.length === 0) {
    git(repo, ['rm', '-r', '-f', '--ignore-unmatch', oldRoot]);
    fs.rmSync(oldRoot, { recursive: true, force: true });
  } else {
    console.log(`migration: automation/ still contains: ${left.join(', ')} — remove by hand if unwanted`);
  }
  console.log('migration done');
}

async function init({ repo, roleArg, idArg, yes }) {
  const dataRoot = core.dataDir(repo);
  const stateDir = core.stateDir(repo);

  if (!fs.existsSync(path.join(repo, '.git'))) {
    console.log('warning: this does not look like a git repository — the runtime needs git.');
  }

  // 1. Machine identity.
  let role = roleArg;
  if (!role) {
    role = await ask('What is this machine? (author | worker)', 'author');
  }
  if (role !== 'author' && role !== 'worker') {
    console.error(`init: role must be author or worker (got '${role}')`);
    return { exit: 2 };
  }
  const defaultId = os.hostname() || 'unknown';
  let id = idArg;
  if (!id) {
    const ans = await ask('Machine id (matched against envelope .worker; pick something stable like vps-01)', defaultId);
    id = ans || defaultId;
  }
  core.writeMachine(stateDir, role, id);
  console.log(`machine: role=${role} id=${id} -> .schedule-tasks-data/state/.machine (gitignored)`);

  // 2. Data directories + the notify hook customization point.
  for (const sub of DATA_DIRS) core.ensureDir(path.join(dataRoot, sub));
  for (const sub of COMMITTED_DIRS) {
    const gk = path.join(dataRoot, sub, '.gitkeep');
    if (!fs.existsSync(gk)) fs.writeFileSync(gk, '', 'utf8');
  }
  const hookTpl = path.join(core.skillRoot(), 'templates', 'hooks', 'notify.sh');
  const hook = path.join(dataRoot, 'hooks', 'notify.sh');
  if (!fs.existsSync(hook)) {
    if (fs.existsSync(hookTpl)) {
      fs.copyFileSync(hookTpl, hook);
      fs.chmodSync(hook, 0o755);
    } else {
      fs.writeFileSync(hook, '#!/usr/bin/env sh\nexit 0\n', 'utf8');
      fs.chmodSync(hook, 0o755);
    }
    console.log(`created ${hook} — edit it for push notifications`);
  }

  // 3. Gitignore.
  mergeGitignore(repo);

  // 4. Dependencies (non-fatal).
  depCheck();

  // 5. Migration from the old data dir.
  await migrateAutomation({ repo, yes });

  // 6. Worker cron line.
  if (role === 'worker') {
    console.log('');
    console.log('Add this line to your crontab (every 5 minutes):');
    console.log('');
    console.log(`*/5 * * * * schedule-task dispatch --repo ${repo}  # >> ~/.local/state/schedule-task/${path.basename(repo)}/dispatch.log`);
    console.log('');
    console.log('Note: .schedule-tasks-data/state/ stays local to this worker (gitignored);');
    console.log('it is the worker-local truth and never crosses git. A per-repo lock file');
    console.log('inside state/ prevents overlapping ticks — no flock needed.');
  }
  console.log('');
  console.log(`init: done — runtime data lives in ${dataRoot}`);
  return { exit: 0 };
}

module.exports = { init, findInPath, gitignoreHas };
