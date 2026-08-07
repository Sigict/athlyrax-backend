import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const runtimeFiles = [
  'index.js',
  'verify-closed-pilot-security.mjs',
  'scripts/approve-storage-layout.mjs',
  'scripts/check-storage-safety.mjs',
  'scripts/data-safety-preload.mjs',
  'scripts/db-revision-put-response.mjs',
  'scripts/prod-isolation-smoke.mjs',
  'scripts/safe-start.mjs',
  'scripts/signup-legal-acceptance-preload.mjs',
  'scripts/stage-storage-restore.mjs',
  'scripts/storage-path-contract.mjs',
  'scripts/storage-safety-lib.mjs',
  'scripts/patch-durable-storage-writes.mjs',
];

const failures = [];
const forbiddenByFile = new Map([
  ['index.js', [
    `path.join(STORAGE_ROOT, 'tenants', 'clubs')`,
    `path.join(STORAGE_ROOT, 'auth-users.json')`,
    `writeAtomicJsonFile(storagePaths.dbPath, {});`,
    `writeJsonFile(AUTH_USERS_PATH,`,
    `writeJsonFile(AUTH_USERS_BACKUP_PATH,`,
    `import { runStorageSafetyCheck } from './scripts/storage-safety-lib.mjs';`,
  ]],
  ['verify-closed-pilot-security.mjs', [
    `path.join(storageRootPath, 'auth-users.json')`,
    `path.join(resolvedStorageRoot, 'auth-users.json')`,
  ]],
  ['scripts/storage-safety-lib.mjs', ['linkRepositoryStorage', 'symlinkSync(', 'repositoryStoragePath']],
  ['scripts/prod-isolation-smoke.mjs', ['Demo tenant expected empty', 'Research tenant view expected empty', 'authorization: `Bearer']],
  ['scripts/safe-start.mjs', ['linkStorage: true']],
]);

for (const relative of runtimeFiles) {
  const filePath = path.join(root, relative);
  if (!fs.existsSync(filePath)) {
    failures.push(`Missing runtime file: ${relative}`);
    continue;
  }
  const source = fs.readFileSync(filePath, 'utf8');
  for (const token of forbiddenByFile.get(relative) || []) {
    if (source.includes(token)) failures.push(`${relative}: forbidden storage token remains: ${token}`);
  }
}

const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
for (const required of [
  `path.join(STORAGE_ROOT, 'tenants')`,
  `path.join(STORAGE_ROOT, 'auth', 'auth-users.json')`,
  `action: 'tenant_database_missing'`,
  `// ATHLYRAX_CANONICAL_STORAGE_RUNTIME_GUARD`,
  `// ATHLYRAX_PRODUCTION_AUTH_STORE_FAIL_CLOSED`,
  `// ATHLYRAX_AUTH_BOOTSTRAP_ATOMIC_WRITES`,
  `// ATHLYRAX_AUTH_INVITES_FAIL_CLOSED`,
  `// ATHLYRAX_STRIPE_WEBHOOK_SIGNATURE_REQUIRED`,
  `// ATHLYRAX_FAIL_CLOSED_MISSING_TENANT_WRITE`,
  `// ATHLYRAX_NEW_TENANT_DB_PROVISION`,
  `// ATHLYRAX_DURABLE_ATOMIC_JSON_WRITES`,
  `Render runtime requires NODE_ENV=production`,
  `Production authentication store is empty. Refusing backup/environment/default account fallback.`,
  `Authentication invite store is unreadable or invalid. Refusing to replace it with an empty file.`,
  `Stripe webhook signature is required.`,
  `Stripe webhook verification is not configured.`,
  `resolveStorageConfiguration(process.env, __dirname)`,
  `runtimeLegacyMigration = migrateLegacyStorageIfNeeded({`,
  `restoreBundledDemoTenantIfNeeded({`,
  `runStorageSafetyCheck({`,
  `finalizeLegacyStorageMigration({`,
  `registrationTenantStorage = resolveStoragePathsForTenantKey(tenantId)`,
  `invited_tenant_database_missing`,
  `provisioningToken: registrationTenantProvisioningToken`,
  `crypto.randomBytes(6).toString('hex')`,
  `fs.openSync(tmpPath, 'wx', 0o600)`,
  `fs.fsyncSync(fileHandle)`,
]) {
  if (!indexSource.includes(required)) failures.push(`index.js: missing canonical token: ${required}`);
}

