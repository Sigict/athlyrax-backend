import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertCanonicalPathContract,
  canonicalStoragePaths,
  restoreBundledDemoTenantIfNeeded,
} from '../scripts/storage-path-contract.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('all live stores have one canonical path template', () => {
  const root = tempDir('athlyrax-path-contract-');
  const storage = path.join(root, 'persistent');
  const paths = canonicalStoragePaths({ sourceRoot: root, storageRoot: storage });
  assert.equal(paths.repositoryStorage, path.join(root, 'storage'));
  assert.equal(paths.globalDb, path.join(storage, 'db.json'));
  assert.equal(paths.tenantRoot, path.join(storage, 'tenants'));
  assert.equal(paths.tenantDb('demo-company'), path.join(storage, 'tenants', 'demo-company', 'db.json'));
  assert.equal(paths.authUsers, path.join(storage, 'auth', 'auth-users.json'));
  assert.equal(paths.authUsersBackup, path.join(storage, 'auth', 'auth-users.backup.json'));
  assert.equal(paths.authInvites, path.join(storage, 'auth-invites.json'));
  assert.equal(paths.billingCatalog, path.join(storage, 'billing-catalog.json'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy tenants/clubs path fails the contract', () => {
  assert.throws(() => assertCanonicalPathContract({
    sourceRoot: '/tmp/source', storageRoot: '/tmp/storage',
    indexSource: `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants', 'clubs');`,
  }), /Legacy tenants\/clubs path/);
});

test('legacy root-level auth-users path fails the contract', () => {
  assert.throws(() => assertCanonicalPathContract({
    sourceRoot: '/tmp/source', storageRoot: '/tmp/storage',
    indexSource: `const SHARED_AUTH_USERS_PATH = path.join(STORAGE_ROOT, 'auth-users.json');`,
  }), /Legacy root-level auth-users path/);
});

test('empty tenant database auto-creation fails the contract', () => {
  assert.throws(() => assertCanonicalPathContract({
    sourceRoot: '/tmp/source', storageRoot: '/tmp/storage',
    indexSource: `writeAtomicJsonFile(storagePaths.dbPath, {});`,
  }), /Unsafe empty tenant database auto-creation/);
});

test('fully canonical backend source passes the contract', () => {
  assert.doesNotThrow(() => assertCanonicalPathContract({
    sourceRoot: '/tmp/source',
    storageRoot: '/tmp/storage',
    indexSource: [
      `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants');`,
      `const SHARED_AUTH_USERS_PATH = path.join(STORAGE_ROOT, 'auth', 'auth-users.json');`,
      `action: 'tenant_database_missing'`,
    ].join('\n'),
  }));
});

test('missing or empty demo database is restored from bundled demo only', () => {
  const root = tempDir('athlyrax-demo-restore-');
  const sourceRoot = path.join(root, 'source');
  const storageRoot = path.join(root, 'persistent');
  const backupRoot = path.join(root, 'backup');
  const bundled = path.join(sourceRoot, 'storage', 'tenants', 'demo-company', 'db.json');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  const payload = { swimmers: Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, name: `Swimmer ${i}` })) };
  fs.writeFileSync(bundled, `${JSON.stringify(payload)}\n`, 'utf8');

  const first = restoreBundledDemoTenantIfNeeded({ sourceRoot, storageRoot, backupRoot, logger: { info() {} } });
  assert.equal(first.restored, true);
  const live = path.join(storageRoot, 'tenants', 'demo-company', 'db.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(live, 'utf8')), payload);

  const second = restoreBundledDemoTenantIfNeeded({ sourceRoot, storageRoot, backupRoot, logger: { info() {} } });
  assert.equal(second.restored, false);
  assert.equal(second.reason, 'live-demo-present');
  fs.rmSync(root, { recursive: true, force: true });
});
