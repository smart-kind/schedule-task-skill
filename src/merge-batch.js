'use strict';
// merge-batch.js — AUTHOR-side batch finalization (port of merge-batch.sh).
// Workers NEVER merge; the author lands every finished task's branch onto the
// manifest's merge_target (default dev), in manifest (dependency) order, then
// pushes. Run on the author box after `git fetch` — works in any working tree,
// no worker needed.
//
// "Finished" = the task branch has a committed .schedule-tasks-data/reports/<id>.md
// whose H1 says (done) — read from origin/<branch>, because the reports live on
// the task branches, not on the merge target, until this script merges them.
// Tasks without a done report are skipped and reported, never merged.
//
// On conflict: abort the merge and exit non-zero — resolution is human/agent
// work, never an automatic force-through. Idempotent: re-running after a fix
// continues from where it stopped (already-merged branches merge cleanly).

const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.js');
const { git, objectExists, showFile } = require('./git.js');

function mergeBatch({ repo, batchId }) {
  const dataRoot = core.dataDir(repo);
  const manifestFile = path.join(dataRoot, 'batches', `${batchId}.json`);
  if (!fs.existsSync(manifestFile)) {
    console.error(`merge-batch: no manifest .schedule-tasks-data/batches/${batchId}.json`);
    return { exit: 1 };
  }
  let man;
  try {
    man = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    console.error(`merge-batch: manifest ${batchId} is not valid JSON`);
    return { exit: 1 };
  }
  const target = man.merge_target || 'dev';
  const tids = man.tasks || [];
  const mlog = (msg) => console.log(`[${core.ts()}] merge-batch: ${msg}`);

  if (tids.length === 0) {
    console.error(`merge-batch: manifest ${batchId} has no tasks`);
    return { exit: 1 };
  }
  if (!git(repo, ['fetch', 'origin']).ok) {
    console.error('merge-batch: git fetch failed (offline?)');
    return { exit: 1 };
  }
  // Bring the merge target up to date on top of origin; refuse to invent a merge commit.
  if (!git(repo, ['checkout', target]).ok) {
    console.error(`merge-batch: cannot checkout ${target}`);
    return { exit: 1 };
  }
  if (!git(repo, ['merge', '--ff-only', `origin/${target}`]).ok) {
    console.error(`merge-batch: ${target} cannot fast-forward from origin/${target} (local commits?); aborting`);
    return { exit: 1 };
  }

  let merged = 0;
  let skipped = 0;
  for (const tid of tids) {
    // Envelope may be archived by the time the batch completes — check both locations.
    let ef = path.join(dataRoot, 'tasks', `${tid}.json`);
    if (!fs.existsSync(ef)) ef = path.join(dataRoot, 'tasks', 'archive', `${tid}.json`);
    if (!fs.existsSync(ef)) {
      mlog(`${tid}: no envelope (archived?); skipped`);
      skipped += 1;
      continue;
    }
    let env;
    try {
      env = JSON.parse(fs.readFileSync(ef, 'utf8'));
    } catch {
      mlog(`${tid}: envelope unreadable; skipped`);
      skipped += 1;
      continue;
    }
    const br = env.branch || '';
    if (!br) {
      mlog(`${tid}: no branch field; skipped`);
      skipped += 1;
      continue;
    }
    // Done is judged from the committed report ON THE BRANCH (not on the target).
    const reportRef = `origin/${br}:.schedule-tasks-data/reports/${tid}.md`;
    if (!objectExists(repo, reportRef)) {
      mlog(`${tid}: no report on origin/${br} (not finished / no push); skipped`);
      skipped += 1;
      continue;
    }
    const rep = showFile(repo, `origin/${br}`, `.schedule-tasks-data/reports/${tid}.md`);
    if (!rep.ok || !/\(done\)/.test(rep.stdout)) {
      mlog(`${tid}: report on origin/${br} is not (done); skipped`);
      skipped += 1;
      continue;
    }
    if (git(repo, ['merge', '--no-edit', `origin/${br}`]).ok) {
      mlog(`merged ${br} -> ${target}`);
      merged += 1;
    } else {
      git(repo, ['merge', '--abort']);
      mlog(`CONFLICT merging ${br} into ${target}; batch halted (later branches unmerged)`);
      console.error(`merge-batch: conflict on a task branch; ${target} left clean — resolve by hand, then re-run`);
      return { exit: 1 };
    }
  }

  if (!git(repo, ['push', 'origin', target]).ok) {
    console.error(`merge-batch: push ${target} failed`);
    return { exit: 1 };
  }
  console.log(`merge-batch: ${batchId} — merged ${merged} branch(es) into ${target}, skipped ${skipped} (no done report); pushed`);
  return { exit: 0 };
}

module.exports = { mergeBatch };
