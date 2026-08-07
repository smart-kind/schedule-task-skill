'use strict';
// archive.js — retire a COMPLETED task by moving its prompt + envelope into the
// sibling archive/ dirs instead of deleting them (port of archive-task.sh).
// The dispatcher scans .schedule-tasks-data/tasks/*.json non-recursively, so an
// archived task in tasks/archive/ is out of the active inbox yet stays in git as
// a faithful record. Move-only; never touches reports/ (the durable run record).

const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.js');
const { git } = require('./git.js');

function archive({ repo, id }) {
  const dataRoot = core.dataDir(repo);
  const stateDir = core.stateDir(repo);
  const taskFile = path.join(dataRoot, 'tasks', `${id}.json`);
  if (!fs.existsSync(taskFile)) {
    console.error(`archive: no active task .schedule-tasks-data/tasks/${id}.json`);
    return { exit: 1 };
  }

  // Refuse to archive a task that hasn't finished (done or cancelled) — state
  // lives in the worker-local state dir.
  const st = core.readState(stateDir, id);
  if (st !== 'done' && st !== 'cancelled') {
    console.error(`archive: ${id} state is '${st}' (not done/cancelled); refusing to retire`);
    return { exit: 1 };
  }

  // Resolve the prompt path from the envelope so we archive the exact pair that ran.
  let env;
  try {
    env = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  } catch {
    env = {};
  }
  const promptRel = env.prompt_file || '';
  const promptFile = promptRel ? path.join(repo, promptRel) : '';

  const tasksArchive = path.join(dataRoot, 'tasks', 'archive');
  const promptsArchive = path.join(dataRoot, 'prompts', 'archive');
  core.ensureDir(tasksArchive);
  core.ensureDir(promptsArchive);

  // git mv when tracked, plain mv otherwise — keeps history where possible.
  const mvOne = (from, to) => {
    if (!git(repo, ['mv', from, to]).ok) fs.renameSync(from, to);
  };

  mvOne(taskFile, path.join(tasksArchive, `${id}.json`));
  if (promptFile && fs.existsSync(promptFile)) {
    mvOne(promptFile, path.join(promptsArchive, path.basename(promptRel)));
  }
  console.log(`archive: retired ${id} -> .schedule-tasks-data/{tasks,prompts}/archive/`);
  return { exit: 0 };
}

module.exports = { archive };
