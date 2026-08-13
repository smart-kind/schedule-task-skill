'use strict';
// core.js — shared plumbing for the schedule-task CLI.
// Repo/data/state path resolution, machine identity (.machine), the state-file
// contract (first line = state word), milestone notes, the notify hook, and the
// FL_* / LIMIT_* / MAX_* environment seams. No AI in this loop — deterministic only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { showFile } = require('./git.js');

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
// Data schema version — the committed data-format contract, NOT the package
// version. Bump SCHEMA_VERSION only when envelope/prompt/report/state formats
// change (low frequency); package.json version bumps on any code change.
//   .schedule-tasks-data/version < SCHEMA_VERSION  → needs `migrate`
//   .schedule-tasks-data/version > SCHEMA_VERSION  → CLI too old, refuse
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 2;

// Read the committed data schema version from a data root. Returns null when
// the data dir is absent (nothing to check); an existing data dir without a
// version file is legacy v0 (needs migrate — write commands must not touch it).
function readSchemaVersion(autoRoot) {
  if (!fs.existsSync(autoRoot)) return null;
  try {
    const n = Number(String(fs.readFileSync(path.join(autoRoot, 'version'), 'utf8')).trim());
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0; // data dir present but unversioned → legacy
  }
}

// The schema gate for a repo. Status codes:
//   { status: 'no-data' }                    — no .schedule-tasks-data/ at all
//   { status: 'ok' }                         — data schema == CLI schema
//   { status: 'migrate-needed', data }       — data < CLI schema (needs migrate)
//   { status: 'cli-too-old', data }          — data > CLI schema (upgrade CLI)
function schemaCheck(repo) {
  const data = readSchemaVersion(dataDir(repo));
  if (data === null) return { status: 'no-data' };
  if (data === SCHEMA_VERSION) return { status: 'ok' };
  if (data < SCHEMA_VERSION) return { status: 'migrate-needed', data };
  return { status: 'cli-too-old', data };
}

// Stamp the current schema version into a data dir (init on fresh installs,
// migrate on upgrades). The file is committed — it rides git with the data.
function writeSchemaVersion(autoRoot) {
  ensureDir(autoRoot);
  fs.writeFileSync(path.join(autoRoot, 'version'), `${SCHEMA_VERSION}\n`, 'utf8');
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

// The directory the CLI itself ships from (skill repo root). The installed
// copies are self-contained (no symlinks, no global install); realpath just
// resolves the copy's own path (and the dev checkout when run from there).
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

// v3 state words: pending (implicit) / running / done / merge-failed /
// failed / cancelled.  Back-compat aliases: v1–v2 `done` is kept; `dev-done`
// normalises to `done`; the old audit states map to `done` / `failed`.
const STATE_ALIASES = { 'dev-done': 'done', 'audit-pass': 'done', 'audit-fail': 'failed' };
function normalizeState(word) {
  return STATE_ALIASES[word] || word;
}

// Terminal (no further dispatch) states. Anything else is pending/running.
const TERMINAL_STATES = ['done', 'merge-failed', 'failed', 'cancelled'];
function isTerminalState(word) {
  return TERMINAL_STATES.includes(normalizeState(word));
}

// The current batch = the NEWEST non-archived manifest in batches/ (the system
// runs one batch at a time). null when none. Archived manifests live in
// batches/archive/, so archiving a batch moves the pointer to nothing/older.
function currentBatch(repo) {
  const batchesDir = path.join(dataDir(repo), 'batches');
  let files = [];
  try {
    files = fs.readdirSync(batchesDir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return null;
  }
  const last = files[files.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(batchesDir, last), 'utf8'));
  } catch {
    return null;
  }
}

// Workers profile — .schedule-tasks-data/workers.json (committed).
// An array of worker entries, each with id (W01…), name, agent (kimi|cc), and
// per-stage models. Read by dispatch (worker selection during dev create) and
// by the runner (resolve models per stage). Absence = no workers configured.
function readWorkers(repo) {
  const f = path.join(dataDir(repo), 'workers.json');
  if (!fs.existsSync(f)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.workers || []);
  } catch {
    return [];
  }
}

function writeWorkers(repo, workers) {
  const f = path.join(dataDir(repo), 'workers.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify({ workers }, null, 2)}\n`, 'utf8');
}

// Find a worker entry by its id (e.g. "W01"). null when not found.
function findWorker(repo, workerId) {
  return readWorkers(repo).find((w) => w.id === workerId) || null;
}

// Copy the prompt templates (harness-common + the dev harness) into the
// repo's committed data dir, so worktree prompts can reference them. Templates
// are always refreshed from the skill copy they run under.
function ensureTemplates(repo) {
  const src = path.join(skillRoot(), 'templates');
  const dest = path.join(dataDir(repo), 'templates');
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith('.md')) continue;
    try {
      fs.copyFileSync(path.join(src, f), path.join(dest, f));
    } catch {
      /* never fail the caller over a template */
    }
  }
}

// Author-side task state from the committed report: local copy if present, else
// the merged copy on origin/<inbox> (reports reach dev via the worker merge).
function reportState(repo, id) {
  const root = dataDir(repo);
  const local = path.join(root, 'reports', `${id}.md`);
  if (fs.existsSync(local)) return reportMarker(fs.readFileSync(local, 'utf8'));
  const rel = path.posix.join(path.relative(repo, root), 'reports', `${id}.md`);
  const r = showFile(repo, `origin/${readConfig().inbox}`, rel);
  if (r.ok) return reportMarker(r.stdout);
  return '';
}

function reportMarker(text) {
  const m = /\((done|failed|merge-failed)\)/.exec(text);
  return m ? normalizeState(m[1]) : 'done';
}

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
  SCHEMA_VERSION,
  readSchemaVersion,
  schemaCheck,
  writeSchemaVersion,
  dataDir,
  stateDir,
  logRoot,
  skillRoot,
  readConfig,
  readMachine,
  writeMachine,
  readState,
  writeState,
  normalizeState,
  isTerminalState,
  currentBatch,
  readWorkers,
  writeWorkers,
  findWorker,
  ensureTemplates,
  reportState,
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
