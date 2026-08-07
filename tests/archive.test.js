'use strict';
// archive.test.js — retire a finished task into tasks/archive + prompts/archive,
// refuse anything not done/cancelled.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('./helpers.js');
const core = require('../src/core.js');
const { archive } = require('../src/archive.js');

test('archive: done task retires into archive/, pending task refused', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-ar');
    helpers.addTask(repo, { id: 'D', branch: 'automation/D' }, 'prompt D');
    const stateDir = core.stateDir(repo);
    fs.mkdirSync(stateDir, { recursive: true });
    core.writeState(stateDir, 'D', 'done');

    const r1 = archive({ repo, id: 'D' });
    assert.equal(r1.exit, 0);
    assert.ok(fs.existsSync(path.join(helpers.dataRoot(repo), 'tasks', 'archive', 'D.json')), 'envelope moved');
    assert.ok(fs.existsSync(path.join(helpers.dataRoot(repo), 'prompts', 'archive', 'D.md')), 'prompt moved');
    assert.ok(!fs.existsSync(path.join(helpers.dataRoot(repo), 'tasks', 'D.json')), 'out of the active inbox');
    assert.ok(!fs.existsSync(path.join(helpers.dataRoot(repo), 'reports', 'D.md')), 'report untouched');

    helpers.addTask(repo, { id: 'P2', branch: 'automation/P2' }, 'prompt P2');
    const r2 = archive({ repo, id: 'P2' });
    assert.equal(r2.exit, 1, 'pending task refused');
    assert.ok(fs.existsSync(path.join(helpers.dataRoot(repo), 'tasks', 'P2.json')), 'still in the inbox');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
