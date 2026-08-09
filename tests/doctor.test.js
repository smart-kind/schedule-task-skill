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

test('doctor flags an npm-global schedule-task leftover and advises npm uninstall -g', () => {
  const t = h.tmpdir('schedtask-doctor-');
  try {
    // Mimic npm's global layout: <prefix>/bin/schedule-task -> <prefix>/lib/node_modules/schedule-task/bin/schedule-task.js
    const pfx = path.join(t, 'npm-prefix');
    const real = path.join(pfx, 'lib', 'node_modules', 'schedule-task', 'bin', 'schedule-task.js');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '#!/usr/bin/env node\nconsole.log("stub");\n', 'utf8');
    fs.chmodSync(real, 0o755);
    fs.mkdirSync(path.join(pfx, 'bin'), { recursive: true });
    fs.symlinkSync(real, path.join(pfx, 'bin', 'schedule-task'));
    const r = runDoctor({ PATH: `${path.join(pfx, 'bin')}:${process.env.PATH}` });
    assert.match(r.stdout, /leftover/);
    assert.match(r.stdout, /npm uninstall -g schedule-task/);
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
