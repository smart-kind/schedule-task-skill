'use strict';
// runner.js — resilient headless runner for one automation task (port of
// automation/run-task.sh). Executes the task's plan-harness prompt via a coding
// CLI (routed through agents.js) inside an ISOLATED git worktree on the task
// branch, and survives usage-limit windows by parking (rc 75 + reset_epoch) and
// resuming the same CLI session with full context. Verifies completion
// (TASK_DONE sentinel + a new commit), writes .schedule-tasks-data/reports/<id>.md,
// pushes, records state, appends milestone notes, fires the notify hook.
// Deterministic — there is no AI in this control loop, only the executor thinks.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.js');
const { git, headSha } = require('./git.js');
const agents = require('./agents.js');

const RESUME_PROMPT =
  'Continue this task. Re-read {prompt} and the latest commit on this branch, then resume ' +
  'from the last checkpoint. Do NOT redo or revert already-committed work.';

async function runOne({ repo, id, config }) {
  const stateDir = core.stateDir(repo);
  const logRoot = core.logRoot(repo, config);
  const logDir = path.join(logRoot, id);
  const worktrees = path.join(logRoot, 'worktrees');
  const wt = path.join(worktrees, id);
  const sessFile = path.join(logDir, 'session_id');
  const runLog = path.join(logDir, 'run.log');
  core.ensureDir(stateDir);
  core.ensureDir(logDir);
  core.ensureDir(worktrees);

  // log — timestamped line to run.log AND stdout (visible on manual runs).
  const log = (msg) => {
    const line = `[${core.ts()}] ${msg}`;
    fs.appendFileSync(runLog, `${line}\n`, 'utf8');
    process.stdout.write(`${line}\n`);
  };
  const note = (msg) => core.appendNotes(stateDir, id, msg);
  const notify = (event, msg) => core.notify(repo, event, id, msg);

  const taskFile = path.join(core.dataDir(repo), 'tasks', `${id}.json`);
  if (!fs.existsSync(taskFile)) {
    core.writeState(stateDir, id, 'failed');
    log(`no task file ${taskFile}`);
    return { status: 'failed' };
  }
  const env = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  const branch = env.branch;
  const promptRel = env.prompt_file;
  const agent = env.agent || 'claude'; // absent = claude (back-compat)
  // Resolve model: envelope override → worker profile dev model → default.
  const workerProfile = env.worker ? core.findWorker(repo, env.worker) : null;
  const model = env.model || (workerProfile && workerProfile.models && workerProfile.models.dev) || 'opus';
  if (!agents.KNOWN_AGENTS.includes(agent)) {
    // Fail fast — never let an unknown agent silently run (or retry 60x).
    core.writeState(stateDir, id, 'failed');
    log(`unknown agent '${agent}' (want ${agents.KNOWN_AGENTS.join('|')})`);
    return { status: 'failed' };
  }
  const sentinel = `[[TASK_DONE ${id}`;

  core.writePid(stateDir, id, process.pid); // cancel kills the process group via this
  core.writeState(stateDir, id, 'running');
  log(`start id=${id} branch=${branch} model=${model} agent=${agent}${workerProfile ? ` profile=${workerProfile.name}` : ''}`);
  note(`start agent=${agent} model=${model} branch=${branch}${workerProfile ? ` profile=${workerProfile.name}` : ''}`);
  notify('started', `agent=${agent} model=${model} branch=${branch}`);

  // --- isolated worktree on the task branch (created fresh, or reused on resume) ---
  let sessionId = '';
  if (fs.existsSync(path.join(wt, '.git'))) {
    log('reusing existing worktree (resume path)');
    try {
      sessionId = fs.readFileSync(sessFile, 'utf8').trim();
    } catch {
      sessionId = '';
    }
    // Fallback (claude only): a hard kill (reboot) can die before session_id was
    // persisted, but it was already streamed to disk — recover it from the newest
    // attempt log. kimi session ids aren't recoverable the same way → fresh start.
    if (!sessionId && agent === 'claude') {
      let newest = null;
      try {
        for (const f of fs.readdirSync(logDir)) {
          if (/^attempt-.*\.jsonl$/.test(f)) {
            const p = path.join(logDir, f);
            const m = fs.statSync(p).mtimeMs;
            if (!newest || m > newest.mtime) newest = { name: f, mtime: m };
          }
        }
      } catch {
        /* no logs */
      }
      if (newest) {
        const recovered = agents.extractSessionId('claude',
          fs.readFileSync(path.join(logDir, newest.name), 'utf8').split('\n'));
        if (recovered) {
          sessionId = recovered;
          log(`recovered session ${sessionId} from ${newest.name}`);
        }
      }
    }
    if (sessionId) log(`will resume ${sessionId}`);
  } else {
    // Base the task branch on the current local inbox-branch tip (dispatch keeps it fresh).
    const brExists = git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
    if (brExists) git(repo, ['branch', '-f', branch, config.inbox]);
    else if (!git(repo, ['branch', branch, config.inbox]).ok) git(repo, ['branch', branch]);
    const added = git(repo, ['worktree', 'add', '-f', wt, branch]);
    if (!added.ok) {
      core.writeState(stateDir, id, 'failed');
      log('worktree add failed');
      return { status: 'failed' };
    }
  }

  const promptFile = path.join(wt, promptRel);
  if (!fs.existsSync(promptFile)) {
    core.writeState(stateDir, id, 'failed');
    log(`no prompt ${promptFile}`);
    return { status: 'failed' };
  }
  const commitBefore = headSha(wt);

  // --- resilient execute/resume loop ---
  let attempt = 0;
  let ambiguous = 0;
  let sawSentinel = false;
  while (attempt < config.maxAttempts) {
    attempt += 1;
    const attemptFile = path.join(logDir, `attempt-${attempt}.jsonl`);
    const mode = sessionId ? 'resume' : 'fresh';
    const promptText = sessionId
      ? RESUME_PROMPT.replace('{prompt}', promptRel)
      : fs.readFileSync(promptFile, 'utf8');
    log(`attempt ${attempt}: ${mode}${sessionId ? ` ${sessionId}` : ''}`);
    note(`attempt ${attempt} ${mode}${sessionId ? ` ${sessionId}` : ''}`);

    const result = await agents.invoke({
      agent, mode, model, sessionId, prompt: promptText, cwd: wt,
      attemptFile, sentinel, config,
    });
    // Refresh SESS_FILE on every attempt (kimi resumes may mint a new session id,
    // and a crash/reboot mid-task must resume the LATEST one).
    if (result.sessionId) {
      sessionId = result.sessionId;
      fs.writeFileSync(sessFile, sessionId, 'utf8');
    }
    if (result.stderr) {
      fs.appendFileSync(runLog, result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`, 'utf8');
    }
    log(`session_id=${sessionId} rc=${result.rc}`);

    if (result.sentinelHit) {
      log('TASK_DONE detected');
      note(`TASK_DONE detected (attempt ${attempt})`);
      sawSentinel = true;
      break;
    }
    if (result.rc === 75) {
      const now = Math.floor(Date.now() / 1000);
      let wait = config.limitFallback;
      if (result.resetEpoch > now && result.resetEpoch < now + 700000) {
        wait = result.resetEpoch - now + config.limitMargin;
      }
      log(`limit hit; sleeping ${wait}s then resuming with context`);
      note(`limit park ${wait}s (attempt ${attempt})`);
      notify('limit-wait', `sleeping ${wait}s before resume (attempt ${attempt})`);
      await core.sleep(wait * 1000);
      continue;
    }

    ambiguous += 1;
    log(`no sentinel, no limit (rc=${result.rc}); ambiguous exit #${ambiguous}/${config.maxAmbiguous}`);
    if (ambiguous >= config.maxAmbiguous) {
      log('too many ambiguous exits; aborting');
      break;
    }
    // A wedged resume can fail instantly; after a few tries drop it for a clean fresh run.
    if (sessionId && ambiguous >= config.ambiguousFreshAt) {
      log(`ambiguous >= ${config.ambiguousFreshAt}; discarding session, next attempt is a fresh run`);
      sessionId = null;
      fs.writeFileSync(sessFile, '', 'utf8');
    }
    await core.sleep(config.ambiguousSleep * 1000);
  }

  // --- finalize: stamp the report, verify the merge, record state, clean up ---
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-m', `task ${id}: autosave uncommitted work`]);
  const commitAfter = headSha(wt);
  const finished = sawSentinel && commitAfter !== commitBefore;

  const inbox = config.inbox;
  const reportRel = path.join('.schedule-tasks-data', 'reports', `${id}.md`);
  const reportFile = path.join(wt, reportRel);

  // Executor final message (fallback body when the executor wrote no report).
  const tail = lastExecutorMessage(logDir);

  // v3.3 flow: the executor ran the full chain (dev → mutation → review → test),
  // integrated the latest dev into its branch (rebase, conflicts resolved in ITS
  // worktree) and committed the consolidated report. The runner verifies
  // mechanically that dev is an ancestor of the branch — then the merge is a
  // conflict-free fast-forward, done in the main checkout.
  let state;
  let merged = false;
  if (finished) {
    git(repo, ['fetch', 'origin', inbox]);
    merged = git(repo, ['merge-base', '--is-ancestor', `origin/${inbox}`, branch]).ok;
    state = merged ? 'done' : 'merge-failed';
  } else {
    // Never finished: the branch is pushed for the author; nothing is merged,
    // the worktree stays for inspection.
    state = 'failed';
  }

  // Stamp the report: the runner owns the H1 state marker + metadata; the
  // executor's body is preserved underneath. Lands on the task branch.
  stampReport(reportFile, id, state, attempt, tail);
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-m', `report: task ${id} (${state})`]);

  if (merged) {
    // Fast-forward dev onto the branch (main checkout is on dev) and push.
    if (!git(repo, ['checkout', inbox]).ok) log(`checkout ${inbox} failed`);
    git(repo, ['merge', '--ff-only', `origin/${inbox}`]);
    if (git(repo, ['merge', '--ff-only', branch]).ok) {
      const pd = git(repo, ['push', 'origin', inbox]);
      if (!pd.ok) log(`push ${inbox} failed (non-fatal)`);
    } else {
      // Race: dev advanced after the ancestor check. Never force a merge.
      git(repo, ['merge', '--abort']);
      state = 'merge-failed';
      merged = false;
      log('ff merge into ' + inbox + ' failed (dev advanced) — marking ' + state);
    }
  }

  if (merged) {
    // Clean up the task's workspace: worktree + local branch are disposable.
    if (git(repo, ['worktree', 'remove', '--force', wt]).ok) {
      git(repo, ['branch', '-D', branch]);
      log(`merged into ${inbox}; cleaned up worktree + branch ${branch}`);
    } else {
      log(`merged into ${inbox}; worktree remove failed (left in place)`);
    }
  } else {
    // Failure / merge-failed: keep the workspace, push the branch
    // so the author can inspect or re-dispatch against it.
    const p = git(repo, ['push', 'origin', branch]);
    if (!p.ok) log(`push ${branch} failed (non-fatal)`);
    log(`kept worktree + pushed branch ${branch} (${state})`);
  }

  core.writeState(stateDir, id, state);
  log(`finished status=${state} before=${commitBefore} after=${commitAfter} merged=${merged} attempts=${attempt}`);
  note(`finished ${state} attempts=${attempt} before=${commitBefore} after=${commitAfter} merged=${merged}`);
  notify(state, `attempts=${attempt} commit=${commitAfter}`);
  return { status: state };
}

// Executor final message: the last 60 result events across every attempt file.
function lastExecutorMessage(logDir) {
  const results = [];
  let files = [];
  try {
    files = fs.readdirSync(logDir).filter((n) => /^attempt-.*\.jsonl$/.test(n)).sort();
  } catch {
    files = [];
  }
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(logDir, f), 'utf8').split('\n')) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj && obj.type === 'result' && obj.result) results.push(String(obj.result));
    }
  }
  return results.slice(-60).join('\n');
}

// Rewrite the report file: the runner owns the first line (`# Report — <id> (<state>)`)
// and the trailing metadata; the executor's body (anything after its own leading
// `# Report` line) is preserved verbatim.
function stampReport(reportFile, id, state, attempt, tail) {
  core.ensureDir(path.dirname(reportFile));
  let body = '';
  try {
    body = fs.readFileSync(reportFile, 'utf8');
  } catch {
    body = '';
  }
  const lines = body.split('\n');
  const start = lines.length && /^# Report/.test(lines[0]) ? 1 : 0;
  const rest = lines.slice(start).join('\n').trim();
  const parts = [
    `# Report — ${id} (${state})`,
    '',
    `- Attempts: ${attempt}`,
    `- Finished: ${core.ts()}`,
    '',
  ];
  if (rest) parts.push(rest, '');
  if (tail && !rest) parts.push('## Executor final message', '```', tail, '```', '');
  fs.writeFileSync(reportFile, parts.join('\n'), 'utf8');
}

module.exports = { runOne };
