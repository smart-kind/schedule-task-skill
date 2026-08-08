'use strict';
// cli.js — command table and arg parsing for the schedule-task CLI.
// One binary, every runtime concern: init / status / dispatch / run / cancel /
// archive / merge-batch / log / doctor / update / self-test.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('./core.js');

const VALUE_FLAGS = new Set(['--repo', '-r', '--role', '--id', '--interval']);

function parseArgs(argv) {
  const out = { repo: null, command: null, args: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      if (a === '--repo' || a === '-r') out.repo = v;
      else out.flags[a] = v;
      i += 1;
    } else if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      out.flags[a.slice(0, eq)] = a.slice(eq + 1);
    } else if (a.startsWith('-')) {
      out.flags[a] = true;
    } else if (!out.command) {
      out.command = a;
    } else {
      out.args.push(a);
    }
  }
  return out;
}

const USAGE = `schedule-task — scheduled, resumable automation tasks. Git is the only transport.

Usage: schedule-task <command> [options] [args...]

Commands:
  init [--role author|worker] [--id <mid>] [--yes]
      Install the runtime into the current repo: create .schedule-tasks-data/,
      declare this machine's role+id, merge gitignore, check dependencies,
      print the worker watchdog command. Migrates an old automation/ data dir when found.
  status [--self-test]
      Read-only report of every scheduled task (worker = live state, author =
      inferred from committed reports on the task branches). Run git fetch first.
  watchdog start|stop|status [--interval <seconds>]
      看门狗（常驻，无需 cron）：start 拉起一个常驻进程，每 <interval> 秒
      （默认 300）检查一次到点任务并启动为后台执行器（并发上限
      FL_MAX_CONCURRENCY，默认 2）；stop 停止；status 查看存活与上次检查
      结果。仅 role=worker 的机器会开工；看门狗绝不合并。
  run <id>
      Resilient per-task runner (spawned detached by the watchdog; also run by
      hand): worktree isolation, CLI-session resume, usage-limit park,
      sentinel+commit verification, report + push.
  cancel <id>|--all [reason...]
      Cancel pending/running tasks; kills a running runner's process group.
      Cascades to tasks that depend on the cancelled id. Worker-local only.
  archive <id>
      Retire a finished (done/cancelled) task: move envelope + prompt to
      .schedule-tasks-data/{tasks,prompts}/archive/. Reports stay put.
  merge-batch <batch-id>
      AUTHOR-side batch finalization: land every done task branch onto the
      manifest's merge_target (default dev) in dependency order, then push.
  log <id> [-f]
      Tail a task's run log (replaces the old tmux attach).
  doctor
      Environment check: node/git/claude/kimi/graphify, machine identity, data dirs.
  update
      Pull the latest source of this skill installation (git pull in the repo
      the CLI ships from).
  self-test
      Run the full node:test suite (same as \`npm test\`).

Global options:
  -r, --repo <path>   repo to operate on (default: current directory)
  -h, --help          this help
      --version       print version

Environment seams (all optional):
  FL_MAX_CONCURRENCY  concurrent runners (default 2; 1 = fully serial)
  FL_INBOX            inbox branch (default dev)
  FL_WATCHDOG_INTERVAL  watchdog check interval in seconds (default 300; --interval wins)
  FL_MODE             force status mode: worker|author
  FL_AUTO_ROOT        status data-root override (self-test)
  FL_LOG_ROOT         worker run-state root override (self-test)
  CLAUDE_BIN/KIMI_BIN pin the executor CLI binaries (tests use mocks)
  LIMIT_MARGIN / LIMIT_FALLBACK / MAX_AMBIGUOUS / AMBIGUOUS_SLEEP / AMBIGUOUS_FRESH_AT
`;

