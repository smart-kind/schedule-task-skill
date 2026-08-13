'use strict';
// archive.js — AUTHOR-side batch close-out (v3.3). Archives the CURRENT batch
// (or an explicitly named one): every member must be terminal; writes a batch
// summary report (per-member outcomes + a Follow-ups template), moves the batch
// manifest + member envelopes + prompts into their archive/ dirs, commits and
// pushes. After this the current batch is empty and a new batch may start.
// This is the step that ENDS a batch — whatever its outcome.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.js');
const { git } = require('./git.js');

function readManifest(dataRoot, id) {
  const f = path.join(dataRoot, 'batches', `${id}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function archive({ repo, batchId }) {
  const dataRoot = core.dataDir(repo);
  const batch = batchId ? readManifest(dataRoot, batchId) : core.currentBatch(repo);
  if (!batch) {
    console.error('archive: no current batch to archive (no batches/*.json)');
    return { exit: 1 };
  }
  if (!git(repo, ['fetch', 'origin']).ok) {
    console.error('archive: git fetch failed (offline?)');
    return { exit: 1 };
  }

  // Members: the manifest's tasks, in manifest order.
  const tasksDir = path.join(dataRoot, 'tasks');
  let files = [];
  try {
    files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  const members = [];
  for (const f of files) {
    let env;
    try {
      env = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (env.id && ((batch.tasks || []).includes(env.id) || env.batch === batch.id)) members.push(env);
  }
  const order = new Map();
  (batch.tasks || []).forEach((t, i) => order.set(t, i));
  members.sort((a, b) => {
    const ao = order.has(a.id) ? order.get(a.id) : 999;
    const bo = order.has(b.id) ? order.get(b.id) : 999;
    return ao - bo || a.id.localeCompare(b.id);
  });
  if (members.length === 0) {
    console.error(`archive: batch ${batch.id} has no envelopes in tasks/ (already archived?)`);
    return { exit: 1 };
  }

  // Every member must be terminal — a batch closes whatever its outcome, but
  // not while something is still pending or running.
  const active = members.filter((m) => !core.isTerminalState(core.reportState(repo, m.id)));
  if (active.length) {
    const detail = active.map((m) => `${m.id} (${core.reportState(repo, m.id)})`).join(', ');
    console.error(`archive: batch ${batch.id} still has active members: ${detail} — wait, or cancel them first`);
    return { exit: 1 };
  }

  // Batch summary report: per-member outcome + a follow-ups section the author's
  // agent can fill in.
  const counts = {};
  const lines = [];
  for (const m of members) {
    const st = core.reportState(repo, m.id);
    counts[st] = (counts[st] || 0) + 1;
    lines.push(`- ${m.id}: ${st}`);
  }
  const summary = [
    `# Batch report — ${batch.id} (archived)`,
    '',
    batch.title ? `Title: ${batch.title}` : '',
    batch.notes ? `Notes: ${batch.notes}` : '',
    '',
    `## Outcomes (${members.length} members)`,
    '',
    ...lines,
    '',
    '## Follow-ups',
    '',
    '- (the author\'s agent may fill follow-up suggestions here)',
    '',
  ].filter((l) => l !== '').join('\n');
  const reportFile = path.join(dataRoot, 'reports', `${batch.id}.md`);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, summary, 'utf8');

  // Move manifest + envelopes + prompts into their archive/ dirs.
  const move = (from, to) => {
    if (!git(repo, ['mv', from, to]).ok) fs.renameSync(from, to);
  };
  fs.mkdirSync(path.join(dataRoot, 'batches', 'archive'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'tasks', 'archive'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'prompts', 'archive'), { recursive: true });
  const manFile = path.join(dataRoot, 'batches', `${batch.id}.json`);
  if (fs.existsSync(manFile)) move(manFile, path.join(dataRoot, 'batches', 'archive', `${batch.id}.json`));
  for (const m of members) {
    const tf = path.join(dataRoot, 'tasks', `${m.id}.json`);
    if (fs.existsSync(tf)) move(tf, path.join(dataRoot, 'tasks', 'archive', `${m.id}.json`));
    if (m.prompt_file) {
      const pf = path.join(repo, m.prompt_file);
      if (fs.existsSync(pf)) move(pf, path.join(dataRoot, 'prompts', 'archive', path.basename(m.prompt_file)));
    }
  }

  // Commit + push (author-side).
  git(repo, ['add', '-A']);
  const committed = git(repo, ['commit', '-m', `archive batch ${batch.id}`]);
  if (!committed.ok) console.log('archive: nothing new to commit (already archived?)');
  const pushed = git(repo, ['push', 'origin', core.readConfig().inbox]);
  if (!pushed.ok) {
    console.error('archive: push failed (offline?)');
    return { exit: 1 };
  }

  const countText = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(' · ');
  console.log(`archive: batch ${batch.id} archived (${members.length} members: ${countText}) — current batch is now empty.`);
  console.log(`  summary: .schedule-tasks-data/reports/${batch.id}.md`);
  return { exit: 0 };
}

module.exports = { archive };
