import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const failures = [];
const read = (relative) => {
  const filePath = path.join(root, relative);
  if (!fs.existsSync(filePath)) {
    failures.push(`Missing required file: ${relative}`);
    return '';
  }
  return fs.readFileSync(filePath, 'utf8');
};

const expectedTransforms = [
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
  'scripts/patch-runtime-auth-billing-safety.mjs',
  'scripts/patch-auth-persistence-transaction.mjs',
  'scripts/patch-runtime-identity-event-safety.mjs',
  'scripts/patch-ownership-integrity.mjs',
  'scripts/patch-orphan-tenant-safety.mjs',
  'scripts/patch-billing-catalog-integrity.mjs',
  'scripts/patch-account-lifecycle-integrity.mjs',
  'scripts/patch-swimmer-coach-authority.mjs',
  'scripts/patch-parent-notification-semantics.mjs',
  'scripts/patch-coach-link-workflow.mjs',
  'scripts/patch-coach-link-lifecycle.mjs',
  'scripts/patch-coach-link-integrity.mjs',
  'scripts/patch-coach-link-ownership.mjs',
  'scripts/patch-coach-link-routing.mjs',
  'scripts/patch-coach-link-reconnect.mjs',
  'scripts/patch-coach-link-transaction-integrity.mjs',
  'scripts/patch-production-cors-origins.mjs',
  'scripts/patch-runtime-db-read-integrity.mjs',
];

for (const relative of expectedTransforms) read(relative);

const build = read('scripts/build-production-backend.mjs');
const transformArrayMatch = build.match(/const transforms = \[([\s\S]*?)\n\];/);
if (!transformArrayMatch) {
  failures.push('scripts/build-production-backend.mjs: transforms array could not be parsed.');
} else {
  const actualTransforms = Array.from(transformArrayMatch[1].matchAll(/'([^']+\.mjs)'/g), (match) => match[1]);
  if (JSON.stringify(actualTransforms) !== JSON.stringify(expectedTransforms)) {
    failures.push(`scripts/build-production-backend.mjs: production transform order mismatch. Expected ${JSON.stringify(expectedTransforms)} but found ${JSON.stringify(actualTransforms)}.`);
  }
  if (new Set(actualTransforms).size !== actualTransforms.length) {
    failures.push('scripts/build-production-backend.mjs: duplicate production transform exists.');
  }
}

for (const required of [
  "run('storage/path audit', ['scripts/audit-storage-paths.mjs']);",
  "run('production transform-chain audit', ['scripts/audit-production-transform-chain.mjs']);",
  "run(`${relative} syntax check`, ['--check', relative]);",
  'ATHLYRAX_PRODUCTION_BACKEND_BUILD_OK',
]) if (!build.includes(required)) failures.push(`scripts/build-production-backend.mjs: missing build guard ${required}`);

const transformedIndex = read('index.js');
for (const marker of [
  'ATHLYRAX_AUTH_PAIRED_PERSISTENCE_TRANSACTION',
  'ATHLYRAX_SWIMMER_PROFILE_SYNC_COACH_LINK_NON_AUTHORITATIVE',
  'ATHLYRAX_COACH_LINK_WORKFLOW_V1',
  'ATHLYRAX_COACH_LINK_LIFECYCLE_V1',
  'ATHLYRAX_COACH_LINK_INTEGRITY_V1',
  'ATHLYRAX_COACH_LINK_TENANT_OWNERSHIP_V1',
  'ATHLYRAX_COACH_LINK_UNAMBIGUOUS_ROUTING_V1',
  'ATHLYRAX_COACH_LINK_RECONNECT_V1',
  'ATHLYRAX_COACH_LINK_TRANSACTIONAL_COMMIT_V1',
  'ATHLYRAX_COACH_LINK_REQUESTS_HIDDEN_FROM_GENERIC_DB',
  'ATHLYRAX_COACH_LINK_REQUESTS_PRESERVED_ON_GENERIC_DB_WRITE',
]) if (!transformedIndex.includes(marker)) failures.push(`index.js: missing transformed production marker ${marker}`);

const authPersistencePatch = read('scripts/patch-auth-persistence-transaction.mjs');
for (const token of [
  'ATHLYRAX_AUTH_PAIRED_PERSISTENCE_TRANSACTION',
  'writeAtomicJsonFile(AUTH_USERS_BACKUP_PATH, payload);',
  'writeAtomicJsonFile(AUTH_USERS_PATH, payload);',
  'Authentication primary/backup verification failed after persistence.',
  'restorePrevious(AUTH_USERS_PATH',
  'restorePrevious(AUTH_USERS_BACKUP_PATH',
  'rollback was incomplete',
]) if (!authPersistencePatch.includes(token)) failures.push(`scripts/patch-auth-persistence-transaction.mjs: missing required token ${token}`);

const coachTransactionPatch = read('scripts/patch-coach-link-transaction-integrity.mjs');
for (const token of [
  'ATHLYRAX_COACH_LINK_ACCEPT_DB_FIRST_AUTH_LAST',
  'ATHLYRAX_COACH_LINK_REJECT_ROLLBACK_TARGET',
  'ATHLYRAX_COACH_LINK_DISCONNECT_DB_FIRST_AUTH_LAST',
  'database rollback was incomplete',
]) if (!coachTransactionPatch.includes(token)) failures.push(`scripts/patch-coach-link-transaction-integrity.mjs: missing required token ${token}`);

const pkg = JSON.parse(read('package.json') || '{}');
const postinstall = String(pkg?.scripts?.postinstall || '');
const start = String(pkg?.scripts?.start || '');
const storageAudit = String(pkg?.scripts?.['audit:storage-paths'] || '');
const storageAll = String(pkg?.scripts?.['test:storage-all'] || '');
const securityVerify = String(pkg?.scripts?.['verify:closed-pilot-security'] || '');

if (postinstall !== 'node scripts/build-production-backend.mjs') failures.push('package.json: postinstall is not the verified production build orchestrator.');
if (!start.includes('test:storage-all') || !start.includes('production-start.mjs')) failures.push('package.json: production start is not gated by the full test suite.');
if (!storageAudit.includes('audit-storage-paths.mjs') || !storageAudit.includes('audit-production-transform-chain.mjs')) {
  failures.push('package.json: audit:storage-paths must run both storage and transform-chain audits.');
}
for (const requiredTest of [
  'test:storage-safety',
  'test:data-safety',
  'test:persistence-integrity',
  'test:auth-persistence-transaction',
  'test:storage-routing-safety',
  'test:storage-migration-identity',
  'test:storage-extra-invariants',
  'test:startup-mutation-safety',
  'test:storage-path-integrity',
  'test:storage-path-contract',
  'test:signup-legal-acceptance',
  'test:runtime-hardening',
  'test:billing-catalog-integrity',
  'test:coach-link-workflow',
  'test:closed-pilot-backup-restore',
  'test:closed-pilot-security',
  'audit:storage-paths',
]) {
  if (!storageAll.includes(requiredTest)) failures.push(`package.json: test:storage-all missing ${requiredTest}`);
}
for (const requiredTest of ['test:auth-persistence-transaction', 'test:coach-link-workflow', 'audit:storage-paths']) {
  if (!securityVerify.includes(requiredTest)) failures.push(`package.json: verify:closed-pilot-security missing ${requiredTest}`);
}

if (failures.length) {
  console.error('ATHLYRAX_PRODUCTION_TRANSFORM_CHAIN_AUDIT_FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('ATHLYRAX_PRODUCTION_TRANSFORM_CHAIN_AUDIT_OK');
