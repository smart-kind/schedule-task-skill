'use strict';
// cancel.js — cancel a scheduled task (port of automation/cancel-task.sh).
//   - Pending task: state set to `cancelled`, the dispatcher skips it from then on.
//   - Running task: its process group is killed (runner + limit-park sleep + the
//     coding-agent CLI child all die together — cancel works even mid limit-wait).
//   - CASCADE: active tasks whose depends_on chain includes a cancelled id can
//     never become eligible, so they are cancelled too (reason names the root).
//   - Terminal tasks (done/failed/cancelled) and archived envelopes are refused.
//   - The task's worktree is LEFT in place — inspect, then delete by hand.
//   - No git mutations: cancelling is worker-local state, same as running.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.js');

const sleepMs = (ms) => core.sleep(ms);

function cancel({ repo, target, reason, config }) {
  const stateDir = core.stateDir(repo);
  core.ensureDir(stateDir);
  const tasksDir = path.join(core.dataDir(repo), 'tasks');
  const notify = (event, id, msg) => core.notify(repo, event, id, msg);

  let ids = [];
  if (target === '--all') {
    let files = [];
    try {
      files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
    } catch {
      files = [];
    }
    for (const f of files) {
      let env;
      try {
        env = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
      } catch {
        continue;
      }
      if (!env.id) continue;
      const st = core.normalizeState(core.readState(stateDir, env.id));
      if (st === 'pending' || st === 'running') ids.push(env.id);
    }
    if (ids.length === 0) {
      console.log('cancel: no active (pending/running) tasks');
      return { exit: 0 };
    }
  } else {
    const tf = path.join(tasksDir, `${target}.json`);
    if (!fs.existsSync(tf)) {
      console.error(`cancel: no active task .schedule-tasks-data/tasks/${target}.json`);
      return { exit: 1 };
    }
    ids = [target];
  }

  const result = { killed: 0, cancelled: [], refused: [] };

  const TERMINAL = ['dev-done', 'audit-pass', 'audit-fail', 'merge-failed', 'failed', 'cancelled'];

  // cancel_one <id> <why> — kill if running, mark cancelled, record.
  const cancelOne = (id, why) => {
    const st = core.normalizeState(core.readState(stateDir, id));
    if (TERMINAL.includes(st)) {
      console.log(`cancel: ${id} is '${st}' — nothing to cancel`);
      return false;
    }
    const pid = core.readPid(stateDir, id);
    if (pid && core.isAlive(pid)) {
      core.killTree(pid, 'SIGTERM');
      // Grace window: 5s, then escalate (Windows: taskkill /t /f does it in one).
      for (let i = 0; i < 25 && core.isAlive(pid); i += 1) {
        sleepMs(200);
      }
      if (core.isAlive(pid)) core.killTree(pid, 'SIGKILL');
      console.log(`cancel: killed runner process group (pid ${pid})`);
      result.killed += 1;
    } else if (pid) {
      console.log(`cancel: ${id} pid ${pid} not alive (stale?); marking cancelled`);
    } else {
      console.log(`cancel: ${id} has no live pid (pending?); marking cancelled`);
    }
    core.writeState(stateDir, id, 'cancelled');
    core.appendNotes(stateDir, id, `cancelled: ${why}`);
    notify('cancelled', id, why);
    console.log(`cancel: ${id} cancelled (${why})`);
    const wt = path.join(core.logRoot(repo, config), 'worktrees', id);
    if (fs.existsSync(wt)) {
      console.log(`  note: worktree kept at ${wt} — inspect or delete by hand`);
    }
    return true;
  };

  // BFS over the requested ids, cascading to dependents until fixpoint.
  const queue = ids.map((id) => ({ id, why: reason }));
  const visited = new Set();
  while (queue.length) {
    const { id, why } = queue.shift();
    if (visited.has(id)) continue;
    if (cancelOne(id, why)) {
      visited.add(id);
      result.cancelled.push(id);
      // Dependents: tasks whose depends_on includes this id.
      let files = [];
      try {
        files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
      } catch {
        files = [];
      }
      for (const f of files) {
        let env;
        try {
          env = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
        } catch {
          continue;
        }
        const depId = env.id;
        if (!depId || visited.has(depId)) continue;
        if (!(env.depends_on || []).includes(id)) continue;
        const st = core.normalizeState(core.readState(stateDir, depId));
        if (st === 'running') {
          console.log(`cancel: WARNING dependent ${depId} is already running; leaving it (kill manually if unwanted)`);
        } else if (!TERMINAL.includes(st)) {
          queue.push({ id: depId, why: `dependency ${id} cancelled` });
        }
      }
    }
  }
  return { exit: 0, ...result };
}

module.exports = { cancel };
