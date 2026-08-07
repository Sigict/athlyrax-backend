import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(process.cwd());
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('normal production startup is validation-only', () => {
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
    assert.ok(!source.includes(forbidden), `normal startup must not mutate storage through ${forbidden}`);
  }
});

test('storage migration is an explicit one-time command with an exact approval token', () => {
  const source = read('scripts/migrate-storage-once.mjs');
  assert.match(source, /MIGRATE_CANONICAL_STORAGE_ONCE/);
  assert.match(source, /migrateLegacyStorageIfNeeded\(\{/);
  assert.match(source, /restoreBundledDemoTenantIfNeeded\(\{/);
  assert.match(source, /writeStorageReadyMarker\(/);
  assert.match(source, /runStorageSafetyCheck\(\{/);
  assert.match(source, /finalizeLegacyStorageMigration\(\{/);

  const migrateIndex = source.indexOf('migrateLegacyStorageIfNeeded({');
  const restoreIndex = source.indexOf('restoreBundledDemoTenantIfNeeded({');
  const markerIndex = source.indexOf('writeStorageReadyMarker(');
  const checkIndex = source.indexOf('runStorageSafetyCheck({');
  const finalizeIndex = source.indexOf('finalizeLegacyStorageMigration({');
  assert.ok(migrateIndex < restoreIndex && restoreIndex < markerIndex && markerIndex < checkIndex && checkIndex < finalizeIndex);
});

test('package start never invokes storage migration implicitly', () => {
  const pkg = JSON.parse(read('package.json'));
  const start = String(pkg?.scripts?.start || '');
  const migrate = String(pkg?.scripts?.['migrate:storage-once'] || '');
  assert.match(start, /test:storage-all/);
  assert.match(start, /safe-start\.mjs/);
  assert.ok(!start.includes('migrate:storage-once'));
  assert.match(migrate, /migrate-storage-once\.mjs/);
});
