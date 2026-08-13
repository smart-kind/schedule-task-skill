'use strict';
// cancel.test.js — (e) kill a running task's process group, cascade to
// dependents, refuse terminal tasks, --all. Port of runtime-self-test.sh (e).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const helpers = require('./helpers.js');
const core = require('../src/core.js');
const { readConfig } = require('../src/core.js');
const { cancel } = require('../src/cancel.js');

function capture(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return logs;
}

test('(e) cancel: kill running, cascade, refuse terminal, --all', async () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-e');
    helpers.addTask(repo, { id: 'X', branch: 'automation/X' }, 'prompt X');
    helpers.addTask(repo, { id: 'Y', batch: 'b2', branch: 'automation/Y' }, 'prompt Y');
    helpers.addTask(repo, { id: 'Z', batch: 'b2', branch: 'automation/Z', depends_on: ['Y'] }, 'prompt Z');
    helpers.addTask(repo, { id: 'P', batch: 'b3', branch: 'automation/P' }, 'prompt P');
    helpers.addTask(repo, { id: 'Q', batch: 'b3', branch: 'automation/Q' }, 'prompt Q');
    const batchesDir = path.join(helpers.dataRoot(repo), 'batches');
    fs.mkdirSync(batchesDir, { recursive: true });
    fs.writeFileSync(path.join(batchesDir, 'b2.json'),
      JSON.stringify({ id: 'b2', title: 'cancel batch', notes: '', tasks: ['Y', 'Z'], merge_target: 'dev' }));
    fs.writeFileSync(path.join(batchesDir, 'b3.json'),
      JSON.stringify({ id: 'b3', title: 'partial batch', notes: '', tasks: ['P', 'Q'], merge_target: 'dev' }));
    helpers.git(repo, ['add', '-A']);
    helpers.git(repo, ['commit', '-qm', 'cancel fixtures']);

    const stateDir = core.stateDir(repo);
    fs.mkdirSync(stateDir, { recursive: true });
    // Y "running": a real detached process group the cancel must kill.
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    core.writeState(stateDir, 'Y', 'running');
    core.writePid(stateDir, 'Y', child.pid);
    core.writeState(stateDir, 'P', 'done');

    process.env.FL_LOG_ROOT = path.join(t, 'logroot-e');
    const config = readConfig();

    let logs = capture(() => cancel({ repo, target: 'Y', reason: 'no longer needed', config }));
    assert.equal(core.readState(stateDir, 'Y'), 'cancelled');
    assert.equal(core.readState(stateDir, 'Z'), 'cancelled', 'dependent cascaded');
    assert.match(fs.readFileSync(path.join(stateDir, 'Z.notes'), 'utf8'), /cancelled: dependency Y cancelled/);
    assert.equal(fs.existsSync(path.join(stateDir, 'X')), false, 'unrelated task untouched');
    assert.match(logs.join('\n'), /killed runner process group/);
    await core.sleep(300);
    assert.equal(core.isAlive(child.pid), false, 'the running process group was killed');

    logs = capture(() => cancel({ repo, target: 'P', reason: 'x', config }));
    assert.match(logs.join('\n'), /P is 'done' — nothing to cancel/);
    assert.equal(core.readState(stateDir, 'P'), 'done', 'terminal task untouched');

    cancel({ repo, target: 'Q', reason: 'superseded', config });
    assert.equal(core.readState(stateDir, 'Q'), 'cancelled');

    cancel({ repo, target: '--all', reason: 'cleanup', config });
    assert.equal(core.readState(stateDir, 'X'), 'cancelled', '--all cancels the remaining pending task');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
