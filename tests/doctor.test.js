'use strict';
// doctor.test.js — `schedule-task doctor` must detect old-scheme leftovers
// (a schedule-task binary on PATH that is not this skill's own copy: the npm
// global install or the ~/.local/bin symlink) and advise removal — without
// touching them.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');

const CLI = path.join(__dirname, '..', 'bin', 'schedule-task.js');

function runDoctor(env) {
  const repo = path.join(h.tmpdir('schedtask-doctor-repo-'), 'repo');
  fs.mkdirSync(repo, { recursive: true });
  return spawnSync(process.execPath, [CLI, 'doctor', '-r', repo], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('doctor flags a ~/.local/bin/schedule-task symlink leftover and tells how to remove it', () => {
  const t = h.tmpdir('schedtask-doctor-');
  try {
    const homeBin = path.join(t, 'home', '.local', 'bin');
    fs.mkdirSync(homeBin, { recursive: true });
    fs.writeFileSync(path.join(homeBin, 'schedule-task'), '#!/bin/sh\necho stub\n', 'utf8');
    fs.chmodSync(path.join(homeBin, 'schedule-task'), 0o755);
    const r = runDoctor({ HOME: path.join(t, 'home'), PATH: `${homeBin}:${process.env.PATH}` });
    assert.match(r.stdout, /leftover/);
    assert.match(r.stdout, /\.local\/bin\/schedule-task/);
    assert.match(r.stdout, /rm /); // advises manual removal
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('doctor accepts an npm-global schedule-task as the runtime (not a leftover)', () => {
  const t = h.tmpdir('schedtask-doctor-');
  try {
    // Mimic npm's global layout: <prefix>/bin/schedule-task -> <prefix>/lib/node_modules/schedule-task/bin/schedule-task.js
    const pfx = path.join(t, 'npm-prefix');
    const pkgDir = path.join(pfx, 'lib', 'node_modules', 'schedule-task');
    const real = path.join(pkgDir, 'bin', 'schedule-task.js');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '#!/usr/bin/env node\nconsole.log("stub");\n', 'utf8');
    fs.chmodSync(real, 0o755);
    // A real package.json matching the skill copy, so the version check passes.
    const { version } = require('../package.json');
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version }), 'utf8');
    fs.mkdirSync(path.join(pfx, 'bin'), { recursive: true });
    fs.symlinkSync(real, path.join(pfx, 'bin', 'schedule-task'));
    const r = runDoctor({ PATH: `${path.join(pfx, 'bin')}:${process.env.PATH}` });
    assert.match(r.stdout, /npm global/);
    assert.doesNotMatch(r.stdout, /leftover/);
    assert.doesNotMatch(r.stdout, /npm uninstall -g/); // the global install is the runtime now
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('doctor flags a stale npm-global CLI whose version does not match the skill copy', () => {
  const t = h.tmpdir('schedtask-doctor-');
  try {
    const pfx = path.join(t, 'npm-prefix');
    const pkgDir = path.join(pfx, 'lib', 'node_modules', 'schedule-task');
    const real = path.join(pkgDir, 'bin', 'schedule-task.js');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '#!/usr/bin/env node\nconsole.log("stub");\n', 'utf8');
    fs.chmodSync(real, 0o755);
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '0.0.1' }), 'utf8');
    fs.mkdirSync(path.join(pfx, 'bin'), { recursive: true });
    fs.symlinkSync(real, path.join(pfx, 'bin', 'schedule-task'));
    const r = runDoctor({ PATH: `${path.join(pfx, 'bin')}:${process.env.PATH}` });
    assert.match(r.stdout, /does not match/);
    assert.match(r.stdout, /re-run install\.sh/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test("doctor does not flag this skill's own copy when it is on PATH", () => {
  // A user who put this skill's CLI on PATH (symlink named `schedule-task`
  // pointing at the copy's bin/schedule-task.js) is not a leftover.
  const t = h.tmpdir('schedtask-doctor-');
  try {
    const myBin = path.join(t, 'my-bin');
    fs.mkdirSync(myBin, { recursive: true });
    fs.symlinkSync(path.join(__dirname, '..', 'bin', 'schedule-task.js'), path.join(myBin, 'schedule-task'));
    const r = runDoctor({ PATH: `${myBin}:${path.dirname(process.execPath)}:/usr/bin:/bin` });
    assert.doesNotMatch(r.stdout, /leftover/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('doctor flags old-form code residue in a bound skill dir and hints to re-run install', () => {
  // A bound skill dir holding bin/src/package.json is an old-form full copy
  // (previous install scheme) — `schedule-task install` whole-dir overwrite
  // cleans it; doctor must flag it.
  const t = h.tmpdir('schedtask-doctor-');
  try {
    const home = path.join(t, 'home');
    const dest = path.join(home, '.agents', 'skills', 'schedule-task');
    fs.mkdirSync(path.join(dest, 'references'), { recursive: true });
    fs.mkdirSync(path.join(dest, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'SKILL.md'), '# skill\n', 'utf8');
    // The knowledge three are complete, but bin/ + package.json are residue
    // from an old-form full copy.
    fs.mkdirSync(path.join(dest, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'bin', 'schedule-task.js'), 'old-code', 'utf8');
    fs.writeFileSync(path.join(dest, 'package.json'), '{}', 'utf8');
    const r = runDoctor({ HOME: home });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /code residue: bin, package\.json/);
    assert.match(r.stdout, /old-form code residue — re-run `schedule-task install`/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('doctor accepts a clean bound skill dir (knowledge three, no code)', () => {
  const t = h.tmpdir('schedtask-doctor-');
  try {
    const home = path.join(t, 'home');
    const dest = path.join(home, '.agents', 'skills', 'schedule-task');
    fs.mkdirSync(path.join(dest, 'references'), { recursive: true });
    fs.mkdirSync(path.join(dest, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'SKILL.md'), '# skill\n', 'utf8');
    const r = runDoctor({ HOME: home });
    assert.match(r.stdout, /knowledge three, no code/);
    assert.doesNotMatch(r.stdout, /code residue/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
