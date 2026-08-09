'use strict';
// install-sh.test.js — install.sh installs ONLY the global CLI (tool layer).
// It must NOT create any agent skill dir (binding is `schedule-task install`'s
// job), the global install must be a real self-contained copy (not a symlink
// into the temp clone), the package must ship the knowledge three (the source
// `schedule-task install` copies from), and the temp clone must be cleaned up.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');

const INSTALL_SH = path.join(__dirname, '..', 'install.sh');
const PLATS = ['.kimi-code', '.claude', '.agents'];

// A minimal but real skill source repo (bin/src/tests/templates/references/
// SKILL.md/install.sh/package.json from the dev tree), committed on `main`.
// Passed to install.sh via SCHEDULE_TASK_REPO_URL so the script takes its
// clone-to-temp path without touching the network.
function makeSkillSource(t) {
  const src = path.join(t, 'skill-src');
  fs.mkdirSync(src, { recursive: true });
  h.git(src, ['init', '-q', '-b', 'main']);
  h.git(src, ['config', 'user.email', 'test@example.com']);
  h.git(src, ['config', 'user.name', 'test']);
  for (const p of ['bin', 'src', 'tests', 'templates', 'references', 'package.json', 'SKILL.md', 'install.sh']) {
    fs.cpSync(path.join(__dirname, '..', p), path.join(src, p), { recursive: true });
  }
  h.git(src, ['add', '-A']);
  h.git(src, ['commit', '-qm', 'init']);
  return src;
}

test('install.sh only installs the global CLI (no skill dirs, temp clone cleaned)', () => {
  const t = h.tmpdir('schedtask-installsh-');
  try {
    const src = makeSkillSource(t);
    const home = path.join(t, 'home');
    const tmp = path.join(t, 'tmp'); // install.sh mktemp -d lives under $TMPDIR
    const pfx = path.join(t, 'npm-prefix');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });

    // Run from a cwd that is NOT the source → exercises the curl|bash path.
    const r = spawnSync('bash', [INSTALL_SH], {
      cwd: t,
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: tmp,
        npm_config_prefix: pfx,
        SCHEDULE_TASK_REPO_URL: src,
      },
      encoding: 'utf8',
      timeout: 180000,
    });
    assert.equal(r.status, 0, `install.sh failed:\n${r.stdout}\n${r.stderr}`);

    // 1. The global CLI landed in the npm prefix as a REAL copy, not a symlink
    // to the temp clone (which is about to be deleted).
    const gpkg = path.join(pfx, 'lib', 'node_modules', 'schedule-task');
    assert.equal(fs.existsSync(path.join(gpkg, 'package.json')), true, 'global package installed');
    assert.equal(fs.lstatSync(gpkg).isSymbolicLink(), false, 'global install must be a self-contained copy, not a symlink');

    // 2. The global package ships the knowledge three — the source that
    // `schedule-task install` copies from.
    for (const item of ['SKILL.md', 'references', 'templates']) {
      assert.equal(fs.existsSync(path.join(gpkg, item)), true, `global package must ship ${item}`);
    }

    // 3. No agent skill dir was created anywhere under HOME.
    for (const plat of PLATS) {
      assert.equal(fs.existsSync(path.join(home, plat, 'skills', 'schedule-task')), false, `install.sh must not touch ${plat}/skills`);
    }

    // 4. The temp clone + tarball dir are cleaned up — nothing matching
    // mktemp's `tmp.*` pattern is left under $TMPDIR (Node's own
    // node-compile-cache may legitimately appear there — that is not ours).
    const leftovers = fs.readdirSync(tmp).filter((n) => n.startsWith('tmp.') || n.startsWith('schedule-task'));
    assert.deepEqual(leftovers, [], 'temp clone and tarball dir cleaned up');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('install.sh --dry-run changes nothing', () => {
  const t = h.tmpdir('schedtask-installsh-');
  try {
    const src = makeSkillSource(t);
    const home = path.join(t, 'home');
    const pfx = path.join(t, 'npm-prefix');
    fs.mkdirSync(home, { recursive: true });
    const r = spawnSync('bash', [INSTALL_SH, '--dry-run'], {
      cwd: t,
      env: { ...process.env, HOME: home, npm_config_prefix: pfx, SCHEDULE_TASK_REPO_URL: src },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry-run/);
    assert.equal(fs.existsSync(path.join(pfx, 'lib', 'node_modules', 'schedule-task')), false, 'dry-run must not install anything');
    for (const plat of PLATS) {
      assert.equal(fs.existsSync(path.join(home, plat, 'skills', 'schedule-task')), false, 'dry-run must not create skill dirs');
    }
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('install.sh rejects unknown flags', () => {
  const t = h.tmpdir('schedtask-installsh-');
  try {
    const r = spawnSync('bash', [INSTALL_SH, '--platform=all'], {
      cwd: t,
      env: { ...process.env, HOME: path.join(t, 'home') },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown option/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
