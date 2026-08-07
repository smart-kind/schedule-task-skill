'use strict';
// helpers.js — VPS-free test scaffolding: temp git repos with a bare origin and
// a committed .schedule-tasks-data skeleton, envelope/prompt writers, and a
// shared mock coding-agent CLI (tests/helpers.js is NOT a test file).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function tmpdir(prefix = 'schedtask-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function dataRoot(repo) {
  return path.join(repo, '.schedule-tasks-data');
}

// Temp git repo on branch `dev`, with a bare origin (so dispatch/merge can fetch)
// and the gitignore snippet already merged (like init would).
function makeRepo(t, name) {
  const repo = path.join(t, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'dev']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.schedule-tasks-data/state/\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'README.md'), 'init\n', 'utf8');
  const origin = path.join(t, `${name}-origin.git`);
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'init']);
  git(repo, ['push', '-q', 'origin', 'dev']);
  return { repo, origin };
}

// Commit an envelope + prompt on dev (and push). prompt_file defaults to
// .schedule-tasks-data/prompts/<id>.md.
function addTask(repo, env, promptText) {
  const promptFile = env.prompt_file || `.schedule-tasks-data/prompts/${env.id}.md`;
  env.prompt_file = promptFile;
  fs.mkdirSync(path.join(dataRoot(repo), 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot(repo), 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot(repo), 'tasks', `${env.id}.json`), `${JSON.stringify(env, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(repo, promptFile), promptText, 'utf8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', `task ${env.id}`]);
  git(repo, ['push', '-q', 'origin', 'dev']);
}

// Copy the shared mock agent into a tmp location and make it executable.
function installMock(t) {
  const mock = path.join(t, 'mock-agent.js');
  fs.copyFileSync(path.join(__dirname, 'mock-agent.js'), mock);
  fs.chmodSync(mock, 0o755);
  return mock;
}

module.exports = { tmpdir, git, dataRoot, makeRepo, addTask, installMock };
