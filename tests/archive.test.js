'use strict';
// archive.test.js — batch close-out: archives the CURRENT batch (manifest +
// member envelopes + prompts) once every member is terminal, writes the batch
// summary report, pushes, and empties the current batch. Refuses while any
// member is still pending/running.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('./helpers.js');
const core = require('../src/core.js');
const { archive } = require('../src/archive.js');

// Build a repo whose current batch b2 has: dev tasks D1/D2 (done),
// and an extra pending dev task D3.
function makeBatchRepo(t) {
  const { repo } = helpers.makeRepo(t, 'repo-ar');
  const dataRoot = helpers.dataRoot(repo);
  for (const id of ['D1', 'D2']) {
    helpers.addTask(repo, { id, batch: 'b2', branch: `automation/${id}` }, `prompt ${id}`);
  }
  // Pending dev task — refuses archive until resolved.
  helpers.addTask(repo, { id: 'D3', batch: 'b2', branch: 'automation/D3' }, 'prompt D3');
  // Reports on dev: D1/D2 done.
  fs.mkdirSync(path.join(dataRoot, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'reports', 'D1.md'), '# Report — D1 (done)\n- Attempts: 1\n- Finished: now\n', 'utf8');
  fs.writeFileSync(path.join(dataRoot, 'reports', 'D2.md'), '# Report — D2 (done)\n- Attempts: 2\n- Finished: now\n', 'utf8');
  fs.mkdirSync(path.join(dataRoot, 'batches'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'batches', 'b2.json'),
    JSON.stringify({ id: 'b2', title: 'batch two', notes: 'x', tasks: ['D1', 'D2'], merge_target: 'dev' }));
  helpers.git(repo, ['add', '-A']);
  helpers.git(repo, ['commit', '-qm', 'batch b2 fixtures']);
  helpers.git(repo, ['push', '-q', 'origin', 'dev']);
  return repo;
}

test('archive: refuses while a member is still active', () => {
  const t = helpers.tmpdir();
  try {
    const repo = makeBatchRepo(t); // D3 has no report → pending
    const r = archive({ repo });
    assert.equal(r.exit, 1, 'refused while D3 is pending');
    assert.ok(fs.existsSync(path.join(helpers.dataRoot(repo), 'batches', 'b2.json')), 'manifest untouched');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('archive: closes the current batch — moves manifest/envelopes/prompts, writes summary, empties current batch', () => {
  const t = helpers.tmpdir();
  try {
    const repo = makeBatchRepo(t);
    // Resolve D3: give it a done report so the batch is fully terminal.
    const dataRoot = helpers.dataRoot(repo);
    fs.writeFileSync(path.join(dataRoot, 'reports', 'D3.md'), '# Report — D3 (done)\n- Attempts: 1\n- Finished: now\n', 'utf8');
    helpers.git(repo, ['add', '-A']);
    helpers.git(repo, ['commit', '-qm', 'D3 done']);
    helpers.git(repo, ['push', '-q', 'origin', 'dev']);

    const r = archive({ repo });
    assert.equal(r.exit, 0, r.stdout);

    // Manifest + envelopes + prompts archived.
    assert.ok(!fs.existsSync(path.join(dataRoot, 'batches', 'b2.json')), 'manifest moved out');
    assert.ok(fs.existsSync(path.join(dataRoot, 'batches', 'archive', 'b2.json')), 'manifest archived');
    for (const id of ['D1', 'D2', 'D3']) {
      assert.ok(!fs.existsSync(path.join(dataRoot, 'tasks', `${id}.json`)), `${id} out of the inbox`);
      assert.ok(fs.existsSync(path.join(dataRoot, 'tasks', 'archive', `${id}.json`)), `${id} archived`);
    }

    // Batch summary report written.
    const summary = fs.readFileSync(path.join(dataRoot, 'reports', 'b2.md'), 'utf8');
    assert.match(summary, /# Batch report — b2 \(archived\)/);
    assert.match(summary, /D1: done/);
    assert.match(summary, /## Follow-ups/);

    // Current batch is now empty — a new batch may start.
    assert.equal(core.currentBatch(repo), null, 'current batch cleared');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
