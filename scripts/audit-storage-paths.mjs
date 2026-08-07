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
const requireAll = (relative, tokens) => {
  const source = read(relative);
  for (const token of tokens) if (!source.includes(token)) failures.push(`${relative}: missing required token: ${token}`);
  return source;
};
const forbidAll = (relative, tokens) => {
  const source = read(relative);
  for (const token of tokens) if (source.includes(token)) failures.push(`${relative}: forbidden token remains: ${token}`);
  return source;
};

requireAll('index.js', [
  `path.join(STORAGE_ROOT, 'tenants')`,
  `path.join(STORAGE_ROOT, 'auth', 'auth-users.json')`,
  `action: 'tenant_database_missing'`,
  `// ATHLYRAX_CANONICAL_STORAGE_RUNTIME_GUARD`,
  `globalThis[Symbol.for('athlyrax.safeStartEnforced')] === true`,
  `// ATHLYRAX_PRODUCTION_AUTH_STORE_FAIL_CLOSED`,
  `// ATHLYRAX_AUTH_INVITES_FAIL_CLOSED`,
  `// ATHLYRAX_FAIL_CLOSED_MISSING_TENANT_WRITE`,
  `// ATHLYRAX_NEW_TENANT_DB_PROVISION`,
  `// ATHLYRAX_SNAPSHOT_HISTORY_NO_SILENT_TRUNCATION`,
  `// ATHLYRAX_SNAPSHOT_HISTORY_EMPTY_WIPE_BLOCKED`,
  `// ATHLYRAX_AUTH_PAIRED_PERSISTENCE_TRANSACTION`,
  `// ATHLYRAX_PRODUCTION_DEFAULT_AUTH_USERS_DISABLED`,
  `const DEFAULT_AUTH_USERS = IS_PRODUCTION ? [] : [`,
  `// ATHLYRAX_DURABLE_ATOMIC_JSON_WRITES`,
]);
forbidAll('index.js', [
  `path.join(STORAGE_ROOT, 'tenants', 'clubs')`,
  `path.join(STORAGE_ROOT, 'auth-users.json')`,
  `writeAtomicJsonFile(storagePaths.dbPath, {});`,
  `runtimeLegacyMigration = migrateLegacyStorageIfNeeded({`,
  `process.env.ATHLYRAX_SAFE_START_ENFORCED`,
  `const registrationTenantProvisioningToken = crypto.randomUUID();`,
  `// ATHLYRAX_AUTH_STORE_PAIR_TRANSACTION`,
]);

requireAll('scripts/patch-canonical-storage-contract.mjs', [
  `globalThis[Symbol.for('athlyrax.safeStartEnforced')] === true`,
  `CANONICAL_STORAGE_CONTRACT_OK`,
  `Refusing startup-time auth mutation.`,
  `Authentication invite store is missing. Refusing startup-time creation.`,
  `ATHLYRAX_NO_PRODUCTION_STARTUP_AUTOHEAL`,
  `ATHLYRAX_PRODUCTION_BILLING_EMAIL_NO_CONSOLE`,
  `crypto.createHmac('sha256', AUTH_SECRET).update(path.resolve(registrationTenantStorage.dbPath)).digest('hex')`,
]);
forbidAll('scripts/patch-canonical-storage-contract.mjs', [
  `runtimeLegacyMigration = migrateLegacyStorageIfNeeded({`,
  `process.env.ATHLYRAX_SAFE_START_ENFORCED`,
  `crypto.randomUUID();`,
]);

requireAll('scripts/patch-persistence-integrity.mjs', [
  `ATHLYRAX_PRODUCTION_STORAGE_LAYOUT_READ_ONLY`,
  `ATHLYRAX_AUTH_PERSISTENCE_SINGLE_OWNER`,
  `if (IS_PRODUCTION) return;`,
  `ATHLYRAX_SNAPSHOT_SUBMISSIONS_FAIL_CLOSED`,
  `ATHLYRAX_SNAPSHOT_HISTORY_EMPTY_WIPE_BLOCKED`,
  `Snapshot submissions store is missing. Refusing startup-time creation.`,
  `ATHLYRAX_SNAPSHOT_HISTORY_NO_SILENT_TRUNCATION`,
  `ATHLYRAX_BILLING_CATALOG_FAIL_CLOSED`,
  `Refusing startup-time recovery, normalization or default bootstrap.`,
  `ATHLYRAX_PRODUCTION_PASSWORD_RESET_NO_CONSOLE`,
]);
forbidAll('scripts/patch-persistence-integrity.mjs', [
  `ATHLYRAX_AUTH_STORE_PAIR_TRANSACTION`,
  `function persistAuthUsers() {\n// ATHLYRAX_AUTH_STORE_PAIR_TRANSACTION`,
]);
requireAll('scripts/patch-auth-persistence-transaction.mjs', [
  `ATHLYRAX_AUTH_PAIRED_PERSISTENCE_TRANSACTION`,
  `Authentication primary/backup verification failed after persistence.`,
  `restorePrevious(AUTH_USERS_PATH`,
  `restorePrevious(AUTH_USERS_BACKUP_PATH`,
]);
requireAll('scripts/patch-auth-enumeration-safety.mjs', [
  `ATHLYRAX_PRODUCTION_DEFAULT_AUTH_USERS_DISABLED`,
  `const DEFAULT_AUTH_USERS = IS_PRODUCTION ? [] : [`,
  `ATHLYRAX_AUTH_IDENTIFIER_AMBIGUITY_SAFE`,
  `ATHLYRAX_ONBOARDING_EMAIL_UNIQUENESS`,
]);

