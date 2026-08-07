'use strict';
// watchdog.test.js — start/status/tick/stop lifecycle of the常驻看门狗.
// Spawns a real detached daemon (interval 1s), watches it tick, then stops it.
// Covers: start writes pid + status file, first tick runs immediately, status
// reports running, duplicate start refused, stop kills it, status reports
// stopped, repeated stop is a no-op.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('./helpers.js');
const core = require('../src/core.js');
const { readConfig } = require('../src/core.js');
const watchdog = require('../src/watchdog.js');

test('watchdog: start → tick → status → duplicate-start refused → stop → stopped', async () => {
  const t = helpers.tmpdir();
  let daemonPid = 0;
  try {
    const { repo } = helpers.makeRepo(t, 'repo-w');
    const stateDir = core.stateDir(repo);
    fs.mkdirSync(stateDir, { recursive: true });
    core.writeMachine(stateDir, 'worker', 'w1'); // ticks actually dispatch
    process.env.FL_LOG_ROOT = path.join(t, 'logroot-w');
    const config = readConfig();

    // start
    const s = await watchdog.start({ repo, config, interval: 1 });
    assert.equal(s.exit, 0);
    daemonPid = watchdog.readPid(stateDir);
    assert.ok(daemonPid > 0, 'pid file written');
    assert.ok(core.isAlive(daemonPid), 'daemon process alive');

    // status: running
    const st = await watchdog.status({ repo, config });
    assert.equal(st.exit, 0, 'status reports running (exit 0)');

    // let it tick (first tick is immediate; interval is 1s)
    await core.sleep(2300);
    const sfile = watchdog.readStatus(stateDir);
    assert.ok(sfile, 'status file written');
    assert.ok(sfile.ticks >= 1, `daemon ticked at least once (ticks=${sfile.ticks})`);
    assert.ok(sfile.lastCheckAt, 'last check timestamp recorded');
    assert.ok(fs.existsSync(path.join(core.logRoot(repo, config), 'watchdog.log')), 'watchdog.log written');

    // duplicate start refused
    const s2 = await watchdog.start({ repo, config, interval: 1 });
    assert.equal(s2.exit, 1, 'duplicate start refused');

    // stop
    const stp = await watchdog.stop({ repo, config });
    assert.equal(stp.exit, 0);
    await core.sleep(300);
    assert.equal(core.isAlive(daemonPid), false, 'daemon process terminated');
    assert.equal(watchdog.readPid(stateDir), 0, 'pid file cleared');
    daemonPid = 0;

    // status: stopped
    const st2 = await watchdog.status({ repo, config });
    assert.equal(st2.exit, 1, 'status reports stopped (exit 1)');

    // repeated stop is a no-op
    const stp2 = await watchdog.stop({ repo, config });
    assert.equal(stp2.exit, 0, 'repeated stop is a no-op');
  } finally {
    if (daemonPid && core.isAlive(daemonPid)) core.killTree(daemonPid, 'SIGKILL');
    fs.rmSync(t, { recursive: true, force: true });
  }
});
