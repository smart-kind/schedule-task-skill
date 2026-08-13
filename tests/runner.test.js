'use strict';
// runner.test.js — (a) happy path (executor merges to dev → done),
// (a3) executor never merges → merge-failed, (b) limit → park → resume.
// Port of runtime-self-test.sh sections (a) and (b), against the Node runner and
// the shared mock coding-agent CLI (which performs the v3 merge protocol).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('./helpers.js');
const core = require('../src/core.js');
const { readConfig } = require('../src/core.js');
const { runOne } = require('../src/runner.js');
const { git: g } = require('../src/git.js'); // non-throwing git helper (returns {ok})

// Reset mock env so a leaked var from an earlier test (pointing at a deleted
// temp dir) can never make the mock crash.
function resetMockEnv(t) {
  for (const k of ['MOCK_AGENT', 'MOCK_BEHAVIOR', 'MOCK_TASK_ID', 'MOCK_CALLS', 'MOCK_COUNT', 'MOCK_EPOCH', 'FL_LOG_ROOT', 'LIMIT_FALLBACK', 'AMBIGUOUS_SLEEP']) {
    delete process.env[k];
  }
  process.env.MOCK_CALLS = path.join(t, 'mock-calls');
  process.env.MOCK_COUNT = path.join(t, 'mock-count');
}

function reportOnDev(repo, id) {
  return helpers.git(repo, ['show', `dev:.schedule-tasks-data/reports/${id}.md`]);
}

test('(a) runner happy path: executor merges to dev → done, workspace cleaned', async () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-a');
    helpers.addTask(repo, { id: 't-happy', branch: 'automation/t-happy', model: 'opus' },
      'do the thing; end with the TASK_DONE sentinel');

    const mock = helpers.installMock(t);
    const logRoot = path.join(t, 'logroot-a');
    resetMockEnv(t);
    process.env.CLAUDE_BIN = mock;
    process.env.KIMI_BIN = mock;
    process.env.MOCK_AGENT = 'claude';
    process.env.MOCK_BEHAVIOR = 'happy';
    process.env.MOCK_TASK_ID = 't-happy';
    process.env.FL_LOG_ROOT = logRoot;

    const res = await runOne({ repo, id: 't-happy', config: readConfig() });
    assert.equal(res.status, 'done');
    assert.equal(core.readState(core.stateDir(repo), 't-happy'), 'done');

    // The report reached dev (the author's channel) — read from the merged branch.
    const report = reportOnDev(repo, 't-happy');
    assert.match(report, /\(done\)/);
    assert.match(report, /mock executor report/);

    // Workspace is disposable: worktree + task branch gone.
    assert.equal(fs.existsSync(path.join(logRoot, 'worktrees', 't-happy')), false, 'worktree cleaned up');
    assert.equal(g(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/automation/t-happy']).ok, false, 'task branch deleted');

    const notes = fs.readFileSync(path.join(core.stateDir(repo), 't-happy.notes'), 'utf8');
    assert.match(notes, /start agent=claude model=opus branch=automation\/t-happy/);
    assert.match(notes, /TASK_DONE detected/);
    assert.match(notes, /finished done/);

    assert.equal(fs.readFileSync(path.join(logRoot, 't-happy', 'session_id'), 'utf8'), 'sess-123');
    const calls = fs.readFileSync(path.join(t, 'mock-calls'), 'utf8');
    assert.match(calls, /agent=claude mode=fresh sessid=-/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('(a3) dev advanced after the branch was cut → merge-failed, branch pushed, worktree kept', async () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-a3');
    helpers.addTask(repo, { id: 't-stale', branch: 'automation/t-stale' },
      'do the thing; end with the TASK_DONE sentinel');
    // Advance origin/dev WITHOUT advancing the local dev the task branch is cut
    // from: cut a throwaway branch on top of local dev, push it to origin dev,
    // then restore local dev to the stale state.
    helpers.git(repo, ['checkout', '-q', '-b', 'advance']);
    fs.writeFileSync(path.join(repo, 'other.txt'), 'other\n', 'utf8');
    helpers.git(repo, ['add', '-A']);
    helpers.git(repo, ['commit', '-qm', 'advance dev']);
    helpers.git(repo, ['push', '-q', 'origin', 'advance:dev']);
    helpers.git(repo, ['checkout', '-q', 'dev']);
    helpers.git(repo, ['branch', '-q', '-D', 'advance']);
    fs.rmSync(path.join(repo, 'other.txt'), { force: true });

    const mock = helpers.installMock(t);
    const logRoot = path.join(t, 'logroot-a3');
    resetMockEnv(t);
    process.env.CLAUDE_BIN = mock;
    process.env.KIMI_BIN = mock;
    process.env.MOCK_AGENT = 'claude';
    process.env.MOCK_BEHAVIOR = 'happy';
    process.env.MOCK_TASK_ID = 't-stale';
    process.env.FL_LOG_ROOT = logRoot;

    const res = await runOne({ repo, id: 't-stale', config: readConfig() });
    assert.equal(res.status, 'merge-failed');
    assert.equal(core.readState(core.stateDir(repo), 't-stale'), 'merge-failed');

    // The branch was pushed for the author; the worktree stays for inspection.
    assert.equal(g(repo, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/automation/t-stale']).ok, true, 'branch pushed');
    assert.equal(fs.existsSync(path.join(logRoot, 'worktrees', 't-stale')), true, 'worktree kept');

    const report = fs.readFileSync(path.join(logRoot, 'worktrees', 't-stale', '.schedule-tasks-data', 'reports', 't-stale.md'), 'utf8');
    assert.match(report, /\(merge-failed\)/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('(b) runner limit → park → resume (agent=kimi, LIMIT_FALLBACK=1)', async () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-b');
    helpers.addTask(repo, { id: 't-limit', branch: 'automation/t-limit', model: 'kimi-k2', agent: 'kimi' },
      'do the thing; end with the TASK_DONE sentinel');

    const mock = helpers.installMock(t);
    resetMockEnv(t);
    process.env.CLAUDE_BIN = mock;
    process.env.KIMI_BIN = mock;
    process.env.MOCK_AGENT = 'kimi';
    process.env.MOCK_BEHAVIOR = 'limit';
    process.env.MOCK_TASK_ID = 't-limit';
    process.env.FL_LOG_ROOT = path.join(t, 'logroot-b');
    process.env.LIMIT_FALLBACK = '1';

    const res = await runOne({ repo, id: 't-limit', config: readConfig() });
    assert.equal(res.status, 'done');
    assert.equal(core.readState(core.stateDir(repo), 't-limit'), 'done');

    const calls = fs.readFileSync(path.join(t, 'mock-calls'), 'utf8');
    assert.match(calls, /agent=kimi mode=resume sessid=sess-123/, 'resume happened with the parked session');
    assert.equal(calls.trim().split('\n').length, 2, 'exactly two attempts');

    const notes = fs.readFileSync(path.join(core.stateDir(repo), 't-limit.notes'), 'utf8');
    assert.match(notes, /limit park 1s \(attempt 1\)/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