const safeStartSource = fs.readFileSync(path.join(root, 'scripts', 'safe-start.mjs'), 'utf8');
for (const required of [
  `Safe production start requires NODE_ENV=production`,
  'resolveStorageConfiguration(process.env, repoRoot)',
  'initialStorageConfiguration.failures.length > 0',
  'legacyMigration = migrateLegacyStorageIfNeeded({',
  'restoreBundledDemoTenantIfNeeded({',
  'runStorageSafetyCheck({',
  'requireFiles: true',
  'finalizeLegacyStorageMigration({',
]) {
  if (!safeStartSource.includes(required)) failures.push(`scripts/safe-start.mjs: missing prevalidated storage token: ${required}`);
}
const resolveIndex = safeStartSource.indexOf('resolveStorageConfiguration(process.env, repoRoot)');
const migrateIndex = safeStartSource.indexOf('legacyMigration = migrateLegacyStorageIfNeeded({');
const restoreIndex = safeStartSource.indexOf('restoreBundledDemoTenantIfNeeded({');
const checkIndex = safeStartSource.indexOf('runStorageSafetyCheck({');
const finalizeIndex = safeStartSource.indexOf('finalizeLegacyStorageMigration({');
if ([resolveIndex, migrateIndex, restoreIndex, checkIndex, finalizeIndex].some((value) => value < 0)
  || !(resolveIndex < migrateIndex && migrateIndex < restoreIndex && restoreIndex < checkIndex && checkIndex < finalizeIndex)) {
  failures.push('scripts/safe-start.mjs: storage order must be validate -> migrate legacy -> demo recovery -> full safety check -> finalize migration.');
}

const contractSource = fs.readFileSync(path.join(root, 'scripts', 'storage-path-contract.mjs'), 'utf8');
for (const required of [
  'export function migrateLegacyStorageIfNeeded',
  'export function finalizeLegacyStorageMigration',
  `const LEGACY_MIGRATION_MARKER = '.athlyrax-legacy-storage-migration-v1.json'`,
  `path.join(paths.storageRoot, 'auth-users.json')`,
  `path.join(paths.storageRoot, 'tenants', 'clubs')`,
  'listFilesRecursive(',
  `file.relative === 'db.json'`,
  'copyExact(',
  'Legacy tenant database is unreadable, invalid or empty',
  'legacy-migration-already-finalized',
]) {
  if (!contractSource.includes(required)) failures.push(`scripts/storage-path-contract.mjs: missing migration safety token: ${required}`);
}

const safetySource = fs.readFileSync(path.join(root, 'scripts', 'storage-safety-lib.mjs'), 'utf8');
for (const required of [
  'validateDatabaseObject(',
  'validateTenantDatabaseIdentity(',
  'Refusing cross-tenant data routing',
  'validateAuthStore(',
  'validateAuthPrimaryBackupParity(',
  'validateAuthBoundTenantDatabases(',
  'Authentication primary and backup stores differ',
  'Auth-bound tenant database',
  'AUTH_REQUIRED must not be false in production',
  'PHASE1_TENANT_ISOLATION must not be false in production',
  'AUTH_ENFORCE_CANONICAL_STORE must not be false in production',
  'AUTH_SECRET must be explicitly configured with at least 32 characters in production',
  'STRIPE_WEBHOOK_SECRET is required in production whenever STRIPE_SECRET_KEY is configured',
  'AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE must be false in production',
  'requireNonEmpty',
  'must not be empty in production',
  'must contain at least one user in production',
  'Global database',
  'Authentication user store is not valid JSON',
  'Authentication user backup',
  `storageRoot: resolvedStorageRoot`,
  `crypto.randomBytes(6).toString('hex')`,
  `fsModule.fsyncSync(fileHandle)`,
  `fsModule.renameSync(tempPath, markerPath)`,
]) {
  if (!safetySource.includes(required)) failures.push(`scripts/storage-safety-lib.mjs: missing production safety token: ${required}`);
}

const dataSafetySource = fs.readFileSync(path.join(root, 'scripts', 'data-safety-preload.mjs'), 'utf8');
for (const required of [
  'ATHLYRAX_CURRENT_DB_INVALID',
  'ATHLYRAX_INCOMING_DB_INVALID',
  'ATHLYRAX_DB_BACKUP_VERIFICATION_FAILED',
  'invalid-current-blocked',
  'sourceBytes.equals(backupBytes)',
]) {
  if (!dataSafetySource.includes(required)) failures.push(`scripts/data-safety-preload.mjs: missing database corruption guard token: ${required}`);
}

const durablePatchSource = fs.readFileSync(path.join(root, 'scripts', 'patch-durable-storage-writes.mjs'), 'utf8');
for (const required of [
  'ATHLYRAX_DURABLE_ATOMIC_JSON_WRITES',
  `crypto.randomBytes(6).toString('hex')`,
  `fs.openSync(tmpPath, 'wx', 0o600)`,
  `fs.fsyncSync(fileHandle)`,
  `fs.fsyncSync(directoryHandle)`,
]) {
  if (!durablePatchSource.includes(required)) failures.push(`scripts/patch-durable-storage-writes.mjs: missing durable-write token: ${required}`);
}

