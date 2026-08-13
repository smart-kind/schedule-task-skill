#!/usr/bin/env node
// mock-agent.js — fake coding CLI for the test suite. Stands in for `claude`/`kimi`
// behind the SAME interface agents.js uses: argv like `-p <prompt> [--resume <sid>|
// -S <sid>] -m/--model <model>`, stream-json on stdout, exit-code contract.
//
// Knobs (env, set by the test):
//   MOCK_BEHAVIOR  happy | limit      (happy = done on attempt 1; limit = 75 on
//                  attempt 1, done on attempt 2)
//   MOCK_AGENT     claude | kimi      (which event carries the session id)
//   MOCK_TASK_ID   id whose TASK_DONE sentinel the result event contains
//   MOCK_CALLS     file to append `agent=<a> mode=<m> sessid=<s>` per invocation
//   MOCK_COUNT     file with the per-run invocation counter
//   MOCK_EPOCH     (limit/claude) an epoch to print in the limit message
'use strict';

const fs = require('node:fs');

const behavior = process.env.MOCK_BEHAVIOR || 'happy';
const agent = process.env.MOCK_AGENT || 'claude';
const taskId = process.env.MOCK_TASK_ID || '';
const callsFile = process.env.MOCK_CALLS;
const countFile = process.env.MOCK_COUNT;
const epoch = process.env.MOCK_EPOCH || '';

const argv = process.argv.slice(2);
let mode = 'fresh';
let sessid = '-';
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--resume' || argv[i] === '-S') {
    mode = 'resume';
    sessid = argv[i + 1] || '-';
  }
}
if (callsFile) fs.appendFileSync(callsFile, `agent=${agent} mode=${mode} sessid=${sessid}\n`);

let n = 0;
if (countFile && fs.existsSync(countFile)) {
  n = parseInt(fs.readFileSync(countFile, 'utf8') || '0', 10);
}
n += 1;
if (countFile) fs.writeFileSync(countFile, String(n));

const sessionEvent = agent === 'kimi'
  ? `{"type":"meta","session_id":"sess-123","reason":"session.resume_hint"}`
  : `{"type":"system","session_id":"sess-123"}`;
const resultEvent = `{"type":"result","result":"all done [[TASK_DONE ${taskId}"}`;

const done = () => {
  fs.writeFileSync(`mock-work-${n}.txt`, `work ${n}\n`); // a commit in the worktree
  // v3 executor: write the dev report and commit on the task branch. The mock
  // skips the rebase-onto-dev step — tests control dev advancement instead —
  // and never pushes: the runner fast-forwards dev to the branch itself.
  if (taskId) {
    fs.mkdirSync('.schedule-tasks-data/reports', { recursive: true });
    fs.writeFileSync(`.schedule-tasks-data/reports/${taskId}.md`,
      `# Report — ${taskId} (done)\nmock executor report\n`, 'utf8');
    const { execFileSync } = require('node:child_process');
    try {
      execFileSync('git', ['add', '-A'], { stdio: 'ignore' });
      execFileSync('git', ['commit', '-qm', `mock work ${n}`], { stdio: 'ignore' });
    } catch (e) {
      process.stderr.write(`mock commit failed: ${e.message}\n`);
    }
  }
  process.stdout.write(`${sessionEvent}\n${resultEvent}\n`);
  process.exit(0);
};

switch (behavior) {
  case 'happy':
    done();
    break;
  case 'limit':
    if (n === 1) {
      const limitMsg = agent === 'kimi'
        ? '{"type":"error","message":"APIProviderRateLimitError"}'
        : epoch
          ? `usage limit reached; resets at ${epoch}`
          : 'usage limit reached; resets soon';
      process.stdout.write(`${sessionEvent}\n${limitMsg}\n`);
      process.exit(75);
    }
    done();
    break;
  default:
    process.stderr.write(`mock-agent: unknown behavior ${behavior}\n`);
    process.exit(2);
}
