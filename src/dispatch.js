'use strict';
// dispatch.js — the trigger-layer tick (the watchdog loop calls this every few
// minutes). Deterministic and cheap: pull the inbox, launch due + eligible tasks
// as detached runner processes — bounded by FL_MAX_CONCURRENCY instead of v1's
// global "any task running → idle" serialization (cap=1 reproduces v1 exactly).
// Only tasks whose envelope `.worker` equals this machine's id are launched
// (absent `.worker` = any worker may take it). Workers NEVER merge — batch
// finalization is the author's job. The multi-hour resilient part is owned by
// runner.js, not by this tick.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const core = require('./core.js');
const { git, treeClean } = require('./git.js');

const LOCK = '.dispatch.lock';

function dispatch({ repo, config, launch }) {
  const stateDir = core.stateDir(repo);
  const logRoot = core.logRoot(repo, config);
  core.ensureDir(stateDir);
  core.ensureDir(logRoot);
  const dispatchLog = path.join(logRoot, 'watchdog.log');
  const dlog = (msg) => core.logLine(dispatchLog, `dispatch: ${msg}`);
  // launch is injectable for tests; the default spawns the detached runner.
  const spawnRunner = launch || ((id) => {
    const cliPath = path.join(__dirname, '..', 'bin', 'schedule-task.js');
    let child;
    try {
      child = spawn(process.execPath, [cliPath, 'run', id, '--repo', repo], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, HOME: process.env.HOME },
      });
    } catch (err) {
      throw new Error(`spawn failed for ${id}: ${err.message}`);
    }
    child.on('error', (err) => dlog(`runner error for ${id}: ${err.message}`));
    child.unref();
    return { pid: child.pid };
  });

  // --- machine identity: only a machine declared role=worker dispatches ---
  const machine = core.readMachine(stateDir);
  if (machine.role !== 'worker') {
    dlog(`role=${machine.role} — not a worker (.schedule-tasks-data/state/.machine); idle`);
    return { launched: 0 };
  }

  // --- dispatch lock: pid file with stale detection (replaces flock) ---
  // `wx` makes acquisition atomic; a concurrent tick that sees a live pid backs
  // off, a dead pid is stale and replaced.
  const lockFile = path.join(stateDir, LOCK);
  let owned = false;
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    owned = true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      let holder = 0;
      try {
        holder = Number(fs.readFileSync(lockFile, 'utf8').trim() || 0);
      } catch {
        /* lock vanished mid-read — retry below */
      }
      if (core.isAlive(holder)) {
        dlog('another dispatch tick is running; idle');
        return { launched: 0 };
      }
      try {
        fs.unlinkSync(lockFile); // stale lock
      } catch {
        /* racing unlink — next tick wins */
      }
      try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        owned = true;
      } catch {
        dlog('could not acquire dispatch lock; idle');
        return { launched: 0 };
      }
    } else {
      dlog(`lock error: ${err.code}; idle`);
      return { launched: 0 };
    }
  }
  let launchedCount = 0;
  try {
    launchedCount = tick({ repo, config, stateDir, machine, dlog, spawnRunner });
  } finally {
    if (owned) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* already gone */
      }
    }
  }
  return { launched: launchedCount };
}

function tick({ repo, config, stateDir, machine, dlog, spawnRunner }) {
  const maxConcurrency = config.maxConcurrency;
  const inbox = config.inbox;

  // Count runners by state file (first line = state word; <id>.notes and other
  // stray files never read exactly "running", so exact matching keeps it clean).
  let running = 0;
  for (const f of fs.readdirSync(stateDir)) {
    if (f === LOCK || f === '.machine' || f.endsWith('.notes') || f.endsWith('.pid')) continue;
    if (core.readState(stateDir, f) === 'running') running += 1;
  }
  if (running >= maxConcurrency) {
    dlog(`at capacity (${running}/${maxConcurrency} running); idle`);
    return 0;
  }

  // Only touch git when tracked files are clean (untracked stray files are benign
  // and ignored; this guard avoids fighting an in-flight edit / interactive session).
  if (!treeClean(repo)) {
    dlog('main tree has tracked changes; skipping tick');
    return 0;
  }

  if (!git(repo, ['fetch', 'origin', inbox]).ok) {
    dlog('cannot fetch origin/' + inbox);
    return 0;
  }
  if (!git(repo, ['checkout', inbox]).ok && !git(repo, ['checkout', '-b', inbox, `origin/${inbox}`]).ok) {
    dlog('cannot checkout ' + inbox);
    return 0;
  }
  if (!git(repo, ['pull', '--rebase', 'origin', inbox]).ok) {
    dlog('pull failed (offline?)');
  }

  // Launch due + eligible tasks until the free slots are filled.
  const now = Math.floor(Date.now() / 1000);
  let free = maxConcurrency - running;
  let launched = 0;
  const tasksDir = path.join(core.dataDir(repo), 'tasks');
  let taskFiles = [];
  try {
    taskFiles = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    taskFiles = [];
  }

  const cliPath = path.join(__dirname, '..', 'bin', 'schedule-task.js');

  for (const f of taskFiles) {
    if (free <= 0) break;
    const tf = path.join(tasksDir, f);
    let env;
    try {
      env = JSON.parse(fs.readFileSync(tf, 'utf8'));
    } catch {
      continue; // malformed envelope — never a launch decision
    }
    const id = env.id;
    if (!id) continue;
    const st = core.normalizeState(core.readState(stateDir, id));
    if (st === 'running' || st === 'done'
        || st === 'merge-failed' || st === 'failed' || st === 'cancelled') continue;

    // Machine assignment: a task naming a worker is only launched there.
    const wkr = env.worker || '';
    if (wkr && wkr !== machine.id) {
      dlog(`${id} assigned to worker '${wkr}' (this box: ${machine.id}); skipping`);
      continue;
    }

    const runat = env.schedule && env.schedule.run_at;
    if (runat) {
      const due = Date.parse(runat) / 1000;
      if (!Number.isFinite(due) || now < due) {
        dlog(`${id} not due yet (${runat})`);
        continue;
      }
    }

    // depends_on: every listed task id must be done.
    let blocked = '';
    for (const dep of env.depends_on || []) {
      if (core.normalizeState(core.readState(stateDir, dep)) !== 'done') {
        blocked = dep;
        break;
      }
    }
    if (blocked) {
      dlog(`${id} blocked by ${blocked} (not done)`);
      continue;
    }

    dlog(`launching ${id}`);
    // Detached runner: new session/process group (its pid == pgid), stdio to
    // files is the runner's own job; we mark state BEFORE handing over control
    // so a concurrent tick (lock held here) can never double-launch.
    let pid;
    try {
      ({ pid } = spawnRunner(id));
    } catch (err) {
      dlog(`spawn failed for ${id}: ${err.message}`);
      continue;
    }
    core.writeState(stateDir, id, 'running');
    core.writePid(stateDir, id, pid);
    free -= 1;
    launched += 1;
  }
  if (launched === 0) dlog('nothing due');
  // Workers never merge anyone else's work; each executor merges its own branch
  // to dev (runner fast-forwards) — author-side batch finalization is gone.
  return launched;
}

module.exports = { dispatch };
