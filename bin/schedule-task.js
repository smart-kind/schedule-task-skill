#!/usr/bin/env node
// schedule-task — single CLI for the whole automation runtime.
// Thin launcher: arg parsing and sub-command dispatch live in src/cli.js.
'use strict';

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
