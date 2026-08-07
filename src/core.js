'use strict';
// core.js — shared plumbing for the schedule-task CLI.
// Repo/data/state path resolution, machine identity (.machine), the state-file
// contract (first line = state word), milestone notes, the notify hook, and the
// FL_* / LIMIT_* / MAX_* environment seams. No AI in this loop — deterministic only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Environment pinning (cron runs with a sparse environment)
// ---------------------------------------------------------------------------

function pinEnv() {
  if (!process.env.PATH) {
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
  }
  if (!process.env.HOME) {
    try {
      process.env.HOME = os.homedir();
    } catch {
      process.env.HOME = '/root';
    }
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Resolve the repo the command operates on: -r/--repo flag, else cwd.
function resolveRepo(cliRepo, cwd) {
  const p = cliRepo || cwd || process.cwd();
  return path.resolve(p);
}

// The per-project private data directory (renamed from automation/).
function dataDir(repo) {
  return path.join(repo, '.schedule-tasks-data');
}

// Worker-local live state (gitignored).
function stateDir(repo) {
  return path.join(dataDir(repo), 'state');
}

// Worker-local run state root: ~/.local/state/schedule-task/<repo-basename>.
// Namespaced per repo so two projects' tasks never collide on run logs.
// FL_LOG_ROOT overrides it (used by --self-test and reusable on any box).
function logRoot(repo, config) {
  const cfg = config || readConfig();
  if (cfg.logRoot) return cfg.logRoot;
  const base = path.join(os.homedir(), '.local', 'state', 'schedule-task', path.basename(repo));
  return base;
}

// The directory the CLI itself ships from (skill repo root). Resolved through
// symlinks (install.sh links ~/.local/bin/schedule-task or the skill dirs).
function skillRoot() {
  return fs.realpathSync(path.join(__dirname, '..'));
}

// ---------------------------------------------------------------------------
// Environment configuration (all seams have bash-era names for continuity)
// ---------------------------------------------------------------------------

function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

function readConfig() {
  return {
    maxConcurrency: intEnv('FL_MAX_CONCURRENCY', 2),
    inbox: process.env.FL_INBOX || 'dev',
    mode: process.env.FL_MODE || '',          // status: force 'worker'|'author'
    autoRoot: process.env.FL_AUTO_ROOT || '', // status: the data dir override
    logRoot: process.env.FL_LOG_ROOT || '',   // worker state root override
    limitMargin: intEnv('LIMIT_MARGIN', 60),
    limitFallback: intEnv('LIMIT_FALLBACK', 1800),
    maxAmbiguous: intEnv('MAX_AMBIGUOUS', 12),
    ambiguousSleep: intEnv('AMBIGUOUS_SLEEP', 20),
    ambiguousFreshAt: intEnv('AMBIGUOUS_FRESH_AT', 6),
    maxAttempts: intEnv('MAX_ATTEMPTS', 60),
    claudeBin: process.env.CLAUDE_BIN || 'claude',
    kimiBin: process.env.KIMI_BIN || 'kimi',
  };
}

// ---------------------------------------------------------------------------
// Machine identity — .machine (gitignored, written by init)
// ---------------------------------------------------------------------------

function readMachine(stateDirPath) {
  const file = path.join(stateDirPath, '.machine');
  const out = { role: 'worker', id: (os.hostname() || 'unknown') };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^(\w+)=(.*)$/.exec(line.trim());
      if (m && m[1] === 'role') out.role = m[2];
      if (m && m[1] === 'id') out.id = m[2];
    }
  } catch {
    /* no .machine — defaults */
  }
  return out;
}

function writeMachine(stateDirPath, role, id) {
  fs.mkdirSync(stateDirPath, { recursive: true });
  fs.writeFileSync(path.join(stateDirPath, '.machine'), `role=${role}\nid=${id}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// State files — first line is the state word (load-bearing contract)
// ---------------------------------------------------------------------------

// Absent file = 'pending' (implicit).
function readState(stateDirPath, id) {
  try {
    const raw = fs.readFileSync(path.join(stateDirPath, id), 'utf8');
    const first = raw.split('\n', 1)[0].trim();
    return first || 'pending';
  } catch {
    return 'pending';
  }
}

function writeState(stateDirPath, id, word) {
  fs.mkdirSync(stateDirPath, { recursive: true });
  fs.writeFileSync(path.join(stateDirPath, id), `${word}\n`, 'utf8');
}

// Append-only milestone notes; never edited in place, never truncated by us.
function appendNotes(stateDirPath, id, line) {
  fs.mkdirSync(stateDirPath, { recursive: true });
  fs.appendFileSync(path.join(stateDirPath, `${id}.notes`), `${ts()} ${line}\n`, 'utf8');
}

// Runner pid — written by dispatch after spawn (and by the runner itself at start),
// read by cancel to kill the whole process group.
function writePid(stateDirPath, id, pid) {
  fs.mkdirSync(stateDirPath, { recursive: true });
  fs.writeFileSync(path.join(stateDirPath, `${id}.pid`), String(pid), 'utf8');
}

function readPid(stateDirPath, id) {
  try {
    const n = Number(fs.readFileSync(path.join(stateDirPath, `${id}.pid`), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Notify hook — dataDir/hooks/notify.sh <event> <id> <msg>, only when executable.
// Must never hang or fail the caller.
// ---------------------------------------------------------------------------

function notify(repo, event, id, msg) {
  const hook = path.join(dataDir(repo), 'hooks', 'notify.sh');
  let ok = false;
  try {
    fs.accessSync(hook, fs.constants.X_OK);
    ok = true;
  } catch {
    return; // absent or not executable — silent no-op
  }
  if (!ok) return;
  try {
    const child = spawn(hook, [event, id, msg], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref(); // never wait on the hook
  } catch {
    /* never let the hook poison the control flow */
  }
}

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

function ts() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// PID liveness via signal 0 (ESRCH => dead, EPERM => alive but not ours).
function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Kill a whole process group (the runner is spawned detached => its pid is its
// pgid). Returns true if a kill was attempted.
function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // ESRCH: already gone
  }
}

// Cross-platform process-tree kill: POSIX uses the process-group signal (the
// runner/watchdog is spawned detached, so -pid reaches it and its children);
// Windows has no negative-pid signals, so `taskkill /t` reaps the tree instead.
function killTree(pid, signal) {
  if (!pid || pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      const args = ['/pid', String(pid), '/t', signal === 'SIGKILL' ? '/f' : ''].filter(Boolean);
      spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }
  return killGroup(pid, signal);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Append a timestamped line to a run log (runner/dispatch logs).
function logLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `[${ts()}] ${line}\n`, 'utf8');
}

module.exports = {
  pinEnv,
  resolveRepo,
  dataDir,
  stateDir,
  logRoot,
  skillRoot,
  readConfig,
  readMachine,
  writeMachine,
  readState,
  writeState,
  appendNotes,
  writePid,
  readPid,
  notify,
  ts,
  sleep,
  isAlive,
  killGroup,
  killTree,
  ensureDir,
  logLine,
};
