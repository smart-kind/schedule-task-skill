'use strict';
// status.js — read-only status reporter (port of automation/status.sh).
// Prints one row per task (active + archived) with its current state, derived
// from whatever signals the current machine actually has. NEVER mutates anything.
//
// Mode auto-detect (one command that adapts, not two):
//   - WORKER: .machine says role=worker, or live state/<id> flags / run logs exist.
//     Shows live running/attempt/checkpoint detail + per-task notes tails.
//   - AUTHOR: only committed artifacts exist after `git fetch` (state/ is
//     gitignored). State is inferred from each task branch's committed
//     .schedule-tasks-data/reports/<id>.md — local copy when present, else read
//     from origin/<branch> via `git show`.
//
// Env seams (same names as the bash era): FL_MODE, FL_AUTO_ROOT (the data dir),
// FL_LOG_ROOT. `--self-test` fabricates a throwaway tree and asserts both modes.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.js');
const { git, showFile } = require('./git.js');

const COL = (s, n) => s.padEnd(n);

// The CLI version this skill copy ships (package.json next to the source).
const CLI_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(core.skillRoot(), 'package.json'), 'utf8')).version;
  } catch {
    return '?';
  }
})();

function detectMode({ autoRoot, logRoot, mode }) {
  if (mode) return mode;
  try {
    const raw = fs.readFileSync(path.join(autoRoot, 'state', '.machine'), 'utf8');
    const m = /^role=(author|worker)$/m.exec(raw);
    if (m) return m[1];
  } catch {
    /* no .machine */
  }
  let hasState = false;
  try {
    for (const f of fs.readdirSync(path.join(autoRoot, 'state'))) {
      if (!f.startsWith('.')) {
        hasState = true;
        break;
      }
    }
  } catch {
    /* no state dir */
  }
  if (hasState || fs.existsSync(logRoot)) return 'worker';
  return 'author';
}

// The task's report body: local copy if present, else the committed copy on the
// inbox branch (reports are merged to dev by the worker, so the author reads
// them from origin/<inbox> after a fetch — no branch awareness needed).
function reportContent({ repo, autoRoot, taskFile, id }) {
  const local = path.join(autoRoot, 'reports', `${id}.md`);
  if (fs.existsSync(local)) return { ok: true, text: fs.readFileSync(local, 'utf8') };
  const rel = path.posix.join(path.relative(repo, autoRoot), 'reports', `${id}.md`);
  return showFile(repo, `origin/${core.readConfig().inbox}`, rel);
}

function reltime(t, now) {
  const d = t - now;
  const a = Math.abs(d);
  const u = a < 3600 ? `${Math.floor(a / 60)}m` : a < 86400 ? `${Math.floor(a / 3600)}h` : `${Math.floor(a / 86400)}d`;
  return d >= 0 ? `in ${u}` : `${u} ago`;
}

// ---- live process tree (worker mode) ---------------------------------------
// Renders the tree watchdog → runner → executor CLI with each process's elapsed
// running time, so "running but actually dead" states are obvious at a glance.

