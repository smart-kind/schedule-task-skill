'use strict';
// watchdog.js — the常驻看门狗 sub-command: start / stop / status / run.
//
// Replaces the old "cron every 5 min calls dispatch" model with a self-managed
// daemon process: `schedule-task watchdog start` spawns a detached Node process
// that runs the dispatch tick (src/dispatch.js) on a fixed interval and records
// its health in a small status file, so `status` answers "alive? what did the
// last check do" without asking the process. No cron / systemd / launchd needed —
// pure Node + pid file, cross-platform (Windows included; stopping uses
// taskkill /t on Windows since there are no negative-pid signals).
//
// Files (per repo, under .schedule-tasks-data/state/):
//   .watchdog.pid     the daemon's pid (stale detected via signal 0)
//   .watchdog.status  { startedAt, lastCheckAt, lastResult, launched, ticks }

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const core = require('./core.js');
const { dispatch } = require('./dispatch.js');

const PID_FILE = '.watchdog.pid';
const STATUS_FILE = '.watchdog.status';
const LOG_FILE = 'watchdog.log';

function pidFile(stateDir) {
  return path.join(stateDir, PID_FILE);
}
function statusFile(stateDir) {
  return path.join(stateDir, STATUS_FILE);
}
function readPid(stateDir) {
  try {
    const n = Number(fs.readFileSync(pidFile(stateDir), 'utf8').trim() || 0);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
function writeStatus(stateDir, obj) {
  fs.writeFileSync(statusFile(stateDir), `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}
function readStatus(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(statusFile(stateDir), 'utf8'));
  } catch {
    return null;
  }
}

// schedule-task watchdog start [--interval <seconds>]
// Spawn a detached daemon that runs the tick loop, then return immediately.
function start({ repo, config, interval }) {
  const stateDir = core.stateDir(repo);
  core.ensureDir(stateDir);
  const existing = readPid(stateDir);
  if (existing && core.isAlive(existing)) {
    console.error(`watchdog: already running (pid ${existing}); \`watchdog status\` to inspect, \`watchdog stop\` to stop`);
    return { exit: 1 };
  }
  const cliPath = path.join(__dirname, '..', 'bin', 'schedule-task.js');
  let child;
  try {
    child = spawn(
      process.execPath,
      [cliPath, 'watchdog', 'run', '--repo', repo, '--interval', String(interval)],
      { detached: true, stdio: 'ignore', env: { ...process.env, HOME: process.env.HOME } }
    );
  } catch (err) {
    console.error(`watchdog: spawn failed: ${err.message}`);
    return { exit: 1 };
  }
  child.on('error', (err) => console.error(`watchdog: daemon error: ${err.message}`));
  child.unref();
  // The daemon also writes its own pid; write it here too so status works even
  // in the window before the child boots.
  core.ensureDir(stateDir);
  fs.writeFileSync(pidFile(stateDir), String(child.pid), 'utf8');
  console.log(`watchdog: started (pid ${child.pid}); checking every ${interval}s — \`watchdog status\` to inspect`);
  return { exit: 0 };
}

// schedule-task watchdog stop — SIGTERM the daemon (SIGKILL after a 5s grace),
// clear the pid file. Idempotent: stopping a dead daemon is a no-op.
async function stop({ repo, config }) {
  const stateDir = core.stateDir(repo);
  core.ensureDir(stateDir);
  const pid = readPid(stateDir);
  if (!pid) {
    console.log('watchdog: not running');
    return { exit: 0 };
  }
  if (!core.isAlive(pid)) {
    console.log(`watchdog: not running (pid ${pid} stale — cleaned up)`);
    try {
      fs.unlinkSync(pidFile(stateDir));
    } catch {
      /* already gone */
    }
    return { exit: 0 };
  }
  core.killTree(pid, 'SIGTERM');
  for (let i = 0; i < 25 && core.isAlive(pid); i += 1) {
    await core.sleep(200);
  }
  if (core.isAlive(pid)) core.killTree(pid, 'SIGKILL');
  try {
    fs.unlinkSync(pidFile(stateDir));
  } catch {
    /* already gone */
  }
  console.log(`watchdog: stopped (pid ${pid})`);
  return { exit: 0 };
}

// schedule-task watchdog status — read-only; exit 0 = running, 1 = stopped.
function status({ repo, config }) {
  const stateDir = core.stateDir(repo);
  core.ensureDir(stateDir);
  const pid = readPid(stateDir);
  const alive = Boolean(pid) && core.isAlive(pid);
  const st = readStatus(stateDir);
  console.log(`watchdog status · repo: ${repo}`);
  if (alive) {
    console.log(`状态: 运行中 (pid ${pid})`);
  } else if (pid) {
    console.log(`状态: 已停止 (pid ${pid} 已失效)`);
  } else {
    console.log(st
      ? `状态: 已停止（上次检查 ${st.lastCheckAt || '?'}，累计 ${st.ticks || 0} 次）`
      : '状态: 已停止（从未启动）');
  }
  if (st) {
    console.log(`启动时间: ${st.startedAt || '-'}`);
    console.log(`上次检查: ${st.lastCheckAt || '-'}     累计检查: ${st.ticks || 0} 次`);
    console.log(`上次检查结果: ${st.lastResult || '-'}`);
  }
  return { exit: alive ? 0 : 1 };
}

// schedule-task watchdog run --repo <repo> [--interval <seconds>]
// The daemon body (normally spawned detached by `start`). Runs one tick
// immediately, then every `interval` seconds. Never exits on its own.
async function run({ repo, config, interval }) {
  const stateDir = core.stateDir(repo);
  core.ensureDir(stateDir);
  // Guard against a second daemon on the same repo.
  const existing = readPid(stateDir);
  if (existing && existing !== process.pid && core.isAlive(existing)) {
    core.logLine(path.join(core.logRoot(repo, config), LOG_FILE),
      `watchdog run: another daemon is alive (pid ${existing}); refusing to start`);
    process.exit(1);
  }
  fs.writeFileSync(pidFile(stateDir), String(process.pid), 'utf8');
  const startedAt = core.ts();
  let ticks = 0;
  writeStatus(stateDir, { startedAt, lastCheckAt: null, lastResult: 'daemon started', launched: 0, ticks: 0 });
  const logFile = path.join(core.logRoot(repo, config), LOG_FILE);
  core.logLine(logFile, `watchdog run: started pid=${process.pid} repo=${repo} interval=${interval}s`);

  const tick = async () => {
    let result;
    let launched = 0;
    try {
      const r = dispatch({ repo, config });
      launched = r.launched || 0;
      result = launched > 0 ? `启动 ${launched} 个任务` : '无事发生（没有到点的任务）';
    } catch (err) {
      result = `异常: ${err.message}`;
    }
    ticks += 1;
    writeStatus(stateDir, { startedAt, lastCheckAt: core.ts(), lastResult: result, launched, ticks });
    core.logLine(logFile, `tick #${ticks}: ${result}`);
  };

  // First tick immediately, then on the interval (setInterval keeps the loop alive).
  await tick();
  setInterval(() => {
    tick().catch(() => {});
  }, interval * 1000);
  // Daemon: keep running until stopped.
  return new Promise(() => {});
}

module.exports = { start, stop, status, run, pidFile, statusFile, readPid, readStatus };
