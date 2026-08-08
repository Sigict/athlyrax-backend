import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runStorageSafetyCheck, writeStorageReadyMarker } from '../scripts/storage-safety-lib.mjs';

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function env(storageRoot, backupRoot, extra = {}) {
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
function writeTenant(storageRoot, tenantId, declaredTenantId = tenantId, meaningful = false) {
  const file = path.join(storageRoot, 'tenants', tenantId, 'db.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const swimmers = meaningful ? [{ id: `${tenantId}-swimmer` }] : [];
  fs.writeFileSync(file, `${JSON.stringify({ __meta: { tenantId: declaredTenantId }, swimmers })}\n`);
}

test('demo.coach always validates demo-company even when stored tenantId is absent', () => {
  const root = tempDir('athlyrax-routing-demo-');
  const storage = path.join(root, 'storage');
  const backup = path.join(root, 'backup');
  writeBase(storage, [
    { username: 'softwareowner', role: 'software-owner', passwordHash: 'x' },
    { username: 'demo.coach', role: 'head-coach', passwordHash: 'x', swimClub: 'Demo Company', teamName: 'Demo Team' },
  ]);
  writeTenant(storage, 'demo-company', 'demo-company', true);
  assert.doesNotThrow(() => runStorageSafetyCheck({ env: env(storage, backup), repoRoot: root, logger: { info() {}, warn() {} } }));
  fs.rmSync(root, { recursive: true, force: true });
});

test('only the configured primary software owner is exempt from tenant database validation', () => {
  const root = tempDir('athlyrax-routing-owner-');
  const storage = path.join(root, 'storage');
  const backup = path.join(root, 'backup');
  writeBase(storage, [
    { username: 'softwareowner', role: 'software-owner', passwordHash: 'x' },
    { username: 'secondary-owner', role: 'software-owner', passwordHash: 'x', tenantId: 'secondary-club' },
  ]);
  assert.throws(
    () => runStorageSafetyCheck({ env: env(storage, backup), repoRoot: root, logger: { info() {}, warn() {} } }),
    /Auth-bound tenant database secondary-club/,
  );
  writeTenant(storage, 'secondary-club');
  assert.doesNotThrow(() => runStorageSafetyCheck({ env: env(storage, backup), repoRoot: root, logger: { info() {}, warn() {} } }));
  fs.rmSync(root, { recursive: true, force: true });
});

test('tenant database declaring a different tenant is rejected before startup', () => {
  const root = tempDir('athlyrax-routing-identity-');
  const storage = path.join(root, 'storage');
  const backup = path.join(root, 'backup');
  writeBase(storage, [
    { username: 'softwareowner', role: 'software-owner', passwordHash: 'x' },
    { username: 'coach-a', role: 'head-coach', passwordHash: 'x', tenantId: 'club-a' },
  ]);
  writeTenant(storage, 'club-a', 'club-b');
  assert.throws(
    () => runStorageSafetyCheck({ env: env(storage, backup), repoRoot: root, logger: { info() {}, warn() {} } }),
    /Refusing cross-tenant data routing/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('storage readiness marker cannot be transplanted to another storage root', () => {
  const root = tempDir('athlyrax-routing-marker-');
  const storageA = path.join(root, 'storage-a');
  const storageB = path.join(root, 'storage-b');
  const backup = path.join(root, 'backup');
  const users = [{ username: 'softwareowner', role: 'software-owner', passwordHash: 'x' }];
  writeBase(storageA, users);
  writeBase(storageB, users);
  fs.copyFileSync(path.join(storageA, '.athlyrax-storage-ready.json'), path.join(storageB, '.athlyrax-storage-ready.json'));
  assert.throws(
    () => runStorageSafetyCheck({ env: env(storageB, backup), repoRoot: root, logger: { info() {}, warn() {} } }),
    /not bound to this storage root/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});
