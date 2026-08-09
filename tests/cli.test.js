'use strict';
// cli.test.js — arg parsing sanity + the v3 command-surface gates
// (bare invocation = status; `dev` refuses while a batch is open).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, main } = require('../src/cli.js');
const helpers = require('./helpers.js');

test('parseArgs: repo flag, command, positional args, boolean flags', () => {
  const p = parseArgs(['--repo', '/tmp/x', 'run', 'T260805-01-formation', '--self-test']);
  assert.equal(p.repo, '/tmp/x');
  assert.equal(p.command, 'run');
  assert.deepEqual(p.args, ['T260805-01-formation']);
  assert.equal(p.flags['--self-test'], true);
});

test('parseArgs: --key=value form and cancel reason words', () => {
  const p = parseArgs(['cancel', 'T1', 'no', 'longer', 'needed']);
  assert.equal(p.command, 'cancel');
  assert.deepEqual(p.args, ['T1', 'no', 'longer', 'needed']);
  const q = parseArgs(['init', '--role=worker', '--id=vps-01']);
  assert.equal(q.flags['--role'], 'worker');
  assert.equal(q.flags['--id'], 'vps-01');
});

test('bare invocation = status (the most frequent action), not usage', async () => {
  const out = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try {
    const code = await main([]);
    assert.equal(code, 0);
  } finally {
    process.stdout.write = orig;
  }
  const text = out.join('');
  assert.match(text, /schedule-task status/);
  assert.doesNotMatch(text, /^Usage:/);
});

test('help prints the command list', async () => {
  const out = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try {
    const code = await main(['help']);
    assert.equal(code, 0);
  } finally {
    process.stdout.write = orig;
  }
  const text = out.join('');
  assert.match(text, /Usage: schedule-task/);
  assert.match(text, /audit/);
  assert.doesNotMatch(text, /merge-batch/);
});

test('dev refuses to open a new batch while one is open', async () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-devgate');
    const dataRoot = helpers.dataRoot(repo);
    fs.mkdirSync(path.join(dataRoot, 'batches'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'batches', 'b1.json'),
      JSON.stringify({ id: 'b1', title: '', notes: '', tasks: ['T1'], merge_target: 'dev' }));
    helpers.git(repo, ['add', '-A']);
    helpers.git(repo, ['commit', '-qm', 'batch b1']);
    helpers.git(repo, ['push', '-q', 'origin', 'dev']);

    const errs = [];
    const origErr = process.stderr.write;
    process.stderr.write = (s) => { errs.push(String(s)); return true; };
    let code;
    try {
      code = await main(['dev', '-r', repo]);
    } finally {
      process.stderr.write = origErr;
    }
    assert.equal(code, 1, 'refused while batch b1 is open');
    assert.match(errs.join(''), /current batch b1 is still open/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
