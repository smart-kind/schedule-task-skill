'use strict';
// install.js — `schedule-task install`: bind the KNOWLEDGE layer into an agent.
// Copies the knowledge three (SKILL.md, references/, templates/ — zero code)
// from the global CLI package itself (skillRoot()) into each chosen agent's
// skills/schedule-task. No network, no clone: the global package (installed by
// install.sh) ships the knowledge items alongside bin/src.
//
// Whole-dir overwrite makes this idempotent AND self-cleaning: an existing
// target (an older version, or an old-form full copy containing bin/src/tests/
// package.json/install.sh from previous install schemes) is deleted and
// replaced wholesale. A `.installed-from` marker records the global CLI version
// + install time.
//
// Usage:
//   schedule-task install                             # interactive platform pick
//   schedule-task install --target kimi-code,claude   # explicit platforms
//   schedule-task install --target all --yes          # non-interactive: all detected
//   schedule-task install --yes                       # same as --target all

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const core = require('./core.js');

// Agent platform id → the home dir that owns its skills/ directory. Aligned
// with the platform map the old install.sh used.
const PLATFORM_HOMES = {
  'kimi-code': () => path.join(os.homedir(), '.kimi-code'),
  'claude': () => path.join(os.homedir(), '.claude'),
  'agents': () => path.join(os.homedir(), '.agents'),
};
const PLATFORM_IDS = Object.keys(PLATFORM_HOMES);

// The knowledge three — the only things a skill dir is allowed to contain.
const KNOWLEDGE_ITEMS = ['SKILL.md', 'references', 'templates'];
const MARKER = '.installed-from';

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(core.skillRoot(), 'package.json'), 'utf8')).version;
  } catch {
    return '?';
  }
}

// The knowledge source = the global CLI package. Null when it is missing any of
// the three items — that means install.sh did not ship them (re-run it).
function knowledgeSource() {
  const root = core.skillRoot();
  const missing = KNOWLEDGE_ITEMS.filter((item) => !fs.existsSync(path.join(root, item)));
  return missing.length === 0 ? root : null;
}

// Platforms whose home dir exists on this machine (candidates for `all`/auto).
function detectedPlatforms() {
  return PLATFORM_IDS.filter((id) => fs.existsSync(PLATFORM_HOMES[id]()));
}

// Turn a --target value into a platform id list. `all`/`auto` = the detected
// platforms; `none` = nothing; a comma list = exactly those (an id whose home
// dir does not exist yet is still installed — the user asked for it explicitly).
// Returns null on an unknown id.
function parseTargets(arg, defaultIds) {
  const v = String(arg).trim().toLowerCase();
  if (!v || v === 'all' || v === 'auto') return defaultIds;
  if (v === 'none') return [];
  const out = [];
  for (const raw of v.split(',')) {
    const id = raw.trim().toLowerCase();
    if (!id) continue;
    if (!PLATFORM_IDS.includes(id)) {
      console.error(`install: unknown platform '${raw.trim()}' (want ${PLATFORM_IDS.join('|')}, all, auto, or none)`);
      return null;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

// Whole-dir overwrite: delete the existing target, then copy the knowledge three.
function bindOne(src, id) {
  const dest = path.join(PLATFORM_HOMES[id](), 'skills', 'schedule-task');
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(src, 'SKILL.md'), path.join(dest, 'SKILL.md'));
  fs.cpSync(path.join(src, 'references'), path.join(dest, 'references'), { recursive: true });
  fs.cpSync(path.join(src, 'templates'), path.join(dest, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dest, MARKER), `${version()}\n${new Date().toISOString()}\n`, 'utf8');
  return dest;
}

function askTargets(defaultIds) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (s) => new Promise((resolve) => rl.question(s, resolve));
  return question(
    `Detected platforms: ${defaultIds.join(', ') || '(none)'}\n` +
    `Install the skill into which platform(s)? [${defaultIds.join(',') || 'none'}] (comma-separated, all, none) `
  ).then((answer) => {
    rl.close();
    const ids = parseTargets(answer, defaultIds);
    return { ids, interactive: true };
  });
}

async function install({ targets, yes }) {
  const src = knowledgeSource();
  if (!src) {
    console.error(`install: the global CLI package is missing the knowledge items (${KNOWLEDGE_ITEMS.join(', ')}) — re-run install.sh to restore them, then run install again.`);
    return 1;
  }

  const detected = detectedPlatforms();
  let ids;
  if (targets) {
    ids = parseTargets(targets, detected);
  } else if (yes || !process.stdin.isTTY) {
    ids = detected; // non-interactive default = all detected (== --target all)
  } else {
    ({ ids } = await askTargets(detected));
  }
  if (ids === null) return 2; // parseTargets already printed the error

  if (ids.length === 0) {
    console.log('install: no platform selected — nothing bound. The global CLI (`schedule-task`) is already installed by install.sh; this step only copies the skill (SKILL.md/references/templates) into an agent.');
    return 0;
  }

  for (const id of ids) {
    const dest = bindOne(src, id);
    console.log(`installed  ${id} → ${dest}  (knowledge three; .installed-from: v${version()})`);
  }
  console.log('Done. Re-running this command overwrites the skill dirs (idempotent, cleans old code residue).');
  return 0;
}

module.exports = { install, parseTargets, PLATFORM_IDS, PLATFORM_HOMES, KNOWLEDGE_ITEMS, detectedPlatforms };
