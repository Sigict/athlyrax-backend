import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const node = process.execPath;
const indexPath = path.join(root, 'index.js');

function run(label, args) {
  const result = spawnSync(node, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}
function operationalTransformAlreadyFinalized() {
  if (!fs.existsSync(indexPath)) return false;
  const source = fs.readFileSync(indexPath, 'utf8');
  return [
    'ATHLYRAX_PLANNER_BACKUP_NON_AUTHORITATIVE',
    'ATHLYRAX_ADMIN_USER_REQUIRES_EXISTING_TENANT',
    'ATHLYRAX_INVITE_HISTORY_PRESERVED',
    'ATHLYRAX_PRODUCTION_AUDIT_ARCHIVE_BEFORE_DELETE',
    'ATHLYRAX_BOUNDED_PRIMARY_DB_SNAPSHOT_RETENTION',
  ].every((token) => source.includes(token));
}

const transforms = [
  'scripts/patch-data-safety-coverage.mjs',
  'scripts/patch-storage-recovery-semantics.mjs',
  'scripts/patch-index-signup-legal.mjs',
  'scripts/patch-logout-csrf.mjs',
  'scripts/patch-canonical-storage-contract.mjs',
  'scripts/patch-persistence-integrity.mjs',
  'scripts/patch-durable-storage-writes.mjs',
  'scripts/patch-operational-integrity.mjs',
  'scripts/patch-runtime-data-retention.mjs',
  'scripts/patch-revision-integrity.mjs',
  'scripts/patch-auth-tenant-integrity.mjs',
  'scripts/patch-migration-validation.mjs',
];

for (const relative of transforms) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`Required production transform is missing: ${relative}`);
  if (relative === 'scripts/patch-operational-integrity.mjs' && operationalTransformAlreadyFinalized()) {
    console.log('OPERATIONAL_INTEGRITY_PATCH_ALREADY_FINALIZED');
    continue;
  }
  run(relative, [relative]);
}

for (const relative of [
  'scripts/data-safety-preload.mjs',
  'index.js',
  'scripts/storage-path-contract.mjs',
  'scripts/migrate-storage-once.mjs',
  'scripts/approve-storage-layout.mjs',
]) {
  run(`${relative} syntax check`, ['--check', relative]);
}
run('storage/path audit', ['scripts/audit-storage-paths.mjs']);

for (const obsolete of [
  'scripts/patch-runtime-start-guard.mjs',
  'scripts/patch-provisioning-integrity.mjs',
  'scripts/patch-tenant-storage-path.mjs',
]) {
  if (fs.existsSync(path.join(root, obsolete))) throw new Error(`Obsolete production patch must not exist: ${obsolete}`);
}

console.log('ATHLYRAX_PRODUCTION_BACKEND_BUILD_OK');
