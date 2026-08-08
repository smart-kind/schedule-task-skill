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
const { showFile } = require('./git.js');

const COL = (s, n) => s.padEnd(n);

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

// The task's report body: local copy if present, else the committed copy on
// origin/<branch> (reports reach the author only via the task branches until merge).
function reportContent({ repo, autoRoot, taskFile, id }) {
  const local = path.join(autoRoot, 'reports', `${id}.md`);
  if (fs.existsSync(local)) return { ok: true, text: fs.readFileSync(local, 'utf8') };
  let env;
  try {
    env = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  } catch {
    return { ok: false, text: '' };
  }
  const br = env.branch || '';
  if (!br) return { ok: false, text: '' };
  const rel = path.posix.join(path.relative(repo, autoRoot), 'reports', `${id}.md`);
  return showFile(repo, `origin/${br}`, rel);
}

function reltime(t, now) {
  const d = t - now;
  const a = Math.abs(d);
  const u = a < 3600 ? `${Math.floor(a / 60)}m` : a < 86400 ? `${Math.floor(a / 3600)}h` : `${Math.floor(a / 86400)}d`;
  return d >= 0 ? `in ${u}` : `${u} ago`;
}

// Best-effort count of live processes in the tree rooted at pid (the runner,
// its executor CLI, and any tools the CLI spawned). Returns 0 for a missing or
// dead pid, null when the platform cannot count (no /proc and no `ps`).
function countTree(pid) {
  if (!pid) return null;
  if (!core.isAlive(pid)) return 0;
  let n = 1;
  let children = [];
  try {
    // Linux: /proc/<pid>/task/<pid>/children lists direct children without
    // spawning a process. Nothing to read for a zombie the kernel keeps around
    // but already dead — /proc/task disappears when the process exits.
    const kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    if (kids) children = kids.split(/\s+/).map(Number).filter(Boolean);
  } catch {
    // Fallback: `ps --ppid` on systems without /proc.
    try {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync('ps', ['-o', 'pid=', '--ppid', String(pid)], { encoding: 'utf8' });
      children = out.split('\n').map((l) => Number(l.trim())).filter(Boolean);
    } catch {
      return null; // cannot count — caller omits the field
    }
  }
  for (const c of children) {
    const sub = countTree(c);
    if (sub === null) return null;
    n += sub;
  }
  return n;
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
      att = (text.match(/attempt \d+/g) || []).length;
      const ckpts = text.match(/\[\[CHECKPOINT[^\]]*\]\]/g) || [];
      if (ckpts.length) ckpt = ckpts[ckpts.length - 1];
      const first = text.split('\n', 1)[0] || '';
      const m = /^\[([^\]]*)\]/.exec(first);
      if (m) started = m[1];
    } catch {
      /* no run log yet */
    }
    // Live process tree size — the "is it really running?" signal. A stale
    // state file after a reboot shows procs=0 (stale) instead of a live row.
    const pid = core.readPid(path.join(autoRoot, 'state'), id);
    const procs = pid ? countTree(pid) : null;
    let detail = `attempt=${att}`;
    if (pid) {
      detail += `; procs=${procs === null ? '?' : procs}`;
      if (procs === 0) detail += ' (stale)';
    }
    detail += `; started=${started || '?'}; ${ckpt || 'no-checkpoint'}`;
    return { state: 'running', detail };
  }

  const rc = reportContent({ repo, autoRoot, taskFile, id });
  if (rc.ok && rc.text) {
    const m = /\((done|failed)\)/.exec(rc.text);
    const state = m ? m[1] : 'done';
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
  say(`${COL('ID', 34)} ${COL('TYPE', 6)} ${COL('SCHEDULE', 14)} ${COL('STATE', 9)} ${'DETAIL'}`);

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
    if (!liveCache.has(id)) liveCache.set(id, core.readState(stateDir, id));
    return liveCache.get(id);
  };

  let done = 0; let fail = 0; let run = 0; let pend = 0; let arch = 0; let canc = 0;
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
      case 'done': done += 1; break;
      case 'failed': fail += 1; break;
      case 'running': run += 1; break;
      case 'archived': arch += 1; break;
      case 'pending': pend += 1; break;
      case 'cancelled': canc += 1; break;
    }
    const line = `${COL(id, 34)} ${COL(env.type || '', 6)} ${COL(sched, 14)} ${COL(row.state, 9)} ${row.detail}`;
    rows.set(id, { sortkey, batch, line });
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
      if (nxt === '-' && !['done', 'failed', 'running', 'cancelled', ''].includes(states.get(tid) || '')) {
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
      urows.push({ sortkey: row.sortkey, line: row.line });
    }
  }
  urows.sort((a, b) => a.sortkey - b.sortkey);
  if (urows.length) {
    if (batchCount > 0) say('(ungrouped)');
    for (const r of urows) say(r.line);
  }

  let summary = `${done} done · ${fail} failed · ${run} running · ${pend} pending · ${arch} archived`;
  if (canc > 0) summary += ` · ${canc} cancelled`;
  if (batchSegs.length) summary += ` · batches: ${batchSegs.join(' · ')}`;
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
    put('tasks/pend-me.json', JSON.stringify({ id: 'pend-me', type: 'dev', schedule: { run_at: fiso } }));
    put('tasks/done-me.json', JSON.stringify({ id: 'done-me', type: 'test', schedule: { run_at: piso } }));
    put('reports/done-me.md', `# Report — done-me (done)\n- Attempts: 2\n- Finished: ${piso}\n`);
    core.writeState(path.join(tmp, 'state'), 'done-me', 'done');
    put('tasks/run-me.json', JSON.stringify({ id: 'run-me', type: 'dev', schedule: { run_at: piso } }));
    core.writeState(path.join(tmp, 'state'), 'run-me', 'running');
    core.writePid(path.join(tmp, 'state'), 'run-me', 2147483647); // dead pid → procs=0 (stale)
    fs.writeFileSync(path.join(tmp, 'logs', 'run-me', 'run.log'),
      '[t0] start\n[t1] attempt 1: fresh run\n[t2] [[CHECKPOINT step 3/5]]\n', 'utf8');
    put('tasks/archive/arch-me.json', JSON.stringify({ id: 'arch-me', type: 'audit', schedule: { run_at: piso } }));
    put('reports/arch-me.md', `# Report — arch-me (done)\n- Attempts: 1\n- Finished: ${piso}\n`);
    put('tasks/b-done1.json', JSON.stringify({ id: 'b-done1', type: 'dev', batch: 'p0805', schedule: { run_at: piso } }));
    put('tasks/b-done2.json', JSON.stringify({ id: 'b-done2', type: 'test', batch: 'p0805', schedule: { run_at: piso } }));
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
    check('running row: dead pid shows stale procs', out, /run-me .* running .*procs=0 \(stale\)/);
    check('archived row', out, /arch-me .* done .*ARCHIVED/);
    check('counts line', out, /4 done · 0 failed · 1 running · 3 pending/);
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