requireAll('scripts/safe-start.mjs', [
  `validateRequiredStorageFiles(`,
  `applyCanonicalAuthPaths(`,
  `assertNoSymlinkStorageLayout(`,
  `assertNoActiveMigrationTransaction(`,
  `globalThis[Symbol.for('athlyrax.safeStartEnforced')] = true`,
]);
forbidAll('scripts/safe-start.mjs', [
  'runStorageSafetyCheck(', 'migrateLegacyStorageIfNeeded(', 'restoreBundledDemoTenantIfNeeded(',
  'finalizeLegacyStorageMigration(', 'writeStorageReadyMarker(', 'writeFileSync(', 'copyFileSync(',
  'mkdirSync(', 'renameSync(', 'unlinkSync(',
]);

requireAll('scripts/storage-path-integrity.mjs', [
  `ATHLYRAX_STORAGE_SYMLINK_BLOCKED`, `realpathSync`, `lstatSync`, `isSymbolicLink()`, `assertNoSymlinkStorageLayout`,
]);
requireAll('scripts/migration-transaction-state.mjs', [
  `ACTIVE_MIGRATION_TRANSACTION_FILE`,
  `ATHLYRAX_MIGRATION_TRANSACTION_INCOMPLETE`,
  `ATHLYRAX_MIGRATION_TRANSACTION_JOURNAL_INVALID`,
]);

requireAll('scripts/storage-safety-lib.mjs', [
  `authInvitesPath`, `snapshotSubmissionsPath`, `billingCatalogPath`,
  `validateJsonArray(configuration.authInvitesPath`,
  `validateJsonArray(configuration.snapshotSubmissionsPath`,
  `validateBillingCatalog(configuration.billingCatalogPath`,
  `validateAuthPrimaryBackupParity`, `validateAuthBoundTenantDatabases`,
  `contains duplicate usernames`, `has noncanonical tenantId`,
  `Demo tenant database demo-company contains no meaningful demo records`,
  `Storage approval marker is not bound to this storage root`,
  `AUTH_SECRET must be explicitly configured with at least 32 characters in production`,
]);

requireAll('scripts/approve-storage-layout.mjs', [
  `assertNoSymlinkStorageLayout(`, `assertNoActiveMigrationTransaction(`,
  `assertJsonArray(paths.authInvites`, `assertJsonArray(paths.snapshotSubmissions`,
  `assertBillingCatalog(paths.billingCatalog`, `contains duplicate plan keys`, `contains duplicate username`,
  `authBoundTenants`, `requiredTenants = [...new Set`, `writeStorageReadyMarker`,
]);
requireAll('scripts/stage-storage-restore.mjs', [
  `assertRegularNonSymlinkFile`, `assertSafeDestination`, `requireCanonicalTenantId`,
  `isSymbolicLink()`, `fs.fsyncSync(handle)`, `Staged copy verification failed`,
  `Production activation: NOT PERFORMED`,
]);
requireAll('scripts/check-storage-safety.mjs', [
  `if (!production)`, `assertNoSymlinkStorageLayout(`, `assertNoActiveMigrationTransaction(`,
  `validateRequiredStorageFiles(`, `ATHLYRAX_STORAGE_SAFETY_CHECK_FAILED`,
]);

requireAll('scripts/production-start.mjs', [
  `ATHLYRAX_STORAGE_MIGRATION_APPROVAL`, `MIGRATE_CANONICAL_STORAGE_ONCE`,
  `migrationAlreadyCompleted`, `readActiveMigrationTransaction`,
  `ATHLYRAX_ONE_TIME_MIGRATION_APPROVAL_MUST_BE_REMOVED`,
  `if (interrupted)`, `else if (completed)`,
  `Remove ATHLYRAX_STORAGE_MIGRATION_APPROVAL before normal production startup`,
  `migrate-storage-once.mjs`, `safe-start.mjs`,
]);
forbidAll('scripts/production-start.mjs', [`interrupted || !completed`]);
requireAll('scripts/migrate-storage-once.mjs', [
  `MIGRATE_CANONICAL_STORAGE_ONCE`, `beginTransaction(`, `rollbackTransaction(`,
  `recoverInterruptedTransaction(`, `activeMigrationTransactionPath(`,
  `assertNoSymlinkStorageLayout(`, `transaction-manifest.json`,
  `migrateLegacyStorageIfNeeded({`, `restoreBundledDemoTenantIfNeeded({`,
  `sanitizeDemoTenantDatabase({`, `writeStorageReadyMarker(`, `runStorageSafetyCheck({`,
  `finalizeLegacyStorageMigration({`, `Migration failed; original storage was restored`,
]);
requireAll('scripts/storage-path-contract.mjs', [
  `legacy-migration-already-finalized`, `Refusing cross-tenant migration or recovery`,
  `Refusing to manufacture a backup baseline from the primary store`,
  `Canonical demo-company database exists but contains no meaningful demo records`,
  `validMeaningfulDemoDatabase`,
]);
forbidAll('scripts/storage-path-contract.mjs', [`kind: 'auth-users-backup-baseline'`]);

