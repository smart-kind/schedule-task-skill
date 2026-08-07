'use strict';
// merge-batch.test.js — (f) author-side batch finalization against a mock remote.
// Port of runtime-self-test.sh (f): T1/T2 carry a (done) report on their branches,
// T3 has none — T3 must be skipped, the rest merged onto dev and pushed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const helpers = require('./helpers.js');
const { mergeBatch } = require('../src/merge-batch.js');

test('(f) merge-batch lands done branches, skips unreported, pushes', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-f');
    for (const x of ['T1', 'T2', 'T3']) {
      helpers.git(repo, ['checkout', '-qb', `automation/${x}`, 'dev']);
      fs.writeFileSync(path.join(repo, `file-${x}.txt`), `${x}\n`);
      if (x !== 'T3') {
        const rep = path.join(helpers.dataRoot(repo), 'reports', `${x}.md`);
        fs.mkdirSync(path.dirname(rep), { recursive: true });
        fs.writeFileSync(rep, `# Report — ${x} (done)\n- Attempts: 1\n- Finished: now\n`, 'utf8');
      }
      helpers.git(repo, ['add', '-A']);
      helpers.git(repo, ['commit', '-qm', `task ${x}`]);
      helpers.git(repo, ['push', '-q', 'origin', `automation/${x}`]);
    }
    helpers.git(repo, ['checkout', '-q', 'dev']);
    const tasksDir = path.join(helpers.dataRoot(repo), 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    for (const x of ['T1', 'T2', 'T3']) {
      fs.writeFileSync(path.join(tasksDir, `${x}.json`),
        `${JSON.stringify({ id: x, batch: 'b1', branch: `automation/${x}`, prompt_file: `.schedule-tasks-data/prompts/${x}.md` })}\n`, 'utf8');
    }
    const batchesDir = path.join(helpers.dataRoot(repo), 'batches');
    fs.mkdirSync(batchesDir, { recursive: true });
    fs.writeFileSync(path.join(batchesDir, 'b1.json'),
      JSON.stringify({ id: 'b1', title: 'merge batch', notes: '', tasks: ['T1', 'T2', 'T3'], merge_target: 'dev' }));
    helpers.git(repo, ['add', '-A']);
    helpers.git(repo, ['commit', '-qm', 'merge fixtures']);
    helpers.git(repo, ['push', '-q', 'origin', 'dev']);

    const r = mergeBatch({ repo, batchId: 'b1' });
    assert.equal(r.exit, 0);
    assert.equal(fs.existsSync(path.join(repo, 'file-T1.txt')), true, 'T1 branch landed on dev');
    assert.equal(fs.existsSync(path.join(repo, 'file-T2.txt')), true, 'T2 branch landed on dev');
    assert.equal(fs.existsSync(path.join(repo, 'file-T3.txt')), false, 'T3 not landed (no done report)');

    helpers.git(repo, ['fetch', '-q', 'origin']);
    execFileSync('git', ['show', 'origin/dev:file-T1.txt'], { cwd: repo, stdio: 'pipe' });
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
