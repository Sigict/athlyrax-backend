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
  writeStorageReadyMarker(storageRoot);
}
function writeTenant(storageRoot, tenantId) {
  const file = path.join(storageRoot, 'tenants', tenantId, 'db.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ __meta: { tenantId }, swimmers: [] })}\n`);
}

test('demo.coach always validates demo-company even when stored tenantId is absent', () => {
  const root = tempDir('athlyrax-routing-demo-');
  const storage = path.join(root, 'storage');
  const backup = path.join(root, 'backup');
  writeBase(storage, [
    { username: 'softwareowner', role: 'software-owner', passwordHash: 'x' },
    { username: 'demo.coach', role: 'head-coach', passwordHash: 'x', swimClub: 'Demo Company', teamName: 'Demo Team' },
  ]);
  writeTenant(storage, 'demo-company');
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
