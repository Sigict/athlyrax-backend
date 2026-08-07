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
  assert.match(persistence, /Refusing startup-time recovery, normalization or default bootstrap/);
});

test('storage validator covers every store loaded during production bootstrap', () => {
  const source = read('scripts/storage-safety-lib.mjs');
  for (const token of [
    'authInvitesPath',
    'snapshotSubmissionsPath',
    'billingCatalogPath',
    'validateJsonArray(configuration.authInvitesPath',
    'validateJsonArray(configuration.snapshotSubmissionsPath',
    'validateBillingCatalog(configuration.billingCatalogPath',
    'validateAuthPrimaryBackupParity',
    'validateAuthBoundTenantDatabases',
  ]) assert.ok(source.includes(token), `startup storage validation is missing ${token}`);
});

test('production wrapper runs migration only with the exact explicit approval value', () => {
  const source = read('scripts/production-start.mjs');
  assert.match(source, /ATHLYRAX_STORAGE_MIGRATION_APPROVAL/);
  assert.match(source, /MIGRATE_CANONICAL_STORAGE_ONCE/);
  assert.match(source, /migrationAlreadyCompleted/);
  assert.match(source, /migrate-storage-once\.mjs/);
  assert.match(source, /safe-start\.mjs/);
  assert.match(source, /invalid value/);
});

test('storage migration is explicit, ordered and sanitizes demo data before activation', () => {
  const source = read('scripts/migrate-storage-once.mjs');
  assert.match(source, /MIGRATE_CANONICAL_STORAGE_ONCE/);
  assert.match(source, /Refusing to manufacture a backup from the primary store/);
  assert.match(source, /migrateLegacyStorageIfNeeded\(\{/);
  assert.match(source, /restoreBundledDemoTenantIfNeeded\(\{/);
  assert.match(source, /sanitizeDemoTenantDatabase\(\{/);
  assert.match(source, /writeStorageReadyMarker\(/);
  assert.match(source, /runStorageSafetyCheck\(\{/);
  assert.match(source, /finalizeLegacyStorageMigration\(\{/);
  assert.match(source, /restorePreviousReadyMarker/);
  const order = [
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

test('package start uses guarded wrapper and consolidated postinstall', () => {
  const pkg = JSON.parse(read('package.json'));
  const start = String(pkg?.scripts?.start || '');
  const postinstall = String(pkg?.scripts?.postinstall || '');
  assert.match(start, /test:storage-all/);
  assert.match(start, /production-start\.mjs/);
  assert.ok(!start.includes('migrate:storage-once'));
  assert.ok(!start.includes('migrate-storage-once.mjs'));
  assert.ok(!postinstall.includes('patch-runtime-start-guard.mjs'));
  assert.ok(!postinstall.includes('patch-provisioning-integrity.mjs'));
  assert.match(postinstall, /patch-canonical-storage-contract\.mjs/);
});
