'use strict';
// install.test.js — `schedule-task install` binds the KNOWLEDGE layer into an
// agent: it copies SKILL.md/references/templates (zero code) from the global
// CLI package into each chosen platform's skills/schedule-task and stamps
// `.installed-from`. Whole-dir overwrite makes it idempotent and cleans up
// old-form code residue (bin/src/tests/package.json/install.sh from previous
// install schemes).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { install, parseTargets } = require('../src/install.js');
const h = require('./helpers.js');

const { version } = require('../package.json');
const PLATS = ['.kimi-code', '.claude', '.agents'];

function withHome(home, fn) {
  const orig = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    process.env.HOME = orig;
  }
}

function bindDest(home, plat) {
  return path.join(home, plat, 'skills', 'schedule-task');
}

test('parseTargets: all/auto = detected, none = nothing, list = exactly those, unknown rejected', () => {
  assert.deepEqual(parseTargets('all', ['claude']), ['claude']);
  assert.deepEqual(parseTargets('auto', ['kimi-code', 'agents']), ['kimi-code', 'agents']);
  assert.deepEqual(parseTargets('', ['claude']), ['claude']);
  assert.deepEqual(parseTargets('none', ['claude']), []);
  assert.deepEqual(parseTargets('kimi-code, claude, claude', ['agents']), ['kimi-code', 'claude']);
  assert.equal(parseTargets('bogus', []), null);
  assert.equal(parseTargets('all,claude', ['agents']), null); // mixed list + keyword is invalid
});

test('install --target <plats> binds the knowledge three (zero code) into each chosen platform', async () => {
  const t = h.tmpdir('schedtask-install-');
  try {
    const home = path.join(t, 'home');
    for (const plat of PLATS) fs.mkdirSync(path.join(home, plat), { recursive: true });
    const code = await withHome(home, () => install({ targets: 'kimi-code,claude,agents', yes: true }));
    assert.equal(code, 0);

    for (const plat of PLATS) {
      const dest = bindDest(home, plat);
      for (const item of ['SKILL.md', 'references', 'templates']) {
        assert.equal(fs.existsSync(path.join(dest, item)), true, `${plat} must have ${item}`);
      }
      for (const no of ['bin', 'src', 'tests', 'package.json', 'install.sh', '.git', 'docs']) {
        assert.equal(fs.existsSync(path.join(dest, no)), false, `${plat} must NOT contain ${no}`);
      }
      const marker = fs.readFileSync(path.join(dest, '.installed-from'), 'utf8');
      assert.match(marker, new RegExp(version), `${plat} marker records the source CLI version`);
      assert.match(marker, /\d{4}-\d{2}-\d{2}T/, `${plat} marker records the install time`);
    }
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('re-running install overwrites the whole dir and cleans old-form code residue', async () => {
  const t = h.tmpdir('schedtask-install-');
  try {
    const home = path.join(t, 'home');
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    // An old-form full copy (contains bin/src/tests/package.json) from a
    // previous install scheme.
    const dest = bindDest(home, '.agents');
    fs.mkdirSync(path.join(dest, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'bin', 'schedule-task.js'), 'old-code', 'utf8');
    fs.mkdirSync(path.join(dest, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dest, 'SKILL.md'), 'old', 'utf8');

    await withHome(home, () => install({ targets: 'agents', yes: true }));
    for (const no of ['bin', 'src', 'tests', 'package.json', 'install.sh']) {
      assert.equal(fs.existsSync(path.join(dest, no)), false, `residue ${no} must be cleaned`);
    }
    assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8').length > 100, true, 'SKILL.md refreshed from the package');
    assert.equal(fs.existsSync(path.join(dest, '.installed-from')), true);

    // Idempotent: a second run succeeds and leaves the same shape.
    const code2 = await withHome(home, () => install({ targets: 'agents', yes: true }));
    assert.equal(code2, 0);
    assert.equal(fs.existsSync(path.join(dest, 'bin')), false);
    assert.equal(fs.existsSync(path.join(dest, 'SKILL.md')), true);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('install --target <plat> creates a missing platform home (explicit request), auto skips undetected', async () => {
  const t = h.tmpdir('schedtask-install-');
  try {
    const home = path.join(t, 'home');
    // No platform dirs at all → auto binds nothing.
    let code = await withHome(home, () => install({ targets: 'all', yes: true }));
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'schedule-task')), false);

    // Explicit target creates the home + skills dirs.
    code = await withHome(home, () => install({ targets: 'claude', yes: true }));
    assert.equal(code, 0);
    assert.equal(fs.existsSync(bindDest(home, '.claude')), true);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
