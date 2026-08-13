#!/usr/bin/env node
// schedule-task — single CLI for the whole automation runtime.
// Thin launcher: arg parsing and sub-command dispatch live in src/cli.js.
//
// Preload every src module BEFORE dispatching. Node's `require` is runtime:
// a module file is read from disk on its first require, so an install.sh that
// replaces files mid-run could otherwise mix old and new code inside one live
// process. Preloading pins the whole CLI image into the require cache at
// startup — after that, disk changes cannot affect a running task.
'use strict';

require('../src/agents.js');
require('../src/archive.js');
require('../src/cancel.js');
require('../src/cli.js');
require('../src/core.js');
require('../src/dispatch.js');
require('../src/doctor.js');
require('../src/git.js');
require('../src/init.js');
require('../src/install.js');
require('../src/log.js');
require('../src/migrate.js');
require('../src/profile.js');
require('../src/runner.js');
require('../src/status.js');
require('../src/watchdog.js');

const { main } = require('../src/cli.js');

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    // Top-level safety net: never exit silently on an unexpected throw.
    console.error(`schedule-task: fatal: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  }
);
