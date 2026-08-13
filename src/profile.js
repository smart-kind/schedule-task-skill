'use strict';
// profile.js — worker profile management (v3.3.0). Reads and edits
// .schedule-tasks-data/workers.json (committed): a list of worker entries, each
// with an id (W01…), a name, an agent (kimi|cc), and per-stage models.
// `profile` (no args) prints a formatted table; `profile <wid> <stage> <model>`
// edits a single stage's model.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.js');

const STAGES = ['dev', 'review', 'mutation', 'test'];

function profileList({ repo }) {
  const workers = core.readWorkers(repo);
  if (workers.length === 0) {
    console.log('No workers configured. Create .schedule-tasks-data/workers.json or use:');
    console.log('  schedule-task profile add <name> <agent>');
    return { exit: 0 };
  }

  const lines = ['Workers:'];
  for (const w of workers) {
    const models = (w.models || {});
    const modelParts = STAGES
      .filter((s) => models[s])
      .map((s) => `${s}: ${models[s]}`);
    const modelStr = modelParts.length ? modelParts.join('  ') : '(no models set)';
    lines.push(`  ${w.id}  ${w.name}  agent=${w.agent || '?'}`);
    lines.push(`       ${modelStr}`);
  }
  console.log(lines.join('\n'));
  return { exit: 0 };
}

function profileAdd({ repo, name, agent }) {
  const workers = core.readWorkers(repo);
  // Generate next id: W01, W02, …
  const seq = String(workers.length + 1).padStart(2, '0');
  const id = `W${seq}`;
  // Check for duplicate name
  if (workers.some((w) => w.name === name)) {
    console.error(`profile: worker name '${name}' already exists`);
    return { exit: 1 };
  }
  if (!['kimi', 'cc'].includes(agent)) {
    console.error(`profile: agent must be 'kimi' or 'cc' (got '${agent}')`);
    return { exit: 1 };
  }
  workers.push({ id, name, agent, models: {} });
  core.writeWorkers(repo, workers);
  console.log(`profile: added ${id} (${name}, agent=${agent})`);
  return { exit: 0 };
}

function profileEdit({ repo, workerId, stage, model }) {
  if (!STAGES.includes(stage)) {
    console.error(`profile: unknown stage '${stage}' (valid: ${STAGES.join(', ')})`);
    return { exit: 1 };
  }
  const workers = core.readWorkers(repo);
  const w = workers.find((x) => x.id === workerId);
  if (!w) {
    console.error(`profile: worker '${workerId}' not found`);
    profileList({ repo });
    return { exit: 1 };
  }
  if (!w.models) w.models = {};
  w.models[stage] = model;
  core.writeWorkers(repo, workers);
  console.log(`profile: ${w.id} (${w.name}) ${stage} → ${model}`);
  return { exit: 0 };
}

function profileRemove({ repo, workerId }) {
  const workers = core.readWorkers(repo);
  const idx = workers.findIndex((w) => w.id === workerId);
  if (idx < 0) {
    console.error(`profile: worker '${workerId}' not found`);
    return { exit: 1 };
  }
  const removed = workers.splice(idx, 1)[0];
  core.writeWorkers(repo, workers);
  console.log(`profile: removed ${removed.id} (${removed.name})`);
  return { exit: 0 };
}

module.exports = { profileList, profileAdd, profileEdit, profileRemove, STAGES };
