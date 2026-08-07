'use strict';
// runner.test.js — (a) happy path, (b) limit → park → resume.
// Port of runtime-self-test.sh sections (a) and (b), against the Node runner and
// the shared mock coding-agent CLI.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('./helpers.js');
const core = require('../src/core.js');
const { readConfig } = require('../src/core.js');
const { runOne } = require('../src/runner.js');

test('(a) runner happy path (agent defaults to claude)', async () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-a');
    helpers.addTask(repo, { id: 't-happy', branch: 'automation/t-happy', model: 'opus' },
      'do the thing; end with the TASK_DONE sentinel');

    const mock = helpers.installMock(t);
    const logRoot = path.join(t, 'logroot-a');
    process.env.CLAUDE_BIN = mock;
    process.env.KIMI_BIN = mock;
    process.env.MOCK_AGENT = 'claude';
    process.env.MOCK_BEHAVIOR = 'happy';
    process.env.MOCK_TASK_ID = 't-happy';
    process.env.MOCK_CALLS = path.join(t, 'calls-a');
    process.env.MOCK_COUNT = path.join(t, 'count-a');
    process.env.FL_LOG_ROOT = logRoot;

    const res = await runOne({ repo, id: 't-happy', config: readConfig() });
    assert.equal(res.status, 'done');
    assert.equal(core.readState(core.stateDir(repo), 't-happy'), 'done');

    const wt = path.join(logRoot, 'worktrees', 't-happy');
    const report = fs.readFileSync(path.join(wt, '.schedule-tasks-data', 'reports', 't-happy.md'), 'utf8');
    assert.match(report, /\(done\)/);

    const notes = fs.readFileSync(path.join(core.stateDir(repo), 't-happy.notes'), 'utf8');
    assert.match(notes, /start agent=claude model=opus branch=automation\/t-happy/);
    assert.match(notes, /TASK_DONE detected/);
    assert.match(notes, /finished done/);

    assert.equal(fs.readFileSync(path.join(logRoot, 't-happy', 'session_id'), 'utf8'), 'sess-123');
    const calls = fs.readFileSync(path.join(t, 'calls-a'), 'utf8');
    assert.match(calls, /agent=claude mode=fresh sessid=-/);
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
    process.env.CLAUDE_BIN = mock;
    process.env.KIMI_BIN = mock;
    process.env.MOCK_AGENT = 'kimi';
    process.env.MOCK_BEHAVIOR = 'limit';
    process.env.MOCK_TASK_ID = 't-limit';
    process.env.MOCK_CALLS = path.join(t, 'calls-b');
    process.env.MOCK_COUNT = path.join(t, 'count-b');
    process.env.FL_LOG_ROOT = path.join(t, 'logroot-b');
    process.env.LIMIT_FALLBACK = '1';

    const res = await runOne({ repo, id: 't-limit', config: readConfig() });
    assert.equal(res.status, 'done');
    assert.equal(core.readState(core.stateDir(repo), 't-limit'), 'done');

    const calls = fs.readFileSync(path.join(t, 'calls-b'), 'utf8');
    assert.match(calls, /agent=kimi mode=resume sessid=sess-123/, 'resume happened with the parked session');
    assert.equal(calls.trim().split('\n').length, 2, 'exactly two attempts');

    const notes = fs.readFileSync(path.join(core.stateDir(repo), 't-limit.notes'), 'utf8');
    assert.match(notes, /limit park 1s \(attempt 1\)/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
