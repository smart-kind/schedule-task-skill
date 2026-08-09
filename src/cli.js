'use strict';
// cli.js — command table and arg parsing for the schedule-task CLI.
// One binary, every runtime concern: init / status / dev / audit / run / cancel /
// archive / log / doctor / install / self-test.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('./core.js');

const VALUE_FLAGS = new Set(['--repo', '-r', '--role', '--id', '--interval', '--target', '-t']);

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

Usage: schedule-task [command] [options] [args...]   (no command = status)

Commands:
  (default) / status [--self-test]
      Read-only report of every scheduled task (worker = live state, author =
      inferred from the reports merged to dev). Run git fetch first.
  dev
      Gate check for starting a NEW dev batch: refuses while a batch is still
      open (archive it first). The author's agent then runs the create flow:
      interview -> draft envelope + prompt (templates/dev-plan-harness.md) ->
      review -> commit to the inbox branch.
  audit [--readonly|--edit] [--per-task|--batch]
      AUTHOR-side: create audit task(s) for the current batch's dev-done work.
      Default --edit (may rewrite meaningless tests + write new ones),
      --readonly = review only. Default --per-task (one audit per dev task),
      --batch = one audit over the whole batch. The audit agent defaults to the
      OPPOSITE of the developer's agent (independent mind).
  init [--role author|worker] [--id <mid>] [--yes]
      Install the runtime into the current repo: create .schedule-tasks-data/,
      declare this machine's role+id, merge gitignore, check dependencies,
      print the worker watchdog command. Migrates an old automation/ data dir when found.
  watchdog start|stop|status [--interval <seconds>]
      看门狗（常驻，无需 cron）：start 拉起一个常驻进程，每 <interval> 秒
      （默认 300）检查一次到点任务并启动为后台执行器（并发上限
      FL_MAX_CONCURRENCY，默认 2）；stop 停止；status 查看存活与上次检查
      结果。仅 role=worker 的机器会开工；看门狗绝不合并。
  run <id>
      Resilient per-task runner (spawned detached by the watchdog; also run by
      hand): worktree isolation, CLI-session resume, usage-limit park,
      sentinel+commit verification. The executor merges its own branch to dev;
      the runner verifies, stamps the report and cleans up.
  cancel <id>|--all [reason...]
      Cancel pending/running tasks; kills a running runner's process group.
      Cascades to tasks that depend on the cancelled id. Worker-local only.
  archive [<batch-id>]
      AUTHOR-side batch close-out (default: the current batch): every member
      must be terminal; writes a batch summary report, moves the manifest +
      envelopes + prompts to archive/, pushes. Ends the batch.
  log <id> [-f]
      Tail a task's run log (replaces the old tmux attach).
  migrate
      Upgrade the committed data schema (.schedule-tasks-data/version) to this
      CLI's schema. Deterministic: commit the current state first, then run —
      rollback is a git revert. Write commands hard-stop until the data schema
      matches the CLI; read commands keep working with a warning.
  doctor
      Environment check: node/git/claude/kimi/graphify, global CLI package
      completeness (bin + src + SKILL.md + references/ + templates/), the bound
      skill dirs (knowledge three present, no code residue), ~/.local/bin
      symlink leftovers, machine identity, data dirs, data schema version.
  install [-t, --target <ids>] [-y, --yes]
      Bind the KNOWLEDGE layer into an agent: copy SKILL.md/references/templates
      (zero code) from the global CLI package into each chosen platform's
      skills/schedule-task (kimi-code / claude / agents). Whole-dir overwrite —
      idempotent, cleans up old-form code residue. Default: interactive pick;
      --target all|auto (or -y) = every detected platform.
  self-test
      Run the full node:test suite (same as \`npm test\`).
  version
      Print the CLI version (from package.json next to this CLI) — the same
      number status/doctor show in the \`CLI vX · data schema vY\` line.
  help
      This help.

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

  if (flags['--version'] || command === 'version') {
    const pkg = JSON.parse(fs.readFileSync(path.join(core.skillRoot(), 'package.json'), 'utf8'));
    console.log(pkg.version);
    return 0;
  }
  if (flags['--help'] || flags['-h'] || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const repo = core.resolveRepo(cliRepo, process.cwd());
  const config = core.readConfig();

  // Schema gate (refactor plan §5.2): data schema newer than the CLI → refuse
  // every gated command; older → read commands warn and continue, write commands
  // hard-stop until `schedule-task migrate` has run. init/install/self-test/
  // help/version manage the install or the version file themselves.
  const schema = core.schemaCheck(repo);
  const gate = (write) => {
    if (schema.status === 'cli-too-old') {
      return { err: `data schema v${schema.data} is newer than this CLI (schema v${core.SCHEMA_VERSION}) — upgrade the CLI first: re-run install.sh` };
    }
    if (schema.status === 'migrate-needed') {
      const msg = `data schema v${schema.data} is older than this CLI (schema v${core.SCHEMA_VERSION}) — run \`schedule-task migrate\``;
      return write ? { err: msg } : { warn: msg };
    }
    return {};
  };

  if (!command) {
    // The most frequent action: query status in the current repo.
    const g = gate(false);
    if (g.err) { console.error(`schedule-task: ${g.err}`); return 1; }
    if (g.warn) console.error(`schedule-task: ${g.warn}`);
    const { render, detectMode } = require('./status.js');
    const autoRoot = config.autoRoot || core.dataDir(repo);
    const logRoot = config.logRoot || core.logRoot(repo, config);
    const mode = config.mode || detectMode({ autoRoot, logRoot, mode: '' });
    process.stdout.write(`${render({ repo, autoRoot, logRoot, mode })}\n`);
    return 0;
  }

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
      const g = gate(false);
      if (g.err) { console.error(`schedule-task: ${g.err}`); return 1; }
      if (g.warn) console.error(`schedule-task: ${g.warn}`);
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
      const g = gate(true);
      if (g.err) { console.error(`schedule-task: ${g.err}`); return 1; }
      const id = args[0];
      if (!id) {
        console.error('usage: schedule-task run <id>');
        return 2;
      }
      const { runOne } = require('./runner.js');
      const result = await runOne({ repo, id, config });
      return result.status === 'dev-done' || result.status === 'audit-pass' ? 0 : 1;
    }
    case 'dev': {
      const g = gate(false);
      if (g.err) { console.error(`schedule-task: ${g.err}`); return 1; }
      if (g.warn) console.error(`schedule-task: ${g.warn}`);
      // Gate: one batch at a time. Refuse to open a NEW batch while a batch is
      // still open — the author must close it with `archive` first.
      const batch = core.currentBatch(repo);
      if (batch) {
        console.error(`dev: current batch ${batch.id} is still open — close it first: schedule-task archive (or finish + audit it)`);
        return 1;
      }
      console.log('dev: no current batch — you may start a new dev batch.');
      console.log('Draft the envelope(s) + prompt(s) from templates/dev-plan-harness.md +');
      console.log('templates/harness-common.md (in .schedule-tasks-data/templates/), review,');
      console.log('then commit them to the inbox branch.');
      return 0;
    }
    case 'audit': {
      const g = gate(true);
      if (g.err) { console.error(`schedule-task: ${g.err}`); return 1; }
      const { audit } = require('./audit.js');
      const mode = flags['--readonly'] ? 'readonly' : 'edit';
      const perTask = !flags['--batch'];
      return audit({ repo, mode, perTask }).exit;
    }
    case 'cancel': {
      const g = gate(true);
      if (g.err) { console.error(`schedule-task: ${g.err}`); return 1; }
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
      const g = gate(true);
      if (g.err) { console.error(`schedule-task: ${g.err}`); return 1; }
      const { archive } = require('./archive.js');
      return archive({ repo, batchId: args[0] }).exit;
    }
    case 'log': {
      const g = gate(false);
      if (g.err) { console.error(`schedule-task: ${g.err}`); return 1; }
      if (g.warn) console.error(`schedule-task: ${g.warn}`);
      const { tailLog } = require('./log.js');
      const id = args[0];
      if (!id) {
        console.error('usage: schedule-task log <id> [-f]');
        return 2;
      }
      return tailLog({ repo, id, follow: Boolean(flags['-f']), config });
    }
    case 'doctor': {
      const g = gate(false);
      if (g.err) { console.error(`schedule-task: ${g.err}`); return 1; }
      if (g.warn) console.error(`schedule-task: ${g.warn}`);
      const { doctor } = require('./doctor.js');
      return doctor({ repo });
    }
    case 'migrate': {
      const { migrate } = require('./migrate.js');
      return migrate({ repo }).exit;
    }
    case 'install': {
      const { install } = require('./install.js');
      return install({
        targets: flags['--target'] || flags['-t'] || undefined,
        yes: Boolean(flags['--yes'] || flags['-y']),
      });
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
