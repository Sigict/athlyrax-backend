import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installDataSafetyGuards, dataSafetyInternals } from '../scripts/data-safety-preload.mjs';

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function withGuard(env, run) {
  const installation = installDataSafetyGuards({ fsModule: fs, env, logger: { info() {}, error() {} } });
  try { return run(); } finally { installation.uninstall(); }
}

test('real clubs tenant path resolves canonical tenant identity', { concurrency: false }, () => {
  const root = tempDir('athlyrax-render-tenant-path-');
  const storageRoot = path.join(root, 'storage');
  const dbPath = path.join(storageRoot, 'tenants', 'clubs', 'demo-company', 'db.json');
  assert.equal(dataSafetyInternals.expectedTenantIdForDbPath(dbPath, { ATHLYRAX_STORAGE_ROOT: storageRoot }), 'demo-company');
  fs.rmSync(root, { recursive: true, force: true });
});

test('database write survives unavailable secondary backup volume by verifying emergency backup on primary storage', { concurrency: false }, () => {
  const root = tempDir('athlyrax-render-backup-fallback-');
  const storageRoot = path.join(root, 'storage');
  const brokenBackupRoot = path.join(root, 'broken-backup-root');
  fs.writeFileSync(brokenBackupRoot, 'not-a-directory', 'utf8');

  const tenantDir = path.join(storageRoot, 'tenants', 'clubs', 'demo-company');
  const destination = path.join(tenantDir, 'db.json');
  const source = path.join(tenantDir, 'db.json.next.tmp');
  writeJson(destination, { swimmers: [{ id: 'old' }], __meta: { tenantId: 'demo-company', storageRevision: 20 } });
  writeJson(source, { swimmers: [{ id: 'new' }], __meta: { tenantId: 'demo-company', storageRevision: 20 } });

  withGuard({
    NODE_ENV: 'production',
    ATHLYRAX_STORAGE_ROOT: storageRoot,
    ATHLYRAX_SAFETY_BACKUP_ROOT: brokenBackupRoot,
    AUTH_SECRET: 'test-auth-secret-at-least-32-characters-long',
  }, () => fs.renameSync(source, destination));

  const saved = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.equal(saved.swimmers[0].id, 'new');
  assert.equal(saved.__meta.tenantId, 'demo-company');
  assert.equal(saved.__meta.storageRevision, 21);

  const emergencyRoot = path.join(storageRoot, '.athlyrax-emergency-backups', 'pre-write');
  assert.equal(fs.existsSync(emergencyRoot), true);
  const scope = fs.readdirSync(emergencyRoot)[0];
  const backupFile = path.join(emergencyRoot, scope, fs.readdirSync(path.join(emergencyRoot, scope))[0]);
  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  assert.equal(backup.swimmers[0].id, 'old');
  assert.equal(backup.__meta.storageRevision, 20);

  fs.rmSync(root, { recursive: true, force: true });
});

test('clubs path still blocks cross-tenant replacement', { concurrency: false }, () => {
  const root = tempDir('athlyrax-render-cross-tenant-');
  const storageRoot = path.join(root, 'storage');
  const tenantDir = path.join(storageRoot, 'tenants', 'clubs', 'demo-company');
  const destination = path.join(tenantDir, 'db.json');
  const source = path.join(tenantDir, 'db.json.next.tmp');
  writeJson(destination, { swimmers: [{ id: 'keep' }], __meta: { tenantId: 'demo-company', storageRevision: 20 } });
  writeJson(source, { swimmers: [{ id: 'wrong' }], __meta: { tenantId: 'other-club', storageRevision: 20 } });

  withGuard({
    NODE_ENV: 'production',
    ATHLYRAX_STORAGE_ROOT: storageRoot,
    ATHLYRAX_SAFETY_BACKUP_ROOT: path.join(root, 'safety'),
    AUTH_SECRET: 'test-auth-secret-at-least-32-characters-long',
  }, () => {
    assert.throws(() => fs.renameSync(source, destination), (error) => error?.code === 'ATHLYRAX_DB_TENANT_IDENTITY_CONFLICT');
  });
  assert.equal(JSON.parse(fs.readFileSync(destination, 'utf8')).swimmers[0].id, 'keep');
  fs.rmSync(root, { recursive: true, force: true });
});
