import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(process.cwd());
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('normal safe start is strictly read-only against persistent storage', () => {
  const source = read('scripts/safe-start.mjs');
  assert.match(source, /validateRequiredStorageFiles\(/);
  assert.match(source, /fs\.accessSync\(directory, fs\.constants\.R_OK \| fs\.constants\.W_OK\)/);
  assert.match(source, /applyCanonicalAuthPaths\(/);
  assert.match(source, /globalThis\[Symbol\.for\('athlyrax\.safeStartEnforced'\)\] = true/);
  assert.match(source, /await import\(pathToFileURL\(entryPath\)\.href\)/);

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
  ]) {
    assert.ok(!source.includes(forbidden), `normal safe start must not mutate storage through ${forbidden}`);
  }
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

  const migrateIndex = source.indexOf('migrateLegacyStorageIfNeeded({');
  const restoreIndex = source.indexOf('restoreBundledDemoTenantIfNeeded({');
  const sanitizeIndex = source.indexOf('sanitizeDemoTenantDatabase({');
  const markerIndex = source.indexOf('writeStorageReadyMarker(');
  const checkIndex = source.indexOf('runStorageSafetyCheck({');
  const finalizeIndex = source.indexOf('finalizeLegacyStorageMigration({');
  assert.ok(migrateIndex < restoreIndex && restoreIndex < sanitizeIndex && sanitizeIndex < markerIndex && markerIndex < checkIndex && checkIndex < finalizeIndex);
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

test('package start uses guarded wrapper and never invokes migration without runtime approval', () => {
  const pkg = JSON.parse(read('package.json'));
  const start = String(pkg?.scripts?.start || '');
  const migrate = String(pkg?.scripts?.['migrate:storage-once'] || '');
  assert.match(start, /test:storage-all/);
  assert.match(start, /production-start\.mjs/);
  assert.ok(!start.includes('migrate:storage-once'));
  assert.ok(!start.includes('migrate-storage-once.mjs'));
  assert.match(migrate, /migrate-storage-once\.mjs/);
});
