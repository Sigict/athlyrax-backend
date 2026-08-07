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
const requireTokens = (relative, tokens) => {
  const source = read(relative);
  for (const token of tokens) if (!source.includes(token)) failures.push(`${relative}: missing required token: ${token}`);
  return source;
};

const indexSource = requireTokens('index.js', [
  `path.join(STORAGE_ROOT, 'tenants')`,
  `path.join(STORAGE_ROOT, 'auth', 'auth-users.json')`,
  `action: 'tenant_database_missing'`,
  `// ATHLYRAX_CANONICAL_STORAGE_RUNTIME_GUARD`,
  `// ATHLYRAX_PRODUCTION_AUTH_STORE_FAIL_CLOSED`,
  `// ATHLYRAX_AUTH_INVITES_FAIL_CLOSED`,
  `// ATHLYRAX_STRIPE_WEBHOOK_SIGNATURE_REQUIRED`,
  `// ATHLYRAX_FAIL_CLOSED_MISSING_TENANT_WRITE`,
  `// ATHLYRAX_NEW_TENANT_DB_PROVISION`,
  `// ATHLYRAX_SNAPSHOT_HISTORY_NO_SILENT_TRUNCATION`,
  `// ATHLYRAX_DURABLE_ATOMIC_JSON_WRITES`,
  `globalThis[Symbol.for('athlyrax.safeStartEnforced')] === true`,
  `Direct index.js startup is refused.`,
  `crypto.createHmac('sha256', AUTH_SECRET).update(path.resolve(registrationTenantStorage.dbPath)).digest('hex')`,
]);
for (const forbidden of [
  `path.join(STORAGE_ROOT, 'tenants', 'clubs')`,
  `path.join(STORAGE_ROOT, 'auth-users.json')`,
  `writeAtomicJsonFile(storagePaths.dbPath, {});`,
  `writeJsonFile(AUTH_USERS_PATH,`,
  `writeJsonFile(AUTH_USERS_BACKUP_PATH,`,
  `snapshotSubmissions.length = 5000;`,
  `runtimeLegacyMigration = migrateLegacyStorageIfNeeded({`,
  `runStorageSafetyCheck({ repoRoot: __dirname, requireFiles: true, createDirectories: true })`,
  `const registrationTenantProvisioningToken = crypto.randomUUID();`,
  `process.env.ATHLYRAX_SAFE_START_ENFORCED`,
]) if (indexSource.includes(forbidden)) failures.push(`index.js: forbidden legacy/destructive token remains: ${forbidden}`);

const safeStart = requireTokens('scripts/safe-start.mjs', [
  `Safe production start requires NODE_ENV=production`,
  `resolveStorageConfiguration(process.env, repoRoot)`,
  `assertCanonicalPathContract({`,
  `validateRequiredStorageFiles(`,
  `applyCanonicalAuthPaths(`,
  `fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK)`,
  `globalThis[Symbol.for('athlyrax.safeStartEnforced')] = true`,
]);
for (const forbidden of [
  'runStorageSafetyCheck(',
  'ensureStorageDirectories(',
  'ensureWritableDirectory(',
  'migrateLegacyStorageIfNeeded(',
  'restoreBundledDemoTenantIfNeeded(',
  'finalizeLegacyStorageMigration(',
  'writeStorageReadyMarker(',
  'writeFileSync(',
  'copyFileSync(',
  'mkdirSync(',
  'renameSync(',
  'unlinkSync(',
]) if (safeStart.includes(forbidden)) failures.push(`scripts/safe-start.mjs: normal startup must be read-only; forbidden token: ${forbidden}`);

requireTokens('scripts/production-start.mjs', [
  `ATHLYRAX_STORAGE_MIGRATION_APPROVAL`,
  `MIGRATE_CANONICAL_STORAGE_ONCE`,
  `migrationAlreadyCompleted`,
  `migrate-storage-once.mjs`,
  `safe-start.mjs`,
  `invalid value`,
]);

const migration = requireTokens('scripts/migrate-storage-once.mjs', [
  `MIGRATE_CANONICAL_STORAGE_ONCE`,
  `Refusing to manufacture a backup from the primary store`,
  `migrateLegacyStorageIfNeeded({`,
  `restoreBundledDemoTenantIfNeeded({`,
  `sanitizeDemoTenantDatabase({`,
  `writeStorageReadyMarker(`,
  `runStorageSafetyCheck({`,
  `finalizeLegacyStorageMigration({`,
  `restorePreviousReadyMarker`,
  `ATHLYRAX_STORAGE_MIGRATION_OK`,
]);
const migrationOrder = [
  migration.indexOf('migrateLegacyStorageIfNeeded({'),
  migration.indexOf('restoreBundledDemoTenantIfNeeded({'),
  migration.indexOf('sanitizeDemoTenantDatabase({'),
  migration.indexOf('writeStorageReadyMarker('),
  migration.indexOf('runStorageSafetyCheck({'),
  migration.indexOf('finalizeLegacyStorageMigration({'),
];
if (migrationOrder.some((value) => value < 0) || !migrationOrder.every((value, index) => index === 0 || value > migrationOrder[index - 1])) {
  failures.push('scripts/migrate-storage-once.mjs: expected migrate -> demo recovery -> demo sanitization -> marker -> full check -> finalize ordering.');
}