const approvalSource = fs.readFileSync(path.join(root, 'scripts', 'approve-storage-layout.mjs'), 'utf8');
for (const required of [
  `assertAuthStore(paths.authUsers, 'Authentication user store')`,
  `assertAuthStore(paths.authUsersBackup, 'Authentication user backup')`,
  `assertDbObject(paths.globalDb, 'Global database')`,
]) {
  if (!approvalSource.includes(required)) failures.push(`scripts/approve-storage-layout.mjs: missing approval validation token: ${required}`);
}

const patchSource = fs.readFileSync(path.join(root, 'scripts', 'patch-canonical-storage-contract.mjs'), 'utf8');
for (const required of [
  `const authFailClosedMarker = \`// ATHLYRAX_PRODUCTION_AUTH_STORE_FAIL_CLOSED\`;`,
  `const authAtomicMarker = \`// ATHLYRAX_AUTH_BOOTSTRAP_ATOMIC_WRITES\`;`,
  `const inviteFailClosedMarker = \`// ATHLYRAX_AUTH_INVITES_FAIL_CLOSED\`;`,
  `const stripeWebhookMarker = \`// ATHLYRAX_STRIPE_WEBHOOK_SIGNATURE_REQUIRED\`;`,
  `Render runtime requires NODE_ENV=production`,
  `Production authentication store is empty. Refusing backup/environment/default account fallback.`,
  `Authentication invite store is unreadable or invalid. Refusing to replace it with an empty file.`,
  `Stripe webhook signature is required.`,
  `Stripe webhook verification is not configured.`,
  `.replaceAll('writeJsonFile(AUTH_USERS_PATH,', 'writeAtomicJsonFile(AUTH_USERS_PATH,')`,
  `writeAtomicJsonFile(AUTH_INVITES_PATH, [])`,
  `const registrationMarker = \`// ATHLYRAX_NEW_TENANT_DB_PROVISION\`;`,
  `registrationTenantStorage = resolveStoragePathsForTenantKey(tenantId)`,
  `invited_tenant_database_missing`,
  `registrationTenantDbCreated = true`,
  `try { persistAuthUsers(); } catch {}`,
  `try { persistAuthInvites(); } catch {}`,
  `provisioningToken: registrationTenantProvisioningToken`,
]) {
  if (!patchSource.includes(required)) failures.push(`scripts/patch-canonical-storage-contract.mjs: missing registration/auth/webhook safety token: ${required}`);
}

const legalSource = fs.readFileSync(path.join(root, 'scripts', 'signup-legal-acceptance-preload.mjs'), 'utf8');
for (const required of [
  `path.join(resolveStorageRoot(), 'legal-acceptances.jsonl')`,
  `AUTH_LEGAL_ACCEPTANCE_PATH must equal the canonical path`,
]) {
  if (!legalSource.includes(required)) failures.push(`scripts/signup-legal-acceptance-preload.mjs: missing canonical legal-storage token: ${required}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const postinstall = String(packageJson?.scripts?.postinstall || '');
const start = String(packageJson?.scripts?.start || '');
const storageAll = String(packageJson?.scripts?.['test:storage-all'] || '');
for (const requiredPatch of ['patch-canonical-storage-contract.mjs', 'patch-persistence-integrity.mjs', 'patch-durable-storage-writes.mjs']) {
  if (!postinstall.includes(requiredPatch)) failures.push(`package.json: postinstall is missing ${requiredPatch}.`);
}
if (postinstall.includes('patch-tenant-storage-path.mjs')) failures.push('package.json: obsolete tenant-storage patch is still wired into postinstall.');
if (Object.prototype.hasOwnProperty.call(packageJson?.scripts || {}, 'start:unsafe')) failures.push('package.json: start:unsafe bypass must not exist.');
if (!start.includes('test:storage-all') || !start.includes('safe-start.mjs')) failures.push('package.json: production start must run the full storage test suite and safe-start.');
for (const requiredScript of ['test:storage-safety', 'test:data-safety', 'test:persistence-integrity', 'test:storage-routing-safety', 'test:storage-path-contract', 'test:signup-legal-acceptance', 'test:closed-pilot-backup-restore', 'test:closed-pilot-security', 'audit:storage-paths']) {
  if (!storageAll.includes(requiredScript)) failures.push(`package.json: test:storage-all is missing ${requiredScript}.`);
}

for (const requiredTest of ['tests/data-safety.test.mjs', 'tests/persistence-integrity.test.mjs', 'tests/storage-routing-safety.test.mjs']) {
  if (!fs.existsSync(path.join(root, requiredTest))) failures.push(`${requiredTest} is missing.`);
}

if (failures.length) {
  console.error('ATHLYRAX_STORAGE_PATH_AUDIT_FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('ATHLYRAX_STORAGE_PATH_AUDIT_OK');
