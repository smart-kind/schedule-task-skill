'use strict';
// git.js — thin wrappers around `git` for the parts of the runtime that touch git.
// Every call returns { ok, stdout, code } — the caller decides what failure means
// (dispatch tolerates offline, merge-batch must fail hard). git is the only
// channel: author pushes intent, worker pushes back results.

const { execFileSync } = require('node:child_process');

// Run git in `repo`. Never throws — returns { ok, stdout, code }.
function git(repo, args, opts = {}) {
  const stdio = opts.quiet === false ? 'inherit' : 'pipe';
  try {
    const stdout = execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', stdio, stdio],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout || '', code: 0 };
  } catch (err) {
    return { ok: false, stdout: '', code: typeof err.status === 'number' ? err.status : 1 };
  }
}

// Short-hand: true when git status shows no *tracked* changes (untracked stray
// files are benign and ignored — this guard exists to avoid fighting an
// in-flight edit / interactive session).
function treeClean(repo) {
  const r = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  return r.ok && r.stdout.trim() === '';
}

// `git show <ref>:<path>` — the report path read from a task branch without
// checking it out. { ok, stdout } (ok=false when the blob doesn't exist).
function showFile(repo, ref, filePath) {
  const r = git(repo, ['show', `${ref}:${filePath}`]);
  return r.ok ? { ok: true, stdout: r.stdout } : { ok: false, stdout: '' };
}

// Object exists? `git cat-file -e <rev>`.
function objectExists(repo, rev) {
  return git(repo, ['cat-file', '-e', rev]).ok;
}

// rev-parse HEAD (returns '' on failure).
function headSha(repo) {
  const r = git(repo, ['rev-parse', 'HEAD']);
  return r.ok ? r.stdout.trim() : '';
}

module.exports = { git, treeClean, showFile, objectExists, headSha };