requireTokens('scripts/demo-data-sanitizer.mjs', [
  `demo-pre-sanitization`,
  `demoDataSynthetic`,
  `tenantId: 'demo-company'`,
  `containsObviousPersonalData`,
  `syntheticUsername`,
  `filedataurl`,
  `example.invalid`,
  `Demo sanitization verification failed`,
]);
requireTokens('scripts/patch-runtime-start-guard.mjs', [
  `globalThis[Symbol.for('athlyrax.safeStartEnforced')] === true`,
  `Direct index.js startup is refused.`,
  `runtimeLegacyMigration = migrateLegacyStorageIfNeeded({`,
  `process.env.ATHLYRAX_SAFE_START_ENFORCED`,
]);
requireTokens('scripts/patch-provisioning-integrity.mjs', [
  `crypto.createHmac('sha256', authSecret).update(destination).digest('hex')`,
  `crypto.timingSafeEqual`,
  `discardedProvisioningToken`,
  `crypto.createHmac('sha256', AUTH_SECRET).update(path.resolve(registrationTenantStorage.dbPath)).digest('hex')`,
]);
requireTokens('scripts/storage-path-contract.mjs', [
  `const LEGACY_MIGRATION_MARKER = '.athlyrax-legacy-storage-migration-v1.json'`,
  `path.join(paths.storageRoot, 'tenants', 'clubs')`,
  `Refusing cross-tenant migration or recovery`,
  `legacy-migration-already-finalized`,
  `copyExact(`,
]);
requireTokens('scripts/storage-safety-lib.mjs', [
  `Invalid or noncanonical tenant key in ATHLYRAX_REQUIRED_TENANTS`,
  `Refusing cross-tenant data routing`,
  `Authentication primary and backup stores differ`,
  `Storage approval marker is not bound to this storage root`,
  `AUTH_REQUIRED must not be false in production`,
  `PHASE1_TENANT_ISOLATION must not be false in production`,
  `AUTH_SECRET must be explicitly configured with at least 32 characters in production`,
  `STRIPE_WEBHOOK_SECRET is required in production whenever STRIPE_SECRET_KEY is configured`,
]);
requireTokens('scripts/data-safety-preload.mjs', [
  `ATHLYRAX_MISSING_DB_CREATE_BLOCKED`,
  `ATHLYRAX_CURRENT_DB_INVALID`,
  `ATHLYRAX_INCOMING_DB_INVALID`,
  `ATHLYRAX_DB_BACKUP_VERIFICATION_FAILED`,
  `crypto.createHmac('sha256', authSecret).update(destination).digest('hex')`,
  `crypto.timingSafeEqual`,
  `discardedProvisioningToken`,
]);
requireTokens('scripts/patch-persistence-integrity.mjs', [
  `ATHLYRAX_SNAPSHOT_SUBMISSIONS_FAIL_CLOSED`,
  `ATHLYRAX_SNAPSHOT_HISTORY_NO_SILENT_TRUNCATION`,
  `ATHLYRAX_BILLING_CATALOG_FAIL_CLOSED`,
  `ATHLYRAX_PRODUCTION_PASSWORD_RESET_NO_CONSOLE`,
]);
requireTokens('scripts/patch-durable-storage-writes.mjs', [
  `ATHLYRAX_DURABLE_ATOMIC_JSON_WRITES`,
  `fs.openSync(tmpPath, 'wx', 0o600)`,
  `fs.fsyncSync(fileHandle)`,
]);
requireTokens('scripts/signup-legal-acceptance-preload.mjs', [
  `AUTH_LEGAL_ACCEPTANCE_PATH must equal the canonical path`,
  `Legal acceptance append verification failed.`,
]);

const pkg = JSON.parse(read('package.json') || '{}');
const postinstall = String(pkg?.scripts?.postinstall || '');
const start = String(pkg?.scripts?.start || '');
const migrateCommand = String(pkg?.scripts?.['migrate:storage-once'] || '');
const storageAll = String(pkg?.scripts?.['test:storage-all'] || '');
for (const patch of [
  'patch-canonical-storage-contract.mjs',
  'patch-provisioning-integrity.mjs',
  'patch-persistence-integrity.mjs',
  'patch-durable-storage-writes.mjs',
  'patch-runtime-start-guard.mjs',
]) {
  if (!postinstall.includes(patch)) failures.push(`package.json: postinstall missing ${patch}.`);
}
if (Object.prototype.hasOwnProperty.call(pkg?.scripts || {}, 'start:unsafe')) failures.push('package.json: start:unsafe must not exist.');
if (!start.includes('test:storage-all') || !start.includes('production-start.mjs')) failures.push('package.json: production start must run full tests and the guarded production wrapper.');
if (start.includes('migrate:storage-once') || start.includes('migrate-storage-once.mjs')) failures.push('package.json: start command must not invoke migration directly.');
if (!migrateCommand.includes('migrate-storage-once.mjs')) failures.push('package.json: explicit migrate:storage-once command is missing.');
for (const requiredTest of [
  'test:storage-safety',
  'test:data-safety',
  'test:persistence-integrity',
  'test:storage-routing-safety',
  'test:storage-migration-identity',
  'test:storage-extra-invariants',
  'test:startup-mutation-safety',
  'test:storage-path-contract',
  'test:signup-legal-acceptance',
  'test:closed-pilot-backup-restore',
  'test:closed-pilot-security',
  'audit:storage-paths',
]) if (!storageAll.includes(requiredTest)) failures.push(`package.json: test:storage-all missing ${requiredTest}.`);

for (const relative of [
  'tests/data-safety.test.mjs',
  'tests/persistence-integrity.test.mjs',
  'tests/storage-routing-safety.test.mjs',
  'tests/storage-migration-identity.test.mjs',
  'tests/storage-extra-invariants.test.mjs',
  'tests/startup-mutation-safety.test.mjs',
]) if (!fs.existsSync(path.join(root, relative))) failures.push(`Missing required test: ${relative}`);

if (failures.length) {
  console.error('ATHLYRAX_STORAGE_PATH_AUDIT_FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('ATHLYRAX_STORAGE_PATH_AUDIT_OK');