async function main(argv) {
  core.pinEnv();
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`schedule-task: ${err.message}`);
    return 2;
  }
  const { command, repo: cliRepo, args, flags } = parsed;

  if (flags['--version']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(core.skillRoot(), 'package.json'), 'utf8'));
    console.log(pkg.version);
    return 0;
  }
  if (!command || flags['--help'] || flags['-h']) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  const repo = core.resolveRepo(cliRepo, process.cwd());
  const config = core.readConfig();

  switch (command) {
    case 'init': {
      const { init } = require('./init.js');
      return init({
        repo,
        roleArg: flags['--role'] || undefined,
        idArg: flags['--id'] || undefined,
        yes: Boolean(flags['--yes']),
      }).then((r) => r.exit);
    }
    case 'status': {
      const { render, selfTest, detectMode } = require('./status.js');
      if (flags['--self-test']) {
        return selfTest() ? 0 : 1;
      }
      const autoRoot = config.autoRoot || core.dataDir(repo);
      const logRoot = config.logRoot || core.logRoot(repo, config);
      const mode = config.mode || detectMode({ autoRoot, logRoot, mode: '' });
      process.stdout.write(`${render({ repo, autoRoot, logRoot, mode })}\n`);
      return 0;
    }
    case 'watchdog': {
      const { start, stop, status, run } = require('./watchdog.js');
      const sub = args[0];
      if (!sub) {
        console.error('usage: schedule-task watchdog start|stop|status [--interval <seconds>]');
        return 2;
      }
      const interval = Number(flags['--interval'] || process.env.FL_WATCHDOG_INTERVAL || 300);
      if (!Number.isInteger(interval) || interval <= 0) {
        console.error('watchdog: --interval must be a positive number of seconds');
        return 2;
      }
      switch (sub) {
        case 'start': return start({ repo, config, interval }).exit;
        case 'stop': return stop({ repo, config }).then((r) => r.exit);
        case 'status': return status({ repo, config }).exit;
        case 'run': return run({ repo, config, interval }); // daemon body — never returns
        default:
          console.error(`watchdog: unknown sub-command '${sub}' (want start|stop|status)`);
          return 2;
      }
    }
    case 'run': {
      const id = args[0];
      if (!id) {
        console.error('usage: schedule-task run <id>');
        return 2;
      }
      const { runOne } = require('./runner.js');
      const result = await runOne({ repo, id, config });
      return result.status === 'done' ? 0 : 1;
    }
    case 'cancel': {
      const { cancel } = require('./cancel.js');
      const target = args[0];
      if (!target || (target !== '--all' && target.startsWith('-'))) {
        console.error('usage: schedule-task cancel <id>|--all [reason...]');
        return 2;
      }
      const reason = args.slice(1).join(' ') || 'cancelled by user';
      const r = cancel({ repo, target, reason, config });
      return r.exit;
    }
    case 'archive': {
      const { archive } = require('./archive.js');
      const id = args[0];
      if (!id) {
        console.error('usage: schedule-task archive <id>');
        return 2;
      }
      return archive({ repo, id }).exit;
    }
    case 'merge-batch': {
      const { mergeBatch } = require('./merge-batch.js');
      const bid = args[0];
      if (!bid) {
        console.error('usage: schedule-task merge-batch <batch-id>');
        return 2;
      }
      return mergeBatch({ repo, batchId: bid }).exit;
    }
    case 'log': {
      const { tailLog } = require('./log.js');
      const id = args[0];
      if (!id) {
        console.error('usage: schedule-task log <id> [-f]');
        return 2;
      }
      return tailLog({ repo, id, follow: Boolean(flags['-f']), config });
    }
    case 'doctor': {
      const { doctor } = require('./doctor.js');
      return doctor({ repo });
    }
    case 'update': {
      const root = core.skillRoot();
      if (!fs.existsSync(path.join(root, '.git'))) {
        console.error(`update: ${root} is not a git repo; nothing to pull`);
        return 1;
      }
      console.log(`update: pulling latest skill source in ${root}`);
      const r = spawnSync('git', ['pull', 'origin', 'main'], { cwd: root, stdio: 'inherit' });
      return r.status === 0 ? 0 : 1;
    }
    case 'self-test': {
      const root = core.skillRoot();
      const r = spawnSync(process.execPath, ['--test'], { cwd: root, stdio: 'inherit' });
      return r.status === 0 ? 0 : 1;
    }
    default:
      console.error(`schedule-task: unknown command '${command}'`);
      process.stdout.write(USAGE);
      return 2;
  }
}

module.exports = { main, parseArgs, USAGE };
