import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const node = process.execPath;

function run(label, args) {
  const result = spawnSync(node, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

const transforms = [
  'scripts/patch-data-safety-coverage.mjs',
  'scripts/patch-storage-recovery-semantics.mjs',
  'scripts/patch-index-signup-legal.mjs',
  'scripts/patch-logout-csrf.mjs',
  'scripts/patch-canonical-storage-contract.mjs',
  'scripts/patch-auth-persistence-transaction.mjs',
  'scripts/patch-persistence-integrity.mjs',
  'scripts/patch-durable-storage-writes.mjs',
  'scripts/patch-operational-integrity.mjs',
  'scripts/patch-runtime-data-retention.mjs',
  'scripts/patch-revision-integrity.mjs',
  'scripts/patch-auth-tenant-integrity.mjs',
  'scripts/patch-migration-validation.mjs',
  'scripts/patch-runtime-auth-billing-safety.mjs',
  'scripts/patch-stripe-webhook-signature.mjs',
  'scripts/patch-stripe-webhook-processing-availability.mjs',
  'scripts/patch-runtime-identity-event-safety.mjs',
  'scripts/patch-ownership-integrity.mjs',
  'scripts/patch-orphan-tenant-safety.mjs',
  'scripts/patch-billing-catalog-integrity.mjs',
  'scripts/patch-account-lifecycle-integrity.mjs',
  'scripts/patch-auth-enumeration-safety.mjs',
  'scripts/patch-password-policy.mjs',
  'scripts/patch-snapshot-cookie-session.mjs',
  'scripts/patch-production-auth-token-redaction.mjs',
  'scripts/patch-coach-link-suite.mjs',
  'scripts/patch-client-ip-integrity.mjs',
  'scripts/patch-rate-limit-integrity.mjs',
  'scripts/patch-request-body-limits.mjs',
  'scripts/patch-production-error-redaction.mjs',
  'scripts/patch-production-cors-origins.mjs',
  'scripts/patch-runtime-db-read-integrity.mjs',
];

for (const relative of transforms) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`Required production transform is missing: ${relative}`);
  run(relative, [relative]);
}

if (!fs.existsSync(path.join(root, 'scripts/patch-bulk-delete-tombstone-capacity.mjs'))) throw new Error('Required bulk-delete tombstone capacity guard is missing.');
run('bulk-delete tombstone capacity guard', ['scripts/patch-bulk-delete-tombstone-capacity.mjs']);

if (!fs.existsSync(path.join(root, 'scripts/patch-server-authoritative-schedule-delete.mjs'))) throw new Error('Required server-authoritative schedule deletion guard is missing.');
run('server-authoritative schedule deletion guard', ['scripts/patch-server-authoritative-schedule-delete.mjs']);

if (!fs.existsSync(path.join(root, 'scripts/patch-schedule-delete-block-integrity.mjs'))) throw new Error('Required Schedule delete block-integrity guard is missing.');
run('Schedule delete block-integrity guard', ['scripts/patch-schedule-delete-block-integrity.mjs']);

if (!fs.existsSync(path.join(root, 'scripts/patch-server-authoritative-schedule-delete-verification.mjs'))) throw new Error('Required server-authoritative schedule deletion match verification is missing.');
run('server-authoritative schedule deletion match verification', ['scripts/patch-server-authoritative-schedule-delete-verification.mjs']);

if (!fs.existsSync(path.join(root, 'scripts/patch-retire-legacy-training-schedules.mjs'))) throw new Error('Required legacy trainingSchedules retirement guard is missing.');
run('legacy trainingSchedules retirement guard', ['scripts/patch-retire-legacy-training-schedules.mjs']);

if (!fs.existsSync(path.join(root, 'scripts/patch-public-demo-readonly.mjs'))) throw new Error('Required public demo read-only guard is missing.');
run('public demo read-only guard', ['scripts/patch-public-demo-readonly.mjs']);

for (const relative of [
  'scripts/data-safety-preload.mjs',
  'index.js',
  'scripts/storage-path-contract.mjs',
  'scripts/migrate-storage-once.mjs',
  'scripts/approve-storage-layout.mjs',
  'scripts/signup-legal-acceptance-preload.mjs',
  'scripts/stage-storage-restore.mjs',
  'scripts/patch-stripe-webhook-signature.mjs',
  'scripts/patch-stripe-webhook-processing-availability.mjs',
  'scripts/patch-password-policy.mjs',
  'scripts/patch-snapshot-cookie-session.mjs',
  'scripts/patch-production-auth-token-redaction.mjs',
  'scripts/patch-public-demo-readonly.mjs',
  'scripts/patch-client-ip-integrity.mjs',
  'scripts/patch-rate-limit-integrity.mjs',
  'scripts/patch-request-body-limits.mjs',
  'scripts/patch-bulk-delete-tombstone-capacity.mjs',
  'scripts/patch-server-authoritative-schedule-delete.mjs',
  'scripts/patch-schedule-delete-block-integrity.mjs',
  'scripts/patch-server-authoritative-schedule-delete-verification.mjs',
  'scripts/patch-retire-legacy-training-schedules.mjs',
]) {
  run(`${relative} syntax check`, ['--check', relative]);
}
run('storage/path audit', ['scripts/audit-storage-paths.mjs']);
run('production transform-chain audit', ['scripts/audit-production-transform-chain.mjs']);

for (const obsolete of [
  'scripts/patch-runtime-start-guard.mjs',
  'scripts/patch-provisioning-integrity.mjs',
  'scripts/patch-tenant-storage-path.mjs',
]) {
  if (fs.existsSync(path.join(root, obsolete))) throw new Error(`Obsolete production patch must not exist: ${obsolete}`);
}

console.log('ATHLYRAX_PRODUCTION_BACKEND_BUILD_OK');