'use strict';
// cli.test.js — arg parsing sanity.

const { test } = require('node:test');
const assert = require('node:assert');
const { parseArgs } = require('../src/cli.js');

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
