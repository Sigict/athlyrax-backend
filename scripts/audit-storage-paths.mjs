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
];

const failures = [];
const forbiddenByFile = new Map([
  ['index.js', [
    `path.join(STORAGE_ROOT, 'tenants', 'clubs')`,
    `path.join(STORAGE_ROOT, 'auth-users.json')`,
    `writeAtomicJsonFile(storagePaths.dbPath, {});`,
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
  `// ATHLYRAX_FAIL_CLOSED_MISSING_TENANT_WRITE`,
  `// ATHLYRAX_NEW_TENANT_DB_PROVISION`,
  `Render runtime requires NODE_ENV=production`,
  `Production authentication store is empty. Refusing backup/environment/default account fallback.`,
  `resolveStorageConfiguration(process.env, __dirname)`,
  `runtimeLegacyMigration = migrateLegacyStorageIfNeeded({`,
  `restoreBundledDemoTenantIfNeeded({`,
  `runStorageSafetyCheck({`,
  `finalizeLegacyStorageMigration({`,
  `registrationTenantStorage = resolveStoragePathsForTenantKey(tenantId)`,
  `invited_tenant_database_missing`,
  `provisioningToken: registrationTenantProvisioningToken`,
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
  'validateAuthStore(',
  'requireNonEmpty',
  'must not be empty in production',
  'must contain at least one user in production',
  'Global database',
  'Authentication user store is not valid JSON',
  'Authentication user backup',
]) {
  if (!safetySource.includes(required)) failures.push(`scripts/storage-safety-lib.mjs: missing JSON validation token: ${required}`);
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
  `Render runtime requires NODE_ENV=production`,
  `Production authentication store is empty. Refusing backup/environment/default account fallback.`,
  `const registrationMarker = \`// ATHLYRAX_NEW_TENANT_DB_PROVISION\`;`,
  `registrationTenantStorage = resolveStoragePathsForTenantKey(tenantId)`,
  `invited_tenant_database_missing`,
  `registrationTenantDbCreated = true`,
  `try { persistAuthUsers(); } catch {}`,
  `try { persistAuthInvites(); } catch {}`,
  `provisioningToken: registrationTenantProvisioningToken`,
]) {
  if (!patchSource.includes(required)) failures.push(`scripts/patch-canonical-storage-contract.mjs: missing registration/auth safety token: ${required}`);
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
if (!postinstall.includes('patch-canonical-storage-contract.mjs')) failures.push('package.json: canonical storage patch is not wired into postinstall.');
if (postinstall.includes('patch-tenant-storage-path.mjs')) failures.push('package.json: obsolete tenant-storage patch is still wired into postinstall.');
if (Object.prototype.hasOwnProperty.call(packageJson?.scripts || {}, 'start:unsafe')) failures.push('package.json: start:unsafe bypass must not exist.');
if (!start.includes('test:storage-all') || !start.includes('safe-start.mjs')) failures.push('package.json: production start must run the full storage test suite and safe-start.');
for (const requiredScript of ['test:storage-safety', 'test:storage-path-contract', 'test:signup-legal-acceptance', 'test:closed-pilot-backup-restore', 'test:closed-pilot-security', 'audit:storage-paths']) {
  if (!storageAll.includes(requiredScript)) failures.push(`package.json: test:storage-all is missing ${requiredScript}.`);
}

if (failures.length) {
  console.error('ATHLYRAX_STORAGE_PATH_AUDIT_FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('ATHLYRAX_STORAGE_PATH_AUDIT_OK');
