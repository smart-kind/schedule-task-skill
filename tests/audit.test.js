'use strict';
// audit.test.js — the author-side `audit` command: creates audit task(s) for the
// current batch's dev-done work, with the OPPOSITE agent, from audit-harness.md,
// and refreshes the repo's template copies. Per-task (default) vs --batch.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('./helpers.js');
const { audit } = require('../src/audit.js');

// Repo whose current batch b2 has D1 (dev-done, agent claude) and D2 (pending).
function makeBatchRepo(t) {
  const { repo } = helpers.makeRepo(t, 'repo-au');
  helpers.addTask(repo, { id: 'D1', batch: 'b2', branch: 'automation/D1', agent: 'claude' }, 'prompt D1');
  helpers.addTask(repo, { id: 'D2', batch: 'b2', branch: 'automation/D2' }, 'prompt D2');
  const dataRoot = helpers.dataRoot(repo);
  fs.mkdirSync(path.join(dataRoot, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'reports', 'D1.md'), '# Report — D1 (dev-done)\n- Attempts: 1\n- Finished: now\n', 'utf8');
  fs.mkdirSync(path.join(dataRoot, 'batches'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'batches', 'b2.json'),
    JSON.stringify({ id: 'b2', title: 'batch two', notes: '', tasks: ['D1', 'D2'], merge_target: 'dev' }));
  helpers.git(repo, ['add', '-A']);
  helpers.git(repo, ['commit', '-qm', 'batch b2']);
  helpers.git(repo, ['push', '-q', 'origin', 'dev']);
  return repo;
}

test('audit: creates one audit task per dev-done member, opposite agent, and refreshes templates', () => {
  const t = helpers.tmpdir();
  try {
    const repo = makeBatchRepo(t); // D1 dev-done, D2 pending
    const r = audit({ repo, mode: 'edit', perTask: true });
    assert.equal(r.exit, 0);

    const dataRoot = helpers.dataRoot(repo);
    // One audit task for D1 (per-task), not for the pending D2.
    const audits = fs.readdirSync(path.join(dataRoot, 'tasks'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dataRoot, 'tasks', f), 'utf8')))
      .filter((e) => e.type === 'audit');
    assert.equal(audits.length, 1, 'one audit envelope created');
    const env = audits[0];
    assert.equal(env.type, 'audit');
    assert.equal(env.agent, 'kimi', 'opposite of the dev agent (claude)');
    assert.deepEqual(env.depends_on, ['D1']);
    assert.equal(env.batch, 'b2');
    assert.match(env.id, /^T\d{6}-audit-/);

    // Prompt from audit-harness with mode + scope filled.
    const prompt = fs.readFileSync(path.join(repo, env.prompt_file), 'utf8');
    assert.match(prompt, /Audit —/);
    assert.match(prompt, /mode=edit|\(audit-fail\)|audit-pass/);
    assert.match(prompt, /D1/);

    // Templates refreshed into the repo (prompts reference them).
    assert.ok(fs.existsSync(path.join(dataRoot, 'templates', 'harness-common.md')), 'common template copied');
    assert.ok(fs.existsSync(path.join(dataRoot, 'templates', 'audit-harness.md')), 'audit template copied');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('audit --batch: one audit task covering all dev-done members', () => {
  const t = helpers.tmpdir();
  try {
    const repo = makeBatchRepo(t);
    const r = audit({ repo, mode: 'readonly', perTask: false });
    assert.equal(r.exit, 0);

    const dataRoot = helpers.dataRoot(repo);
    const audits = fs.readdirSync(path.join(dataRoot, 'tasks'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dataRoot, 'tasks', f), 'utf8')))
      .filter((e) => e.type === 'audit');
    assert.equal(audits.length, 1, 'one batch-wide audit envelope');
    const env = audits[0];
    assert.deepEqual(env.depends_on, ['D1']);
    assert.match(env.agent, /claude|kimi/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('audit: refuses when no dev-done member exists', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-au-none');
    helpers.addTask(repo, { id: 'X', batch: 'b3', branch: 'automation/X' }, 'prompt X');
    const dataRoot = helpers.dataRoot(repo);
    fs.mkdirSync(path.join(dataRoot, 'batches'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'batches', 'b3.json'),
      JSON.stringify({ id: 'b3', title: '', notes: '', tasks: ['X'], merge_target: 'dev' }));
    helpers.git(repo, ['add', '-A']);
    helpers.git(repo, ['commit', '-qm', 'batch b3']);
    helpers.git(repo, ['push', '-q', 'origin', 'dev']);

    const r = audit({ repo, mode: 'edit', perTask: true });
    assert.equal(r.exit, 1, 'no dev-done work to audit');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
