'use strict';
// log.js — `schedule-task log <id> [-f]`: tail a task's run log (the worker-local
// stream that used to be watched via `tmux attach`). -f follows appended lines.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.js');

const DEFAULT_TAIL = 50;

function tailLog({ repo, id, follow, config }) {
  const logFile = path.join(core.logRoot(repo, config), id, 'run.log');
  if (!fs.existsSync(logFile)) {
    console.error(`log: no run log for ${id} — expected ${logFile}`);
    return 1;
  }
  const all = fs.readFileSync(logFile, 'utf8').split('\n');
  const head = all.slice(-DEFAULT_TAIL).join('\n');
  process.stdout.write(head.endsWith('\n') || head === '' ? head : `${head}\n`);
  if (!follow) return 0;

  let offset = Buffer.byteLength(all.join('\n')) + (all.length ? 1 : 0);
  const watcher = fs.watch(logFile, () => {
    try {
      const fd = fs.openSync(logFile, 'r');
      const stat = fs.fstatSync(fd);
      if (stat.size > offset) {
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        process.stdout.write(buf.toString('utf8'));
        offset = stat.size;
      }
      fs.closeSync(fd);
    } catch {
      /* file vanished mid-watch */
    }
  });
  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });
  return undefined; // keep the process alive until interrupted
}

module.exports = { tailLog };
