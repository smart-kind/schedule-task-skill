'use strict';
// agents.test.js — (d) claude/kimi profiles via fake CLI binaries, plus
// reset-time parsing. Port of runtime-self-test.sh section (d): the router's
// structured result replaces the bash stderr `session_id=`/`reset_epoch=` lines.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { invoke, parseResetEpoch } = require('../src/agents.js');
const { readConfig } = require('../src/core.js');

function fake(t, name, code) {
  const p = path.join(t, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${code}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function invokeArgs(over) {
  return {
    mode: 'fresh', model: 'opus', sessionId: null, prompt: 'hi',
    cwd: process.cwd(), attemptFile: path.join(over.t, 'stream.jsonl'),
    sentinel: '[[TASK_DONE t-x', config: readConfig(),
  };
}

test('(d) claude normal: rc 0, session id from the system event', async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'schedtask-agents-'));
  try {
    const bin = fake(t, 'fake-claude', `
      process.stdout.write('{"type":"system","session_id":"csess-1"}\\n{"type":"result","result":"ok"}\\n');
      process.exit(0);
    `);
    process.env.CLAUDE_BIN = bin;
    const r = await invoke({ agent: 'claude', ...invokeArgs({ t }) });
    assert.equal(r.rc, 0);
    assert.equal(r.sessionId, 'csess-1');
    assert.equal(r.resetEpoch, 0);
    assert.equal(r.sentinelHit, false);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('(d) claude limit: rc 75 overrides CLI rc, reset_epoch parsed, session kept', async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'schedtask-agents-'));
  try {
    const epoch = Math.floor(Date.now() / 1000) + 3600;
    const bin = fake(t, 'fake-claude-limit', `
      process.stdout.write('{"type":"system","session_id":"csess-2"}\\n');
      process.stdout.write('You hit your usage limit; resets at ${epoch}\\n');
      process.exit(1);
    `);
    process.env.CLAUDE_BIN = bin;
    const r = await invoke({ agent: 'claude', mode: 'resume', model: 'opus', sessionId: 'csess-2', prompt: 'continue', cwd: process.cwd(), attemptFile: path.join(t, 's2.jsonl'), sentinel: null, config: readConfig() });
    assert.equal(r.rc, 75, 'CLI rc=1 overridden to the limit contract');
    assert.equal(r.resetEpoch, epoch);
    assert.equal(r.sessionId, 'csess-2');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('(d) kimi 429: rc 75, session id from the meta event, no reset_epoch', async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'schedtask-agents-'));
  try {
    const bin = fake(t, 'fake-kimi-limit', `
      process.stdout.write('{"type":"meta","session_id":"ksess-9","reason":"session.resume_hint"}\\n');
      process.stdout.write('{"type":"error","message":"APIProviderRateLimitError"}\\n');
      process.exit(1);
    `);
    process.env.KIMI_BIN = bin;
    const r = await invoke({ agent: 'kimi', mode: 'fresh', model: 'kimi-k2', sessionId: null, prompt: 'hi', cwd: process.cwd(), attemptFile: path.join(t, 's3.jsonl'), sentinel: null, config: readConfig() });
    assert.equal(r.rc, 75);
    assert.equal(r.sessionId, 'ksess-9');
    assert.equal(r.resetEpoch, 0, 'kimi never parses a reset time');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('(d) kimi normal: rc 0', async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'schedtask-agents-'));
  try {
    const bin = fake(t, 'fake-kimi-ok', `
      process.stdout.write('{"type":"meta","session_id":"ksess-1","reason":"session.resume_hint"}\\n{"type":"result","result":"ok"}\\n');
      process.exit(0);
    `);
    process.env.KIMI_BIN = bin;
    const r = await invoke({ agent: 'kimi', mode: 'resume', model: 'kimi-k2', sessionId: 'ksess-1', prompt: 'continue', cwd: process.cwd(), attemptFile: path.join(t, 's4.jsonl'), sentinel: null, config: readConfig() });
    assert.equal(r.rc, 0);
    assert.equal(r.sessionId, 'ksess-1');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('reset-time parsing: 10-digit epoch and "resets 11am (UTC)" clock phrase', () => {
  const now = Math.floor(Date.now() / 1000);
  const future = now + 3600;
  assert.equal(parseResetEpoch(`resets at ${future}`, now), future);
  assert.equal(parseResetEpoch('no limit here', now), 0);
  const ep = parseResetEpoch('usage limit; resets 11am (UTC)', now);
  assert.ok(ep > now && ep < now + 700000, 'clock phrase resolves to a near-future UTC instant');
  assert.equal(new Date(ep * 1000).getUTCHours(), 11);
});
