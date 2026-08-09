'use strict';
// audit.js — AUTHOR-side audit creation (v3 flow). After every dev task in the
// current batch is dev-done (merged to dev), the author runs `schedule-task
// audit` to create audit task(s) that review the merged work with a DIFFERENT
// agent than the developer (independent mind). Mode: --readonly (review only)
// or --edit (may rewrite meaningless tests + write new ones). Granularity:
// --per-task (default, one parallel audit per dev task) or --batch (one audit
// over the whole batch). Writes envelopes + prompts for REVIEW; committing is
// the skill's job (REVIEW → COMMIT), consistent with the dev create flow.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.js');

function readTaskEnv(dataRoot, id) {
  for (const dir of ['tasks', path.join('tasks', 'archive')]) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataRoot, dir, `${id}.json`), 'utf8'));
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function audit({ repo, mode, perTask }) {
  const dataRoot = core.dataDir(repo);
  const batch = core.currentBatch(repo);
  if (!batch) {
    console.error('audit: no current batch (batches/*.json) — nothing to audit');
    return { exit: 1 };
  }

  const devDone = (batch.tasks || []).filter((t) => core.reportState(repo, t) === 'dev-done');
  if (devDone.length === 0) {
    console.error(`audit: batch ${batch.id} has no dev-done tasks — every dev task must be merged to dev before auditing`);
    return { exit: 1 };
  }
  const pendingDev = (batch.tasks || []).filter((t) => !devDone.includes(t));
  if (pendingDev.length) {
    console.log(`note: batch ${batch.id} still has non-dev-done tasks — they are NOT audited now: ${pendingDev.join(', ')}`);
  }

  // Templates must be inside the repo (worktree prompts reference them).
  core.ensureTemplates(repo);
  const template = fs.readFileSync(path.join(core.skillRoot(), 'templates', 'audit-harness.md'), 'utf8');

  const now = new Date();
  const day = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const tag = (batch.id.match(/-([^-]+)$/) || [, 'batch'])[1];
  const runAt = now.toISOString();
  let seq = 0;
  const makeId = () => `T${day}-audit-${tag}-${String(++seq).padStart(2, '0')}`;

  const groups = perTask ? devDone.map((t) => [t]) : [devDone];
  const created = [];

  for (const devIds of groups) {
    const id = makeId();
    // Opposite agent of the dev task (default claude → kimi): another mind.
    const devEnv = readTaskEnv(dataRoot, devIds[0]);
    const devAgent = (devEnv && devEnv.agent) || 'claude';
    const agent = devAgent === 'kimi' ? 'claude' : 'kimi';
    const env = {
      id,
      type: 'audit',
      worker: (devEnv && devEnv.worker) || undefined,
      branch: `automation/${id}`,
      prompt_file: `.schedule-tasks-data/prompts/${id}.md`,
      schedule: { run_at: runAt },
      depends_on: devIds,
      agent,
      batch: batch.id,
    };
    const prompt = template
      .replace(/<title>/g, `audit of ${batch.title || batch.id}`)
      .replace(/\$id/g, id)
      .replace(/\$mode/g, mode)
      .replace(/<batch-id>/g, batch.id)
      .replace(/<dev-ids>/g, devIds.join(', '));
    fs.mkdirSync(path.join(dataRoot, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'tasks', `${id}.json`), `${JSON.stringify(env, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dataRoot, 'prompts', `${id}.md`), prompt, 'utf8');
    created.push({ id, devIds, agent });
  }

  console.log(`audit: batch ${batch.id} — created ${created.length} audit task(s) (mode=${mode}, ${perTask ? 'per-task' : 'batch-wide'})`);
  for (const c of created) {
    console.log(`  ${c.id}  agent=${c.agent}  audits: ${c.devIds.join(', ')}`);
  }
  console.log('Templates refreshed in .schedule-tasks-data/templates/.');
  console.log('Review the envelopes + prompts, then commit them to the inbox branch.');
  return { exit: 0 };
}

module.exports = { audit };