requireAll('scripts/data-safety-preload.mjs', [
  `ATHLYRAX_MISSING_DB_CREATE_BLOCKED`, `ATHLYRAX_CURRENT_DB_INVALID`, `ATHLYRAX_INCOMING_DB_INVALID`,
  `ATHLYRAX_DB_TENANT_IDENTITY_CONFLICT`, `ATHLYRAX_DB_TOTAL_DATA_WIPE_BLOCKED`,
  `ATHLYRAX_SNAPSHOT_HISTORY_EMPTY_WIPE_BLOCKED`, `expectedTenantIdForDbPath`,
  `hasValidProvisioningProof`, `timingSafeEqual`, `provisioningToken: _discardedProvisioningToken`,
  `fsModule.fsyncSync(handle)`,
]);
requireAll('scripts/demo-data-sanitizer.mjs', [
  `demoDataSynthetic`, `tenantId: 'demo-company'`, `containsObviousPersonalData`, `Demo sanitization verification failed`,
]);
requireAll('scripts/patch-durable-storage-writes.mjs', [
  `ATHLYRAX_DURABLE_ATOMIC_JSON_WRITES`, `fs.openSync(tmpPath, 'wx', 0o600)`,
  `fs.fsyncSync(fileHandle)`, `fs.renameSync(tmpPath, filePath)`,
]);

const build = requireAll('scripts/build-production-backend.mjs', [
  `patch-index-signup-legal.mjs`, `patch-logout-csrf.mjs`, `patch-canonical-storage-contract.mjs`,
  `patch-persistence-integrity.mjs`, `patch-auth-persistence-transaction.mjs`, `patch-durable-storage-writes.mjs`,
  `patch-coach-link-suite.mjs`, `--check`, `audit-storage-paths.mjs`, `ATHLYRAX_PRODUCTION_BACKEND_BUILD_OK`,
]);
if (build.includes('patch-runtime-start-guard.mjs') && !build.includes('Obsolete production patch')) {
  failures.push('scripts/build-production-backend.mjs: obsolete patch is referenced as an active transform.');
}
for (const obsolete of ['scripts/patch-runtime-start-guard.mjs', 'scripts/patch-provisioning-integrity.mjs', 'scripts/patch-tenant-storage-path.mjs']) {
  if (fs.existsSync(path.join(root, obsolete))) failures.push(`Obsolete patch file must be removed: ${obsolete}`);
}

const pkg = JSON.parse(read('package.json') || '{}');
const postinstall = String(pkg?.scripts?.postinstall || '');
const start = String(pkg?.scripts?.start || '');
const storageAll = String(pkg?.scripts?.['test:storage-all'] || '');
if (postinstall !== 'node scripts/build-production-backend.mjs') failures.push('package.json: postinstall must use only the verified production build orchestrator.');
for (const obsolete of ['patch-runtime-start-guard.mjs', 'patch-provisioning-integrity.mjs', 'patch-tenant-storage-path.mjs']) {
  if (postinstall.includes(obsolete)) failures.push(`package.json: obsolete postinstall patch remains: ${obsolete}`);
}
if (!start.includes('test:storage-all') || !start.includes('production-start.mjs')) failures.push('package.json: guarded production start is not enforced.');
if (start.includes('migrate-storage-once.mjs')) failures.push('package.json: normal start must not invoke migration directly.');
for (const required of [
  'test:storage-safety', 'test:data-safety', 'test:persistence-integrity', 'test:auth-persistence-transaction',
  'test:auth-enumeration-safety', 'test:storage-routing-safety', 'test:storage-migration-identity',
  'test:storage-extra-invariants', 'test:startup-mutation-safety', 'test:storage-path-integrity',
  'test:storage-path-contract', 'test:signup-legal-acceptance', 'test:closed-pilot-backup-restore',
  'test:closed-pilot-security', 'audit:storage-paths',
]) if (!storageAll.includes(required)) failures.push(`package.json: test:storage-all missing ${required}`);

if (failures.length) {
  console.error('ATHLYRAX_STORAGE_PATH_AUDIT_FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('ATHLYRAX_STORAGE_PATH_AUDIT_OK');
