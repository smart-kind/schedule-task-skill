'use strict';
// migrate.js — `schedule-task migrate`: deterministic, AI-free upgrade of the
// committed data schema (.schedule-tasks-data/version). The CLI only does the
// mechanical part; deciding when it is safe and committing first (so a bad
// migration is a git revert away) is the agent's job — see docs/refactor-three-layer-separation.md §5.2.

const core = require('./core.js');

function migrate({ repo }) {
  const check = core.schemaCheck(repo);
  if (check.status === 'no-data') {
    console.log('migrate: no .schedule-tasks-data/ here — nothing to migrate. Run `schedule-task init` first.');
    return { exit: 0 };
  }
  if (check.status === 'cli-too-old') {
    console.error(
      `migrate: data schema v${check.data} is NEWER than this CLI (schema v${core.SCHEMA_VERSION}) — ` +
      'upgrade the CLI first: install.sh --update'
    );
    return { exit: 1 };
  }
  if (check.status === 'ok') {
    console.log(`migrate: data schema v${core.SCHEMA_VERSION} is current — nothing to do.`);
    return { exit: 0 };
  }
  // migrate-needed: v0 (unversioned) → v1 stamps the version file; the data
  // formats themselves did not change in this release, so no rewriting.
  console.log(`migrate: upgrading data schema v${check.data} -> v${core.SCHEMA_VERSION}`);
  core.writeSchemaVersion(core.dataDir(repo));
  console.log('migrate: done — commit the changes (rollback = revert that commit) and re-run your command.');
  return { exit: 0 };
}

module.exports = { migrate };
