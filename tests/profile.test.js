'use strict';
// profile.test.js — worker profile management (list / add / edit / remove).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('./helpers.js');
const core = require('../src/core.js');
const { profileList, profileAdd, profileEdit, profileRemove } = require('../src/profile.js');

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

test('profile: list shows "No workers configured" when workers.json is absent', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-profile-empty');
    const logs = capture(() => profileList({ repo }));
    assert.match(logs.join('\n'), /No workers configured/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('profile: add creates workers.json with auto-assigned id', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-profile-add');
    core.ensureDir(core.dataDir(repo));

    const r1 = profileAdd({ repo, name: 'kimi-130', agent: 'kimi' });
    assert.equal(r1.exit, 0);
    const workers = core.readWorkers(repo);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].id, 'W01');
    assert.equal(workers[0].name, 'kimi-130');
    assert.equal(workers[0].agent, 'kimi');

    const r2 = profileAdd({ repo, name: 'cc-opus', agent: 'cc' });
    assert.equal(r2.exit, 0);
    const workers2 = core.readWorkers(repo);
    assert.equal(workers2.length, 2);
    assert.equal(workers2[1].id, 'W02');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('profile: add rejects invalid agent', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-profile-bad-agent');
    core.ensureDir(core.dataDir(repo));
    const r = profileAdd({ repo, name: 'bad', agent: 'gpt' });
    assert.equal(r.exit, 1);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('profile: edit sets a stage model', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-profile-edit');
    core.ensureDir(core.dataDir(repo));
    profileAdd({ repo, name: 'w1', agent: 'kimi' });

    const r = profileEdit({ repo, workerId: 'W01', stage: 'dev', model: 'K3' });
    assert.equal(r.exit, 0);
    const w = core.findWorker(repo, 'W01');
    assert.equal(w.models.dev, 'K3');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('profile: edit rejects unknown stage', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-profile-bad-stage');
    core.ensureDir(core.dataDir(repo));
    profileAdd({ repo, name: 'w1', agent: 'kimi' });
    const r = profileEdit({ repo, workerId: 'W01', stage: 'deploy', model: 'x' });
    assert.equal(r.exit, 1);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('profile: edit rejects unknown worker id', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-profile-bad-wid');
    core.ensureDir(core.dataDir(repo));
    const r = profileEdit({ repo, workerId: 'W99', stage: 'dev', model: 'x' });
    assert.equal(r.exit, 1);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('profile: remove deletes a worker', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-profile-rm');
    core.ensureDir(core.dataDir(repo));
    profileAdd({ repo, name: 'w1', agent: 'kimi' });
    profileAdd({ repo, name: 'w2', agent: 'cc' });
    assert.equal(core.readWorkers(repo).length, 2);

    const r = profileRemove({ repo, workerId: 'W01' });
    assert.equal(r.exit, 0);
    assert.equal(core.readWorkers(repo).length, 1);
    assert.equal(core.findWorker(repo, 'W01'), null);
    assert.equal(core.readWorkers(repo)[0].name, 'w2');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('profile: list renders formatted table', () => {
  const t = helpers.tmpdir();
  try {
    const { repo } = helpers.makeRepo(t, 'repo-profile-list');
    core.ensureDir(core.dataDir(repo));
    profileAdd({ repo, name: 'kimi-130', agent: 'kimi' });
    profileEdit({ repo, workerId: 'W01', stage: 'dev', model: 'K3' });
    profileEdit({ repo, workerId: 'W01', stage: 'review', model: 'K3' });

    const logs = capture(() => profileList({ repo }));
    const out = logs.join('\n');
    assert.match(out, /W01/);
    assert.match(out, /kimi-130/);
    assert.match(out, /agent=kimi/);
    assert.match(out, /dev: K3/);
    assert.match(out, /review: K3/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
