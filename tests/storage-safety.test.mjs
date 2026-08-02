import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resolveStorageConfiguration,
  runStorageSafetyCheck,
  writeStorageReadyMarker,
} from '../scripts/storage-safety-lib.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('production requires explicit storage roots', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const configuration = resolveStorageConfiguration({ NODE_ENV: 'production' }, repoRoot);
  assert.match(configuration.failures.join('\n'), /ATHLYRAX_STORAGE_ROOT/);
  assert.match(configuration.failures.join('\n'), /ATHLYRAX_SAFETY_BACKUP_ROOT/);
});

test('Render deploy filesystem is rejected for production storage', () => {
  const configuration = resolveStorageConfiguration({
    NODE_ENV: 'production',
    ATHLYRAX_STORAGE_ROOT: '/opt/render/project/src/storage',
    ATHLYRAX_SAFETY_BACKUP_ROOT: '/var/data/backups',
  }, '/tmp/repo');
  assert.match(configuration.failures.join('\n'), /Render deploy filesystem/);
});

test('exact Render deploy root is rejected', () => {
  const configuration = resolveStorageConfiguration({
    NODE_ENV: 'production',
    ATHLYRAX_STORAGE_ROOT: '/opt/render/project',
    ATHLYRAX_SAFETY_BACKUP_ROOT: '/var/data/backups',
  }, '/tmp/repo');
  assert.match(configuration.failures.join('\n'), /Render deploy filesystem/);
});

test('Render deploy root with trailing slash is rejected', () => {
  const configuration = resolveStorageConfiguration({
    NODE_ENV: 'production',
    ATHLYRAX_STORAGE_ROOT: '/opt/render/project/',
    ATHLYRAX_SAFETY_BACKUP_ROOT: '/var/data/backups',
  }, '/tmp/repo');
  assert.match(configuration.failures.join('\n'), /Render deploy filesystem/);
});

test('allowed non-Render path is accepted', () => {
  const configuration = resolveStorageConfiguration({
    NODE_ENV: 'production',
    ATHLYRAX_STORAGE_ROOT: '/var/data/athlyrax',
    ATHLYRAX_SAFETY_BACKUP_ROOT: '/var/data/athlyrax-safety',
  }, '/tmp/repo');
  assert.doesNotMatch(configuration.failures.join('\n'), /Render deploy filesystem/);
});

test('misleading sibling path is not treated as Render deploy root', () => {
  const configuration = resolveStorageConfiguration({
    NODE_ENV: 'production',
    ATHLYRAX_STORAGE_ROOT: '/opt/render/project-other',
    ATHLYRAX_SAFETY_BACKUP_ROOT: '/var/data/backups',
  }, '/tmp/repo');
  assert.doesNotMatch(configuration.failures.join('\n'), /Render deploy filesystem/);
});

test('nested primary and backup roots are rejected', () => {
  const root = tempDir('athlyrax-nested-');
  const configuration = resolveStorageConfiguration({
    NODE_ENV: 'production',
    ATHLYRAX_STORAGE_ROOT: path.join(root, 'data'),
    ATHLYRAX_SAFETY_BACKUP_ROOT: path.join(root, 'data', 'backups'),
  }, root);
  assert.match(configuration.failures.join('\n'), /must not be nested/);
});

test('production check succeeds only with marker, auth store, global DB and required tenant', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  const tenantDb = path.join(storageRoot, 'tenants', 'demo-company', 'db.json');
  fs.mkdirSync(path.dirname(tenantDb), { recursive: true });
  fs.mkdirSync(path.join(storageRoot, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'db.json'), '{}\n');
  fs.writeFileSync(tenantDb, '{}\n');
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.json'), '[]\n');
  writeStorageReadyMarker(storageRoot, { requiredTenants: ['demo-company'] });

  const env = {
    NODE_ENV: 'production',
    ATHLYRAX_STORAGE_ROOT: storageRoot,
    ATHLYRAX_SAFETY_BACKUP_ROOT: backupRoot,
    ATHLYRAX_REQUIRED_TENANTS: 'demo-company',
  };
  const result = runStorageSafetyCheck({
    env,
    repoRoot,
    createDirectories: true,
    requireFiles: true,
    linkStorage: false,
    logger: { info() {}, warn() {} },
  });
  assert.equal(result.configuration.storageRoot, path.resolve(storageRoot));
  assert.equal(env.AUTH_USERS_PATH, path.join(path.resolve(repoRoot), 'storage', 'auth', 'auth-users.json'));
});

test('missing required tenant DB fails closed', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  fs.mkdirSync(path.join(storageRoot, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'db.json'), '{}\n');
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.json'), '[]\n');
  writeStorageReadyMarker(storageRoot);

  assert.throws(() => runStorageSafetyCheck({
    env: {
      NODE_ENV: 'production',
      ATHLYRAX_STORAGE_ROOT: storageRoot,
      ATHLYRAX_SAFETY_BACKUP_ROOT: backupRoot,
      ATHLYRAX_REQUIRED_TENANTS: 'demo-company',
    },
    repoRoot,
    createDirectories: true,
    requireFiles: true,
    linkStorage: false,
    logger: { info() {}, warn() {} },
  }), /demo-company/);
});