function dur(sec) {
  if (!Number.isFinite(sec)) return '?';
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m`;
}

// Direct children of pid (via /proc on Linux, `pgrep -P` elsewhere — macOS has
// no GNU `ps --ppid`, so pgrep is the portable fallback).
// null = cannot tell (no /proc, no pgrep).
function childPids(pid) {
  try {
    const kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    return kids ? kids.split(/\s+/).map(Number).filter(Boolean) : [];
  } catch {
    try {
      const { spawnSync } = require('node:child_process');
      const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
      if (r.error) return null;
      // pgrep exits 1 with empty output when there are no children — that is a
      // legitimate [] result, not "cannot tell".
      return r.stdout ? r.stdout.split('\n').map((l) => Number(l.trim())).filter(Boolean) : [];
    } catch {
      return null;
    }
  }
}

// "MM:SS", "HH:MM:SS" or "D-HH:MM:SS" (GNU and BSD `etime`) → seconds. null = unparseable.
function etimeSecs(t) {
  const s = (t || '').trim();
  if (!s) return null;
  let d = 0;
  let rest = s;
  const dm = /^(\d+)-/.exec(s);
  if (dm) {
    d = Number(dm[1]);
    rest = s.slice(dm[0].length);
  }
  const nums = rest.split(':').map(Number);
  if (nums.length === 3) return d * 86400 + nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 2) return d * 86400 + nums[0] * 60 + nums[1];
  if (nums.length === 1 && Number.isInteger(nums[0]) && nums[0] >= 0) return d * 86400 + nums[0];
  return null;
}

// { pid: { ppid, etimes, args } } for a set of pids; empty on failure.
// Uses `etime` (not Linux-only `etimes`) so BSD ps on macOS parses too.
function psInfo(pids) {
  const info = new Map();
  if (!pids.length) return info;
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(
      'ps', ['-o', 'pid=', '-o', 'ppid=', '-o', 'etime=', '-o', 'args=', '-p', pids.join(',')],
      { encoding: 'utf8' }
    );
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (m) info.set(Number(m[1]), { ppid: Number(m[2]), etimes: etimeSecs(m[3]), args: m[4] });
    }
  } catch {
    /* ps unavailable */
  }
  return info;
}

// pid plus every descendant, breadth-first while /proc (or ps) still answers.
function subtree(root, acc) {
  acc.push(root);
  const kids = childPids(root);
  if (kids === null) return acc;
  for (const c of kids) subtree(c, acc);
  return acc;
}

// Human label: watchdog / run <id> / claude|kimi / argv[0] basename.
function procLabel(info) {
  const args = (info.args || '').trim();
  if (/schedule-task\.js watch/.test(args)) return 'watchdog';
  const rm = /schedule-task\.js run\s+(\S+)/.exec(args);
  if (rm) return `run ${rm[1]}`;
  const am = /^(?:\/[\w/.-]*\/)?(claude|kimi)(?:\s|$)/.exec(args);
  if (am) return am[1];
  return (args.split(/\s+/)[0].split('/').pop() || '?').slice(0, 20);
}

// Tree lines under the watchdog: one branch per running task (runner pid from
// state/<id>.pid, regardless of its real parent — manual `run` restarts work
// too), each with its executor CLI below. null when there is nothing live.
function processTree(autoRoot, stateDir) {
  let wpid = 0;
  try {
    wpid = Number(fs.readFileSync(path.join(stateDir, '.watchdog.pid'), 'utf8').trim()) || 0;
  } catch {
    wpid = 0;
  }
  const watchdogAlive = wpid > 0 && core.isAlive(wpid);

  // Running tasks: state/<id> == 'running' with a live runner pid.
  const runners = [];
  let files = [];
  try {
    files = fs.readdirSync(stateDir);
  } catch {
    files = [];
  }
  for (const f of files) {
    if (f.startsWith('.') || f.endsWith('.notes') || f.endsWith('.pid')) continue;
    if (core.readState(stateDir, f) !== 'running') continue;
    const pid = core.readPid(stateDir, f);
    if (pid && core.isAlive(pid)) runners.push({ id: f, pid });
  }
  if (!watchdogAlive && !runners.length) return null;

  // Collect watchdog + every runner subtree into one pid set.
  const pidToTask = new Map(); // runner pid → task id
  const allPids = [];
  if (watchdogAlive) allPids.push(wpid);
  for (const r of runners) {
    subtree(r.pid, allPids);
    pidToTask.set(r.pid, r.id);
  }
  const info = psInfo(allPids.filter((p) => core.isAlive(p)));
  if (!info.size) return null;

  const byParent = new Map();
  for (const pid of allPids) {
    const it = info.get(pid);
    if (!it) continue;
    if (!byParent.has(it.ppid)) byParent.set(it.ppid, []);
    byParent.get(it.ppid).push(pid);
  }
  // Rendered as its own branch below — don't let the watchdog's natural
  // children recursion duplicate a task runner.
  if (watchdogAlive) {
    byParent.set(wpid, (byParent.get(wpid) || []).filter((p) => !pidToTask.has(p)));
  }

  const lines = ['processes:'];
  const render = (pid, prefix, connector) => {
    const it = info.get(pid);
    if (!it) return;
    const label = pidToTask.has(pid) ? `run ${pidToTask.get(pid)}` : procLabel(it);
    let line = `${prefix}${connector}${label} (${pid}) · ${dur(it.etimes)}`;
    if (/^(claude|kimi)$/.test(procLabel(it)) && it.args) {
      line += ` · ${it.args.length > 110 ? `${it.args.slice(0, 110)}…` : it.args}`;
    }
    lines.push(line);
    const kids = (byParent.get(pid) || []).sort((a, b) => a - b);
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      render(k, `${prefix}${connector ? (last ? '   ' : '│  ') : ''}`, last ? '└─ ' : '├─ ');
    });
  };

  if (watchdogAlive) render(wpid, '', '');
  runners.forEach((r, i) => {
    const last = i === runners.length - 1;
    const prefix = watchdogAlive ? (last ? '   ' : '│  ') : '';
    const connector = watchdogAlive ? (last ? '└─ ' : '├─ ') : '';
    render(r.pid, prefix, connector);
  });
  return lines;
}

// Running task progress: every commit the task branch adds on top of the inbox
// branch (newest first) plus a short summary distilled from the meaningful ones
// (system autosaves skipped). null when there is no worktree to read.
function taskProgress({ logRoot, id }) {
  const wt = path.join(logRoot, 'worktrees', id);
  if (!fs.existsSync(path.join(wt, '.git'))) return null;
  const inbox = core.readConfig().inbox;
  const r = git(wt, ['log', `${inbox}..HEAD`, '--pretty=format:%ad|%s', '--date=format:%H:%M']);
  if (!r.ok) return null;
  const commits = r.stdout.split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('|');
    return { time: i >= 0 ? l.slice(0, i) : '?', msg: i >= 0 ? l.slice(i + 1) : l };
  });
  const meaningful = commits.filter((c) => !/autosave|report: task|TASK_DONE/i.test(c.msg));
  let summary = '';
  if (meaningful.length) {
    summary = meaningful.map((c) => c.msg).join('；');
    if (summary.length > 20) summary = `${summary.slice(0, 20)}…`;
  }
  return { commits, summary };
}

// Progress block lines under a running task row: every commit + distilled summary.
function sayProgress(row, say) {
  if (!row.progress.commits.length) {
    say('  提交: 暂无（任务尚未提交代码）');
    return;
  }
  say(`  提交 (${row.branch || '?'}):`);
  for (const c of row.progress.commits) say(`    [${c.time}] ${c.msg}`);
  say(`  总结: ${row.progress.summary || '尚无实质提交（只有自动保存）'}`);
}

// Compute "state<TAB>detail" for one task file, honouring the current mode.
function taskRow({ repo, autoRoot, logRoot, taskFile, id, archived, mode, live }) {
  if (mode === 'worker' && live === 'running') {
    const rl = path.join(logRoot, id, 'run.log');
    let att = 0;
    let ckpt = null;
    let started = null;
    try {
      const text = fs.readFileSync(rl, 'utf8');
      // Attempt count of the LATEST run only — manual re-runs after a reboot
      // each restart the counter, so counting every line would over-report.
      att = (text.split(/^\[[^\]]*\] start id=/m).pop().match(/attempt \d+/g) || []).length;
      const ckpts = text.match(/\[\[CHECKPOINT[^\]]*\]\]/g) || [];
      if (ckpts.length) ckpt = ckpts[ckpts.length - 1];
      const first = text.split('\n', 1)[0] || '';
      const m = /^\[([^\]]*)\]/.exec(first);
      if (m) started = m[1];
    } catch {
      /* no run log yet */
    }
    // Running time in minutes since the run started — friendlier than an ISO ts.
    let startedMin = null;
    if (started) {
      const t = Date.parse(started);
      if (Number.isFinite(t)) startedMin = Math.max(0, Math.floor((Date.now() - t) / 60000));
    }
    // Executor: which AI CLI + model this task consumes (envelope) — the
    // traffic-allocation signal — plus the branch's commit trail.
    let agent = 'claude';
    let model = 'opus';
    let branch = '';
    try {
      const env = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
      if (env.agent) agent = env.agent;
      if (env.model) model = env.model;
      branch = env.branch || '';
    } catch {
      /* envelope missing */
    }
    const detail = `attempt=${att}; ${agent}/${model}; started=${startedMin === null ? started || '?' : `${startedMin}m`}; ${ckpt || 'no-checkpoint'}`;
    return { state: 'running', detail, progress: taskProgress({ logRoot, id }), branch };
  }

  const rc = reportContent({ repo, autoRoot, taskFile, id });
  if (rc.ok && rc.text) {
    const m = /\((done|failed|merge-failed)\)/.exec(rc.text);
    const state = m ? core.normalizeState(m[1]) : 'done';
    const finM = /^.*Finished:\s*(.*)$/m.exec(rc.text);
    const attM = /^.*Attempts:\s*(.*)$/m.exec(rc.text);
    let detail = `attempts=${attM ? attM[1].trim() : '?'}; finished=${finM ? finM[1].trim() : '?'}`;
    if (live && live !== state) detail += `; live=${live}`;
    return { state, detail };
  }
  if (archived) return { state: 'archived', detail: 'retired to tasks/archive/' };
  if (live) return { state: live, detail: '(live state only)' };
  return { state: 'pending', detail: 'awaiting dispatch' };
}

function render({ repo, autoRoot, logRoot, mode }) {
  const now = Math.floor(Date.now() / 1000);
  const lines = [];
  const say = (s) => lines.push(s);

  const stateDir = path.join(autoRoot, 'state');
  const tasksDir = path.join(autoRoot, 'tasks');

  say(`schedule-task status  ·  mode: ${mode}  ·  root: ${autoRoot}`);
  const schema = core.readSchemaVersion(autoRoot);
  say(`CLI v${CLI_VERSION} · data schema v${schema === null ? '—' : schema}`);
  say(`${COL('ID', 34)} ${COL('TYPE', 6)} ${COL('SCHEDULE', 14)} ${COL('STATE', 12)} ${'DETAIL'}`);

  // Pass 1 — compute every task's row once (same logic batched or not).
  const rows = new Map();  // id -> { sortkey, batch, line }
  const states = new Map(); // id -> state
  const deps = new Map();   // id -> [deps]
  let taskFiles = [];
  for (const dir of [tasksDir, path.join(tasksDir, 'archive')]) {
    try {
      taskFiles = taskFiles.concat(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)));
    } catch {
      /* missing dir */
    }
  }

  const liveCache = new Map();
  const liveState = (id) => {
    if (!liveCache.has(id)) liveCache.set(id, core.normalizeState(core.readState(stateDir, id)));
    return liveCache.get(id);
  };

  let doneCount = 0; let mergeFailed = 0;
  let fail = 0; let run = 0; let pend = 0; let arch = 0; let canc = 0;
  for (const tf of taskFiles) {
    let env;
    try {
      env = JSON.parse(fs.readFileSync(tf, 'utf8'));
    } catch {
      continue;
    }
    const id = env.id;
    if (!id) continue;
    const archived = tf.includes(`${path.sep}archive${path.sep}`);
    const runat = env.schedule && env.schedule.run_at ? env.schedule.run_at : '';
    const batch = env.batch || '';
    let sortkey = 0;
    let sched = '-';
    if (runat) {
      sortkey = Math.floor(Date.parse(runat) / 1000);
      if (!Number.isFinite(sortkey)) sortkey = 0;
      sched = reltime(sortkey, now);
    }
    const live = mode === 'worker' ? liveState(id) : '';
    const row = taskRow({ repo, autoRoot, logRoot, taskFile: tf, id, archived, mode, live });
    if (archived && row.state !== 'archived') row.detail += '; ARCHIVED';
    switch (row.state) {
      case 'done': doneCount += 1; break;
      case 'merge-failed': mergeFailed += 1; break;
      case 'failed': fail += 1; break;
      case 'running': run += 1; break;
      case 'archived': arch += 1; break;
      case 'pending': pend += 1; break;
      case 'cancelled': canc += 1; break;
    }
    const line = `${COL(id, 34)} ${COL(env.type || '', 6)} ${COL(sched, 14)} ${COL(row.state, 12)} ${row.detail}`;
    rows.set(id, { sortkey, batch, line, progress: row.progress, branch: row.branch });
    states.set(id, row.state);
    deps.set(id, env.depends_on || []);
  }

  // Pass 2 — one section per batch manifest (committed, so visible in both modes).
  const batchSegs = [];
  let batchCount = 0;
  let manifests = [];
  try {
    manifests = fs.readdirSync(path.join(autoRoot, 'batches')).filter((f) => f.endsWith('.json')).sort();
  } catch {
    manifests = [];
  }
  for (const mf of manifests) {
    batchCount += 1;
    let man;
    try {
      man = JSON.parse(fs.readFileSync(path.join(autoRoot, 'batches', mf), 'utf8'));
    } catch {
      continue;
    }
    const bid = man.id;
    const title = man.title || '';
    const notes = man.notes || '';
    const tids = man.tasks || [];
    const total = tids.length;
    let dcnt = 0;
    let nxt = '-';
    for (const tid of tids) {
      if (states.get(tid) === 'done') dcnt += 1;
      if (nxt === '-' && !['done', 'merge-failed', 'failed', 'running', 'cancelled', ''].includes(states.get(tid) || '')) {
        let ok = true;
        for (const dep of deps.get(tid) || []) {
          if (states.get(dep) !== 'done') {
            ok = false;
            break;
          }
        }
        if (ok) nxt = tid;
      }
    }
    let bstate = '';
    if (mode === 'worker') {
      // Raw first line; absent file = '' (not the implicit 'pending' of task states).
      try {
        bstate = fs.readFileSync(path.join(stateDir, `batch-${bid}`), 'utf8').split('\n', 1)[0].trim();
      } catch {
        bstate = '';
      }
    }
    say(`== batch ${bid}${title ? ` — ${title}` : ''} — ${dcnt}/${total} done, next: ${nxt}${bstate ? `  [${bstate}]` : ''}`);
    if (notes) say(`  notes: ${notes.slice(0, 100)}`);
    if (bstate === 'merge-conflict') {
      try {
        const ntail = fs.readFileSync(path.join(stateDir, `batch-${bid}.notes`), 'utf8').trim().split('\n').pop();
        if (ntail) say(`  batch-note: ${ntail}`);
      } catch {
        /* no notes */
      }
    }
    for (const tid of tids) {
      const row = rows.get(tid);
      if (!row) continue; // manifest lists an id whose envelope isn't on this box
      say(`  ${row.line}`);
      if (row.progress) sayProgress(row, say);
      if (mode === 'worker') {
        try {
          const nt = fs.readFileSync(path.join(stateDir, `${tid}.notes`), 'utf8').trim().split('\n').slice(-2);
          for (const l of nt) say(`    note: ${l}`);
        } catch {
          /* no notes file */
        }
      }
    }
    batchSegs.push(`${bid} ${dcnt}/${total}`);
  }

  // Ungrouped — tasks with no batch field (or a batch without a manifest), sorted
  // by schedule. Label printed only when batch sections exist above.
  const urows = [];
  for (const [id, row] of rows) {
    if (!row.batch || !fs.existsSync(path.join(autoRoot, 'batches', `${row.batch}.json`))) {
      urows.push({ sortkey: row.sortkey, line: row.line, progress: row.progress, branch: row.branch });
    }
  }
  urows.sort((a, b) => a.sortkey - b.sortkey);
  if (urows.length) {
    if (batchCount > 0) say('(ungrouped)');
    for (const r of urows) {
      say(r.line);
      if (r.progress) sayProgress(r, say);
    }
  }

  let summary = `${doneCount} done · ${fail} failed · ${run} running · ${pend} pending · ${arch} archived`;
  if (mergeFailed > 0) summary += ` · ${mergeFailed} merge-failed`;
  if (canc > 0) summary += ` · ${canc} cancelled`;
  if (batchSegs.length) summary += ` · batches: ${batchSegs.join(' · ')}`;
  if (mode === 'worker') {
    const tree = processTree(autoRoot, stateDir);
    if (tree) {
      say('----');
      for (const l of tree) say(l);
    }
  }
  say('----');
  say(summary);
  return lines.join('\n');
}

// --self-test: fabricate a throwaway tree and assert both modes render correctly.
function selfTest() {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schedtask-status-'));
  try {
    core.ensureDir(path.join(tmp, 'tasks', 'archive'));
    core.ensureDir(path.join(tmp, 'reports'));
    core.ensureDir(path.join(tmp, 'state'));
    core.ensureDir(path.join(tmp, 'batches'));
    core.ensureDir(path.join(tmp, 'logs', 'run-me'));
    const now = Math.floor(Date.now() / 1000);
    const future = now + 7200;
    const past = now - 3600;
    const fiso = new Date(future * 1000).toISOString();
    const piso = new Date(past * 1000).toISOString();

    const put = (p, c) => fs.writeFileSync(path.join(tmp, p), c, 'utf8');
    put('version', `${core.SCHEMA_VERSION}\n`); // current data schema — self-test exercises the version line
    put('tasks/pend-me.json', JSON.stringify({ id: 'pend-me', type: 'dev', schedule: { run_at: fiso } }));
    put('tasks/done-me.json', JSON.stringify({ id: 'done-me', type: 'dev', schedule: { run_at: piso } }));
    put('reports/done-me.md', `# Report — done-me (done)\n- Attempts: 2\n- Finished: ${piso}\n`);
    core.writeState(path.join(tmp, 'state'), 'done-me', 'done');
    put('tasks/run-me.json', JSON.stringify({ id: 'run-me', type: 'dev', schedule: { run_at: piso } }));
    core.writeState(path.join(tmp, 'state'), 'run-me', 'running');
    core.writePid(path.join(tmp, 'state'), 'run-me', process.pid); // live (this process) → tree branch
    fs.writeFileSync(path.join(tmp, 'logs', 'run-me', 'run.log'),
      '[t0] start\n[t1] attempt 1: fresh run\n[t2] [[CHECKPOINT step 3/5]]\n', 'utf8');
    put('tasks/archive/arch-me.json', JSON.stringify({ id: 'arch-me', type: 'dev', schedule: { run_at: piso } }));
    put('reports/arch-me.md', `# Report — arch-me (done)\n- Attempts: 1\n- Finished: ${piso}\n`);
    put('tasks/b-done1.json', JSON.stringify({ id: 'b-done1', type: 'dev', batch: 'p0805', schedule: { run_at: piso } }));
    put('tasks/b-done2.json', JSON.stringify({ id: 'b-done2', type: 'dev', batch: 'p0805', schedule: { run_at: piso } }));
    put('tasks/b-pend.json', JSON.stringify({ id: 'b-pend', type: 'dev', batch: 'p0805', depends_on: ['b-done1'], schedule: { run_at: fiso } }));
    put('reports/b-done1.md', `# Report — b-done1 (done)\n- Attempts: 1\n- Finished: ${piso}\n`);
    put('reports/b-done2.md', `# Report — b-done2 (done)\n- Attempts: 3\n- Finished: ${piso}\n`);
    core.writeState(path.join(tmp, 'state'), 'b-done1', 'done');
    core.writeState(path.join(tmp, 'state'), 'b-done2', 'done');
    fs.writeFileSync(path.join(tmp, 'state', 'b-done1.notes'),
      `[${piso}] attempt 1 failed: lint\n[${piso}] attempt 2 ok\n[${piso}] done, report written\n`, 'utf8');
    put('batches/p0805.json', JSON.stringify({ id: 'p0805', title: 'P0805 flight', notes: 'retreat + formation + paint', tasks: ['b-done1', 'b-done2', 'b-pend'], merge_target: 'dev' }));
    core.writeState(path.join(tmp, 'state'), 'batch-p0805', 'merge-conflict');
    fs.writeFileSync(path.join(tmp, 'state', 'batch-p0805.notes'),
      `[${piso}] merging 3 branches into dev\n[${piso}] CONFLICT in src/game.js — needs human\n`, 'utf8');
    put('tasks/t-blocked.json', JSON.stringify({ id: 't-blocked', type: 'dev', batch: 'tip1', depends_on: ['run-me'], schedule: { run_at: fiso } }));
    put('batches/tip1.json', JSON.stringify({ id: 'tip1', title: 'Tip1 blocked', notes: '', tasks: ['t-blocked'], merge_target: 'dev' }));
    put('tasks/g-canc.json', JSON.stringify({ id: 'g-canc', type: 'dev', batch: 'canc1', schedule: { run_at: piso } }));
    core.writeState(path.join(tmp, 'state'), 'g-canc', 'cancelled');
    put('batches/canc1.json', JSON.stringify({ id: 'canc1', title: 'Cancelled batch', notes: '', tasks: ['g-canc'], merge_target: 'dev' }));

    let pass = 0;
    let fail = 0;
    const check = (desc, out, re) => {
      if (re.test(out)) {
        console.log(`  ok: ${desc}`);
        pass += 1;
      } else {
        console.log(`  FAIL: ${desc}`);
        console.log(out.split('\n').map((l) => `    ${l}`).join('\n'));
        fail += 1;
      }
    };

    let out = render({ repo: tmp, autoRoot: tmp, logRoot: path.join(tmp, 'logs'), mode: 'worker' });
    console.log('[worker mode]');
    check('pending row', out, /pend-me .* pending/);
    check('done row', out, /done-me .* done .*attempts=2/);
    check('running row', out, /run-me .* running .*CHECKPOINT step 3\/5/);
    check('running row: executor agent/model', out, /run-me .* running .*claude\/opus/);
    check_absent('no commit block without worktree', out, /提交 \(/);
    check('process tree lists live running task', out, /processes:[\s\S]*run run-me \(/);
    check('archived row', out, /arch-me .* done .*ARCHIVED/);
    check('counts line', out, /4 done · 0 failed · 1 running · 3 pending · 0 archived/);
    check('batch header: title + 2/3', out, /== batch p0805 — P0805 flight — 2\/3 done/);
    check('batch header: next task', out, /next: b-pend/);
    check('blocked dep is not next', out, /== batch tip1 — Tip1 blocked — 0\/1 done, next: -$/m);
    check('batch header: merge-conflict', out, /== batch p0805 .*\[merge-conflict\]/);
    check('batch conflict note line', out, /batch-note: .*CONFLICT in src\/game\.js/);
    check('manifest notes line', out, /  notes: retreat \+ formation \+ paint/);
    check('task notes under right task', out, /b-done1 .*\n    note:/);
    check('task notes tail: line 2', out, /note: .*attempt 2 ok/);
    check('task notes tail: line 3', out, /note: .*done, report written/);
    check_absent('task notes tail: oldest dropped', out, /note: .*attempt 1 failed/);
    check('ungrouped section renders', out, /\(ungrouped\)/);
    check('summary batches segment', out, /batches: canc1 0\/1 · p0805 2\/3 · tip1 0\/1/);
    check('cancelled row', out, /g-canc .* cancelled/);
    check('cancelled task is never next', out, /== batch canc1 — Cancelled batch — 0\/1 done, next: -$/m);
    check('counts: cancelled segment', out, /· 1 cancelled/);

    function check_absent(desc, o, re) {
      if (re.test(o)) {
        console.log(`  FAIL: ${desc} (unexpected match)`);
        console.log(o.split('\n').map((l) => `    ${l}`).join('\n'));
        fail += 1;
      } else {
        console.log(`  ok: ${desc}`);
        pass += 1;
      }
    }

    out = render({ repo: tmp, autoRoot: tmp, logRoot: path.join(tmp, 'nope'), mode: 'author' });
    console.log('[author mode — no live state]');
    check('running falls back to pending', out, /run-me .* pending/);
    check('done still done', out, /done-me .* done/);
    check('pending still pending', out, /pend-me .* pending/);
    check('batch header in author mode', out, /== batch p0805 — P0805 flight — 2\/3 done/);
    check_absent('no batch runtime state in author', out, /merge-conflict/);
    check_absent('no worker notes in author', out, /    note:/);

    console.log('----');
    console.log(`self-test: ${pass} passed, ${fail} failed`);
    return fail === 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { render, detectMode, selfTest };
