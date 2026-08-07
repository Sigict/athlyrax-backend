import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(process.cwd());
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('normal safe start is strictly read-only before backend import', () => {
  const source = read('scripts/safe-start.mjs');
  assert.match(source, /validateRequiredStorageFiles\(/);
  assert.match(source, /fs\.accessSync\(directory, fs\.constants\.R_OK \| fs\.constants\.W_OK\)/);
  assert.match(source, /assertNoSymlinkStorageLayout\(/);
  assert.match(source, /assertNoActiveMigrationTransaction\(/);
  assert.match(source, /applyCanonicalAuthPaths\(/);
  assert.match(source, /globalThis\[Symbol\.for\('athlyrax\.safeStartEnforced'\)\] = true/);
  assert.match(source, /await import\(pathToFileURL\(entryPath\)\.href\)/);
  for (const forbidden of [
    'runStorageSafetyCheck(', 'ensureStorageDirectories(', 'ensureWritableDirectory(',
    'migrateLegacyStorageIfNeeded(', 'restoreBundledDemoTenantIfNeeded(', 'finalizeLegacyStorageMigration(',
    'writeStorageReadyMarker(', 'writeFileSync(', 'copyFileSync(', 'mkdirSync(', 'renameSync(', 'unlinkSync(',
  ]) assert.ok(!source.includes(forbidden), `normal safe start must not mutate storage through ${forbidden}`);
});

test('canonical transformation makes imported production bootstrap non-mutating', () => {
  const canonical = read('scripts/patch-canonical-storage-contract.mjs');
  const persistence = read('scripts/patch-persistence-integrity.mjs');
  assert.match(canonical, /globalThis\[Symbol\.for\('athlyrax\.safeStartEnforced'\)\] === true/);
  assert.match(canonical, /Refusing startup-time auth mutation/);
  assert.match(canonical, /Authentication invite store is missing\. Refusing startup-time creation/);
  assert.match(canonical, /ATHLYRAX_NO_PRODUCTION_STARTUP_AUTOHEAL/);
  assert.match(canonical, /ATHLYRAX_PRODUCTION_BILLING_EMAIL_NO_CONSOLE/);
  assert.ok(!canonical.includes('runtimeLegacyMigration = migrateLegacyStorageIfNeeded({'));
  assert.ok(!canonical.includes('process.env.ATHLYRAX_SAFE_START_ENFORCED'));
  assert.match(persistence, /ATHLYRAX_PRODUCTION_STORAGE_LAYOUT_READ_ONLY/);
  assert.match(persistence, /if \(IS_PRODUCTION\) return/);
  assert.match(persistence, /Snapshot submissions store is missing\. Refusing startup-time creation/);
  assert.match(persistence, /ATHLYRAX_SNAPSHOT_HISTORY_EMPTY_WIPE_BLOCKED/);
  assert.match(persistence, /Refusing startup-time recovery, normalization or default bootstrap/);
});

test('production transforms have single ownership for tenant contracts and retention', () => {
  const operational = read('scripts/patch-operational-integrity.mjs');
  const authTenant = read('scripts/patch-auth-tenant-integrity.mjs');
  const retention = read('scripts/patch-runtime-data-retention.mjs');
  for (const token of ['ATHLYRAX_GLOBAL_OWNER_ROLE_TENANT_CONTRACT', 'ATHLYRAX_INVITE_GLOBAL_OWNER_FORBIDDEN']) {
    assert.ok(operational.includes(token), `operational transform must own ${token}`);
    assert.ok(authTenant.includes(token), `auth-tenant transform must verify earlier ${token}`);
  }
  assert.equal(authTenant.includes('function replaceRequired('), false, 'auth-tenant transform must not rewrite earlier creation/invite guards');
  for (const temporary of ['ATHLYRAX_PRODUCTION_AUDIT_RETENTION_NO_SILENT_DELETE', 'ATHLYRAX_PRODUCTION_DB_SNAPSHOT_RETENTION_NO_SILENT_DELETE']) {
    assert.equal(operational.includes(temporary), false, `operational transform must not install temporary retention behavior: ${temporary}`);
    assert.equal(retention.includes(temporary), true, `runtime retention must explicitly reject temporary marker: ${temporary}`);
  }
  assert.ok(retention.includes('ATHLYRAX_PRODUCTION_AUDIT_ARCHIVE_BEFORE_DELETE'));
  assert.ok(retention.includes('ATHLYRAX_BOUNDED_PRIMARY_DB_SNAPSHOT_RETENTION'));
});

test('storage validator covers every store loaded during production bootstrap and demo data', () => {
  const source = read('scripts/storage-safety-lib.mjs');
  for (const token of [
    'authInvitesPath', 'snapshotSubmissionsPath', 'billingCatalogPath',
    'validateJsonArray(configuration.authInvitesPath',
    'validateJsonArray(configuration.snapshotSubmissionsPath',
    'validateBillingCatalog(configuration.billingCatalogPath',
    'validateAuthPrimaryBackupParity', 'validateAuthBoundTenantDatabases',
    'contains duplicate usernames', 'has noncanonical tenantId',
    'Demo tenant database demo-company contains no meaningful demo records',
  ]) assert.ok(source.includes(token), `startup storage validation is missing ${token}`);
});

test('production wrapper gives interrupted migration recovery precedence and refuses stale approval after completion', () => {
  const source = read('scripts/production-start.mjs');
  assert.match(source, /ATHLYRAX_STORAGE_MIGRATION_APPROVAL/);
  assert.match(source, /MIGRATE_CANONICAL_STORAGE_ONCE/);
  assert.match(source, /migrationAlreadyCompleted/);
  assert.match(source, /readActiveMigrationTransaction/);
  assert.match(source, /ATHLYRAX_ONE_TIME_MIGRATION_APPROVAL_MUST_BE_REMOVED/);
  assert.match(source, /if \(interrupted\)/);
  assert.match(source, /else if \(completed\)/);
  assert.match(source, /Remove ATHLYRAX_STORAGE_MIGRATION_APPROVAL before normal production startup/);
  assert.doesNotMatch(source, /interrupted \|\| !completed/);
  assert.match(source, /migrate-storage-once\.mjs/);
  assert.match(source, /safe-start\.mjs/);
  assert.match(source, /invalid value/);
});

test('storage migration is explicit, crash-recoverable, transactional, ordered and sanitizes demo before activation', () => {
  const source = read('scripts/migrate-storage-once.mjs');
  for (const token of [
    'MIGRATE_CANONICAL_STORAGE_ONCE', 'recoverInterruptedTransaction(', 'beginTransaction(', 'rollbackTransaction(',
    'activeMigrationTransactionPath(', 'transaction-manifest.json', 'assertNoSymlinkStorageLayout(',
    'migrateLegacyStorageIfNeeded({', 'restoreBundledDemoTenantIfNeeded({',
    'sanitizeDemoTenantDatabase({', 'writeStorageReadyMarker(', 'runStorageSafetyCheck({',
    'finalizeLegacyStorageMigration({', 'Migration failed; original storage was restored',
  ]) assert.ok(source.includes(token), `migration safety token missing: ${token}`);
  const order = [
    source.indexOf('beginTransaction('),
    source.indexOf('migrateLegacyStorageIfNeeded({'),
    source.indexOf('restoreBundledDemoTenantIfNeeded({'),
    source.indexOf('sanitizeDemoTenantDatabase({'),
    source.indexOf('writeStorageReadyMarker('),
    source.indexOf('runStorageSafetyCheck({'),
    source.indexOf('finalizeLegacyStorageMigration({'),
  ];
  assert.ok(order.every((value) => value >= 0));
  assert.ok(order.every((value, index) => index === 0 || value > order[index - 1]));
});

test('storage approval rejects ambiguous path state before marker creation', () => {
  const source = read('scripts/approve-storage-layout.mjs');
  assert.match(source, /assertNoSymlinkStorageLayout\(/);
  assert.match(source, /assertNoActiveMigrationTransaction\(/);
  assert.match(source, /contains duplicate username/);
  assert.match(source, /contains duplicate plan keys/);
});

test('production storage check is read-only and uses the same path safety gates', () => {
  const source = read('scripts/check-storage-safety.mjs');
  assert.match(source, /if \(!production\)/);
  assert.match(source, /assertNoSymlinkStorageLayout\(/);
  assert.match(source, /assertNoActiveMigrationTransaction\(/);
  assert.match(source, /validateRequiredStorageFiles\(/);
});

test('demo recovery rejects metadata-only canonical demo and requires real demo records', () => {
  const source = read('scripts/storage-path-contract.mjs');
  assert.match(source, /Canonical demo-company database exists but contains no meaningful demo records/);
  assert.match(source, /validMeaningfulDemoDatabase/);
  assert.match(source, /hasMeaningfulDemoData\(liveState\.payload\)/);
});

test('approval marker validates all startup stores and all auth-bound tenants', () => {
  const source = read('scripts/approve-storage-layout.mjs');
  assert.match(source, /assertJsonArray\(paths\.authInvites/);
  assert.match(source, /assertJsonArray\(paths\.snapshotSubmissions/);
  assert.match(source, /assertBillingCatalog\(paths\.billingCatalog/);
  assert.match(source, /authBoundTenants/);
  assert.match(source, /requiredTenants = \[\.\.\.new Set/);
});

test('demo sanitizer preserves a safety copy and rejects remaining personal data', () => {
  const source = read('scripts/demo-data-sanitizer.mjs');
  assert.match(source, /demo-pre-sanitization/);
  assert.match(source, /demoDataSynthetic/);
  assert.match(source, /tenantId: 'demo-company'/);
  assert.match(source, /containsObviousPersonalData/);
  assert.match(source, /example\.invalid/);
  assert.match(source, /filedataurl/);
  assert.match(source, /syntheticUsername/);
  assert.match(source, /Demo sanitization verification failed/);
});

test('package postinstall uses one verified production build orchestrator and one top-level coach-link transform', () => {
  const pkg = JSON.parse(read('package.json'));
  const start = String(pkg?.scripts?.start || '');
  const postinstall = String(pkg?.scripts?.postinstall || '');
  assert.equal(postinstall, 'node scripts/build-production-backend.mjs');
  assert.match(start, /test:storage-all/);
  assert.match(start, /production-start\.mjs/);
  assert.ok(!start.includes('migrate:storage-once'));
  assert.ok(!start.includes('migrate-storage-once.mjs'));

  const build = read('scripts/build-production-backend.mjs');
  for (const transform of [
    'patch-index-signup-legal.mjs', 'patch-logout-csrf.mjs', 'patch-canonical-storage-contract.mjs',
    'patch-persistence-integrity.mjs', 'patch-durable-storage-writes.mjs', 'patch-coach-link-suite.mjs',
  ]) assert.ok(build.includes(transform));
  for (const internalCoachStep of [
    'patch-swimmer-coach-authority.mjs', 'patch-parent-notification-semantics.mjs',
    'patch-coach-link-workflow.mjs', 'patch-coach-link-lifecycle.mjs', 'patch-coach-link-integrity.mjs',
    'patch-coach-link-ownership.mjs', 'patch-coach-link-routing.mjs', 'patch-coach-link-reconnect.mjs',
    'patch-coach-link-transaction-integrity.mjs',
  ]) assert.ok(!build.includes(`'scripts/${internalCoachStep}'`), `internal coach-link step leaked into top-level build: ${internalCoachStep}`);
  assert.match(build, /--check/);
  assert.match(build, /audit-storage-paths\.mjs/);
  assert.match(build, /ATHLYRAX_PRODUCTION_BACKEND_BUILD_OK/);
});