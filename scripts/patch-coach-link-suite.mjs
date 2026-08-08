import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const node = process.execPath;

// ATHLYRAX_COACH_LINK_SUITE_V1
// Keep the individual transformations as focused implementation modules, but
// expose exactly one production-build transform. Internal order is audited.
const steps = [
  'scripts/patch-swimmer-coach-authority.mjs',
  'scripts/patch-parent-notification-semantics.mjs',
  'scripts/patch-coach-link-workflow.mjs',
  'scripts/patch-coach-link-lifecycle.mjs',
  'scripts/patch-coach-link-integrity.mjs',
  'scripts/patch-coach-link-ownership.mjs',
  'scripts/patch-coach-link-routing.mjs',
  'scripts/patch-coach-link-reconnect.mjs',
  'scripts/patch-coach-link-transaction-integrity.mjs',
  'scripts/patch-coach-link-rollback-safety.mjs',
];

for (const relative of steps) {
  const filePath = path.join(root, relative);
  if (!fs.existsSync(filePath)) throw new Error(`Coach-link suite step is missing: ${relative}`);
  const result = spawnSync(node, [relative], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Coach-link suite step failed (${relative}) with exit code ${result.status}.`);
}

const indexPath = path.join(root, 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');
for (const marker of [
  'ATHLYRAX_SWIMMER_PROFILE_SYNC_COACH_LINK_NON_AUTHORITATIVE',
  'ATHLYRAX_PARENT_NOTIFICATION_ONLY',
  'ATHLYRAX_COACH_LINK_WORKFLOW_V1',
  'ATHLYRAX_COACH_LINK_LIFECYCLE_V1',
  'ATHLYRAX_COACH_LINK_INTEGRITY_V1',
  'ATHLYRAX_COACH_LINK_TENANT_OWNERSHIP_V1',
  'ATHLYRAX_COACH_LINK_UNAMBIGUOUS_ROUTING_V1',
  'ATHLYRAX_COACH_LINK_RECONNECT_V1',
  'ATHLYRAX_COACH_LINK_TRANSACTIONAL_COMMIT_V1',
  'ATHLYRAX_COACH_LINK_REVISION_SAFE_ROLLBACK',
]) {
  if (!source.includes(marker)) throw new Error(`Coach-link suite final verification failed: ${marker}`);
}

console.log('ATHLYRAX_COACH_LINK_SUITE_OK');
