'use strict';
// dispatch.test.js — (c) eligibility, concurrency cap, machine gating, never-merge.
// Port of runtime-self-test.sh section (c). The runner spawn is injected so the
// tick only records which tasks it would have launched (no real processes).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('./helpers.js');
const core = require('../src/core.js');
const { readConfig } = require('../src/core.js');
const { dispatch } = require('../src/dispatch.js');

test('(c) dispatch: eligibility, concurrency cap, never merges', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-c');
    // Task branches with real (tiny, conflict-free) commits off dev.
    for (const x of ['A', 'B', 'C']) {
      helpers.git(repo, ['checkout', '-qb', `automation/${x}`, 'dev']);
      fs.writeFileSync(path.join(repo, `file-${x}.txt`), `${x}\n`);
      helpers.git(repo, ['add', '-A']);
      helpers.git(repo, ['commit', '-qm', `branch ${x}`]);
    }
    helpers.git(repo, ['checkout', '-q', 'dev']);
    helpers.addTask(repo, { id: 'A', batch: 'b1', branch: 'automation/A' }, 'prompt A');
    helpers.addTask(repo, { id: 'B', batch: 'b1', branch: 'automation/B' }, 'prompt B');
    helpers.addTask(repo, { id: 'C', batch: 'b1', branch: 'automation/C', depends_on: ['A', 'B'] }, 'prompt C');
    const batchesDir = path.join(helpers.dataRoot(repo), 'batches');
    fs.mkdirSync(batchesDir, { recursive: true });
    fs.writeFileSync(path.join(batchesDir, 'b1.json'),
      JSON.stringify({ id: 'b1', title: 'test batch', notes: '', tasks: ['A', 'B', 'C'], merge_target: 'dev' }));
    helpers.git(repo, ['add', '-A']);
    helpers.git(repo, ['commit', '-qm', 'batch b1 fixtures']);
    helpers.git(repo, ['push', '-q', 'origin', 'dev']);

    const stateDir = core.stateDir(repo);
    fs.mkdirSync(stateDir, { recursive: true });
    const launched = [];
    const launch = (id) => {
      launched.push(id);
      return { pid: 0 };
    };

    process.env.FL_MAX_CONCURRENCY = '1';
    dispatch({ repo, config: readConfig(), launch });
    assert.deepEqual(launched, ['A'], 'cap=1: only the first eligible task launches');

    core.writeState(stateDir, 'A', 'running'); // simulate A actually running
    process.env.FL_MAX_CONCURRENCY = '2';
    dispatch({ repo, config: readConfig(), launch });
    assert.deepEqual(launched, ['A', 'B'], 'cap=2, one free slot → B; C still blocked by deps');

    core.writeState(stateDir, 'A', 'done');
    core.writeState(stateDir, 'B', 'done');
    dispatch({ repo, config: readConfig(), launch });
    assert.deepEqual(launched, ['A', 'B', 'C'], 'C launches once deps done');

    core.writeState(stateDir, 'C', 'done');
    dispatch({ repo, config: readConfig(), launch });
    assert.deepEqual(launched, ['A', 'B', 'C'], 'whole batch done → nothing new launches');
    assert.equal(fs.existsSync(path.join(stateDir, 'batch-b1')), false, 'worker wrote no batch merge state');
    for (const x of ['A', 'B', 'C']) {
      assert.equal(fs.existsSync(path.join(repo, `file-${x}.txt`)), false, `worker must not land branch ${x} on dev`);
    }
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('(c) dispatch: machine gating (unassigned / mismatched / role=author / matching)', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-c2');
    helpers.addTask(repo, { id: 'M1', branch: 'automation/M1' }, 'prompt M1');
    helpers.addTask(repo, { id: 'M2', worker: 'other-box', branch: 'automation/M2' }, 'prompt M2');

    const stateDir = core.stateDir(repo);
    fs.mkdirSync(stateDir, { recursive: true });
    const launched = [];
    const launch = (id) => {
      launched.push(id);
      return { pid: 0 };
    };
    process.env.FL_MAX_CONCURRENCY = '2';

    dispatch({ repo, config: readConfig(), launch }); // no .machine → role=worker, id=hostname
    assert.deepEqual(launched, ['M1'], 'unassigned task launches, other-box task skipped');

    core.writeMachine(stateDir, 'author', 'hostbox');
    launched.length = 0;
    dispatch({ repo, config: readConfig(), launch });
    assert.deepEqual(launched, [], 'role=author dispatches nothing');

    core.writeMachine(stateDir, 'worker', 'other-box');
    core.writeState(stateDir, 'M1', 'done');
    launched.length = 0;
    dispatch({ repo, config: readConfig(), launch });
    assert.deepEqual(launched, ['M2'], 'matching worker id launches the assigned task');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
