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

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('production requires explicit storage roots', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const configuration = resolveStorageConfiguration({ NODE_ENV: 'production' }, repoRoot);
  assert.match(configuration.failures.join('\n'), /ATHLYRAX_STORAGE_ROOT/);
  assert.match(configuration.failures.join('\n'), /ATHLYRAX_SAFETY_BACKUP_ROOT/);
});

test('Render deploy filesystem is rejected for production storage', () => {
  const configuration = resolveStorageConfiguration({ NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: '/opt/render/project/src/storage', ATHLYRAX_SAFETY_BACKUP_ROOT: '/var/data/backups' }, '/tmp/repo');
  assert.match(configuration.failures.join('\n'), /Render deploy filesystem/);
});

test('allowed persistent paths are accepted', () => {
  const configuration = resolveStorageConfiguration({ NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: '/var/data/athlyrax', ATHLYRAX_SAFETY_BACKUP_ROOT: '/var/data/athlyrax-safety' }, '/tmp/repo');
  assert.equal(configuration.storageRoot, '/var/data/athlyrax');
  assert.equal(configuration.authUsersPath, '/var/data/athlyrax/auth/auth-users.json');
  assert.equal(configuration.authUsersBackupPath, '/var/data/athlyrax/auth/auth-users.backup.json');
  assert.equal(configuration.legalAcceptancePath, '/var/data/athlyrax/legal-acceptances.jsonl');
  assert.equal(configuration.tenantRootPath, '/var/data/athlyrax/tenants');
  assert.doesNotMatch(configuration.failures.join('\n'), /Render deploy filesystem/);
});

test('nested primary and backup roots are rejected', () => {
  const root = tempDir('athlyrax-nested-');
  const configuration = resolveStorageConfiguration({ NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: path.join(root, 'data'), ATHLYRAX_SAFETY_BACKUP_ROOT: path.join(root, 'data', 'backups') }, root);
  assert.match(configuration.failures.join('\n'), /must not be nested/);
});

test('noncanonical auth path override is rejected', () => {
  const root = tempDir('athlyrax-auth-path-');
  const storageRoot = path.join(root, 'storage');
  const configuration = resolveStorageConfiguration({ NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: storageRoot, ATHLYRAX_SAFETY_BACKUP_ROOT: path.join(root, 'backup'), AUTH_USERS_PATH: path.join(storageRoot, 'auth-users.json') }, root);
  assert.match(configuration.failures.join('\n'), /AUTH_USERS_PATH must equal the canonical path/);
});

test('noncanonical legal acceptance path override is rejected', () => {
  const root = tempDir('athlyrax-legal-path-');
  const storageRoot = path.join(root, 'storage');
  const configuration = resolveStorageConfiguration({ NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: storageRoot, ATHLYRAX_SAFETY_BACKUP_ROOT: path.join(root, 'backup'), AUTH_LEGAL_ACCEPTANCE_PATH: path.join(root, 'elsewhere', 'legal.jsonl') }, root);
  assert.match(configuration.failures.join('\n'), /AUTH_LEGAL_ACCEPTANCE_PATH must equal the canonical path/);
});

test('production check succeeds only with marker, canonical auth store, global DB and required tenant', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  const tenantDb = path.join(storageRoot, 'tenants', 'demo-company', 'db.json');
  fs.mkdirSync(path.dirname(tenantDb), { recursive: true });
  fs.mkdirSync(path.join(storageRoot, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'db.json'), '{}\n');
  fs.writeFileSync(tenantDb, '{"swimmers":[{"id":"demo"}]}\n');
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.json'), '[]\n');
  writeStorageReadyMarker(storageRoot, { requiredTenants: ['demo-company'] });

  const env = { NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: storageRoot, ATHLYRAX_SAFETY_BACKUP_ROOT: backupRoot, ATHLYRAX_REQUIRED_TENANTS: 'demo-company' };
  const result = runStorageSafetyCheck({ env, repoRoot, createDirectories: true, requireFiles: true, logger: { info() {}, warn() {} } });
  assert.equal(result.configuration.storageRoot, path.resolve(storageRoot));
  assert.equal(env.AUTH_USERS_PATH, path.join(path.resolve(storageRoot), 'auth', 'auth-users.json'));
  assert.equal(env.AUTH_USERS_BACKUP_PATH, path.join(path.resolve(storageRoot), 'auth', 'auth-users.backup.json'));
  assert.equal(env.AUTH_LEGAL_ACCEPTANCE_PATH, path.join(path.resolve(storageRoot), 'legal-acceptances.jsonl'));
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
    env: { NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: storageRoot, ATHLYRAX_SAFETY_BACKUP_ROOT: backupRoot, ATHLYRAX_REQUIRED_TENANTS: 'demo-company' },
    repoRoot, createDirectories: true, requireFiles: true, logger: { info() {}, warn() {} },
  }), /demo-company/);
});
