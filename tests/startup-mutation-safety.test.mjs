import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(process.cwd());
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('normal safe start is validation-only', () => {
  const source = read('scripts/safe-start.mjs');
  assert.match(source, /runStorageSafetyCheck\(\{/);
  assert.match(source, /requireFiles: true/);
  assert.match(source, /createDirectories: false/);
  assert.match(source, /await import\(pathToFileURL\(entryPath\)\.href\)/);

  for (const forbidden of [
    'migrateLegacyStorageIfNeeded(',
    'restoreBundledDemoTenantIfNeeded(',
    'finalizeLegacyStorageMigration(',
    'writeStorageReadyMarker(',
    'copyFileSync(',
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

test('storage migration is an explicit one-time command with an exact approval token', () => {
  const source = read('scripts/migrate-storage-once.mjs');
  assert.match(source, /MIGRATE_CANONICAL_STORAGE_ONCE/);
  assert.match(source, /Refusing to manufacture a backup from the primary store/);
  assert.match(source, /migrateLegacyStorageIfNeeded\(\{/);
  assert.match(source, /restoreBundledDemoTenantIfNeeded\(\{/);
  assert.match(source, /writeStorageReadyMarker\(/);
  assert.match(source, /runStorageSafetyCheck\(\{/);
  assert.match(source, /finalizeLegacyStorageMigration\(\{/);
  assert.match(source, /restorePreviousReadyMarker/);

  const migrateIndex = source.indexOf('migrateLegacyStorageIfNeeded({');
  const restoreIndex = source.indexOf('restoreBundledDemoTenantIfNeeded({');
  const markerIndex = source.indexOf('writeStorageReadyMarker(');
  const checkIndex = source.indexOf('runStorageSafetyCheck({');
  const finalizeIndex = source.indexOf('finalizeLegacyStorageMigration({');
  assert.ok(migrateIndex < restoreIndex && restoreIndex < markerIndex && markerIndex < checkIndex && checkIndex < finalizeIndex);
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
