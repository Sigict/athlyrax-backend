import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalStoragePaths } from '../scripts/storage-path-contract.mjs';
import { runStorageSafetyCheck, writeStorageReadyMarker } from '../scripts/storage-safety-lib.mjs';

function root(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function productionEnv(storageRoot, backupRoot, extra = {}) {
  return {
    NODE_ENV: 'production',
    ATHLYRAX_STORAGE_ROOT: storageRoot,
    ATHLYRAX_SAFETY_BACKUP_ROOT: backupRoot,
    AUTH_SECRET: 'test-production-secret-at-least-32-characters-long',
    ...extra,
  };
}
function writeBase(storageRoot, users) {
  fs.mkdirSync(path.join(storageRoot, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'db.json'), '{"__meta":{"tenantId":"global-owner"}}\n');
  const raw = `${JSON.stringify(users)}\n`;
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.json'), raw);
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.backup.json'), raw);
  fs.writeFileSync(path.join(storageRoot, 'auth-invites.json'), '[]\n');
  fs.writeFileSync(path.join(storageRoot, 'snapshot-submissions.json'), '[]\n');
  fs.writeFileSync(path.join(storageRoot, 'billing-catalog.json'), `${JSON.stringify({ plans: [{ key: 'tier-1' }] })}\n`);
  writeStorageReadyMarker(storageRoot);
}

test('tenantDb rejects dotted, uppercase and otherwise noncanonical tenant IDs', () => {
  const temp = root('athlyrax-canonical-id-');
  const paths = canonicalStoragePaths({ sourceRoot: temp, storageRoot: path.join(temp, 'storage') });
  assert.equal(paths.tenantDb('club-a'), path.join(temp, 'storage', 'tenants', 'club-a', 'db.json'));
  for (const invalid of ['Club-A', 'club.a', ' club-a ', 'club a']) {
    assert.throws(() => paths.tenantDb(invalid), /noncanonical|Unsafe/i);
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('ATHLYRAX_REQUIRED_TENANTS rejects IDs that runtime would normalize to a different path', () => {
  const temp = root('athlyrax-required-id-');
  const storage = path.join(temp, 'storage');
  const backup = path.join(temp, 'backup');
  writeBase(storage, [{ username: 'softwareowner', role: 'software-owner', passwordHash: 'x' }]);
  assert.throws(
    () => runStorageSafetyCheck({
      env: productionEnv(storage, backup, { ATHLYRAX_REQUIRED_TENANTS: 'Club.A' }),
      repoRoot: temp,
      logger: { info() {}, warn() {} },
    }),
    /noncanonical tenant key/,
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test('production storage-ready marker must be bound to the exact storage root', () => {
  const temp = root('athlyrax-marker-binding-');
  const storage = path.join(temp, 'storage');
  const backup = path.join(temp, 'backup');
  writeBase(storage, [{ username: 'softwareowner', role: 'software-owner', passwordHash: 'x' }]);
  fs.writeFileSync(path.join(storage, '.athlyrax-storage-ready.json'), JSON.stringify({ version: 1, approved: true }), 'utf8');
  assert.throws(
    () => runStorageSafetyCheck({ env: productionEnv(storage, backup), repoRoot: temp, logger: { info() {}, warn() {} } }),
    /not bound to this storage root/,
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test('snapshot self-signup users do not require a fake tenant database', () => {
  const temp = root('athlyrax-snapshot-public-');
  const storage = path.join(temp, 'storage');
  const backup = path.join(temp, 'backup');
  writeBase(storage, [
    { username: 'softwareowner', role: 'software-owner', passwordHash: 'owner' },
    { username: 'swimmer@example.test', role: 'swimmer', tenantId: 'snapshot-public', createdVia: 'snapshot-self-signup', passwordHash: 'swimmer' },
  ]);
  assert.doesNotThrow(() => runStorageSafetyCheck({ env: productionEnv(storage, backup), repoRoot: temp, logger: { info() {}, warn() {} } }));
  assert.equal(fs.existsSync(path.join(storage, 'tenants', 'snapshot-public', 'db.json')), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test('ordinary swimmer assigned to snapshot-public is not exempt without snapshot-self-signup provenance', () => {
  const temp = root('athlyrax-snapshot-provenance-');
  const storage = path.join(temp, 'storage');
  const backup = path.join(temp, 'backup');
  writeBase(storage, [
    { username: 'softwareowner', role: 'software-owner', passwordHash: 'owner' },
    { username: 'swimmer-x', role: 'swimmer', tenantId: 'snapshot-public', createdVia: 'admin', passwordHash: 'swimmer' },
  ]);
  assert.throws(
    () => runStorageSafetyCheck({ env: productionEnv(storage, backup), repoRoot: temp, logger: { info() {}, warn() {} } }),
    /Auth-bound tenant database snapshot-public/,
  );
  fs.rmSync(temp, { recursive: true, force: true });
});
