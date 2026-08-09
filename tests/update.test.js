'use strict';
// update.test.js — `schedule-task update` must really refresh the skill: it
// pulls the source recorded in .installed-from and re-copies every platform's
// skill dir (not just print a hint). End-to-end against a temp git source and
// a temp HOME with installed copies.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');

// A minimal but real skill source repo (the actual bin/src/tests/SKILL.md/
// install.sh from the dev tree), committed on `main`. No remote on purpose:
// update must work from a plain local source.
function makeSkillSource(t) {
  const src = path.join(t, 'skill-src');
  fs.mkdirSync(src, { recursive: true });
  h.git(src, ['init', '-q', '-b', 'main']);
  h.git(src, ['config', 'user.email', 'test@example.com']);
  h.git(src, ['config', 'user.name', 'test']);
  for (const p of ['bin', 'src', 'tests', 'package.json', 'SKILL.md', 'install.sh']) {
    fs.cpSync(path.join(__dirname, '..', p), path.join(src, p), { recursive: true });
  }
  setVersion(src, '9.9.9'); // stages + commits v9.9.9
  return src;
}

function setVersion(src, version) {
  const pkgPath = path.join(src, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
  h.git(src, ['add', '-A']);
  h.git(src, ['commit', '-qm', `v${version}`]);
}

// Simulate an installed copy of the source at <home>/<platform>/skills/schedule-task
// (as install.sh leaves it: .git stripped, .installed-from stamped).
function installCopy(src, home, platform) {
  const dest = path.join(home, platform, 'skills', 'schedule-task');
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dest, '.installed-from'), src, 'utf8');
  return dest;
}

function runUpdate(home, copy, npmPrefix) {
  return spawnSync(process.execPath, [path.join(copy, 'bin', 'schedule-task.js'), 'update'], {
    // npm_config_prefix routes `npm install -g` (the tool layer) into a temp
    // prefix so the test never touches the real machine's global packages.
    env: { ...process.env, HOME: home, npm_config_prefix: npmPrefix },
    encoding: 'utf8',
    cwd: os.tmpdir(), // deliberately not inside the source
    timeout: 120000,
  });
}

test('update refreshes the running copy to the latest source version', () => {
  const t = h.tmpdir('schedtask-update-');
  try {
    const src = makeSkillSource(t);
    const home = path.join(t, 'home');
    const copy = installCopy(src, home, '.agents');
    setVersion(src, '9.9.10'); // the source moves on
    const npmPrefix = path.join(t, 'npm-prefix');

    const r = runUpdate(home, copy, npmPrefix);
    assert.equal(r.status, 0, r.stderr);

    const pkg = JSON.parse(fs.readFileSync(path.join(copy, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '9.9.10'); // the running copy itself was replaced
    assert.equal(fs.existsSync(path.join(copy, '.git')), false); // still a clean copy
    assert.equal(fs.existsSync(path.join(copy, '.installed-from')), true); // still marked
    // Tool layer: the global CLI was refreshed into the temp npm prefix.
    const gpkg = JSON.parse(fs.readFileSync(path.join(npmPrefix, 'lib', 'node_modules', 'schedule-task', 'package.json'), 'utf8'));
    assert.equal(gpkg.version, '9.9.10', 'global CLI refreshed via npm install -g');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('update (re)installs into every detected platform on the machine', () => {
  const t = h.tmpdir('schedtask-update-');
  try {
    const src = makeSkillSource(t);
    const home = path.join(t, 'home');
    installCopy(src, home, '.agents'); // existing copy — refreshed in place
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); // detected, no copy yet
    setVersion(src, '9.9.11');
    const npmPrefix = path.join(t, 'npm-prefix');

    const r = runUpdate(home, path.join(home, '.agents', 'skills', 'schedule-task'), npmPrefix);
    assert.equal(r.status, 0, r.stderr);

    for (const plat of ['.agents', '.claude']) {
      const pkg = JSON.parse(fs.readFileSync(path.join(home, plat, 'skills', 'schedule-task', 'package.json'), 'utf8'));
      assert.equal(pkg.version, '9.9.11', `${plat} copy updated`);
    }
    const gpkg = JSON.parse(fs.readFileSync(path.join(npmPrefix, 'lib', 'node_modules', 'schedule-task', 'package.json'), 'utf8'));
    assert.equal(gpkg.version, '9.9.11', 'global CLI refreshed on re-install');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
