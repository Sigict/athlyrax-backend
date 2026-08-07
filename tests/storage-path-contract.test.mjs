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

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function meaningfulPayload(prefix) {
  return { swimmers: Array.from({ length: 200 }, (_, i) => ({ id: `${prefix}${i}`, name: `Swimmer ${i}` })) };
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
  assert.equal(paths.legalAcceptances, path.join(storage, 'legal-acceptances.jsonl'));
  assert.equal(paths.billingCatalog, path.join(storage, 'billing-catalog.json'));
  assert.equal(paths.snapshotSubmissions, path.join(storage, 'snapshot-submissions.json'));
  assert.equal(paths.authAuditDir, path.join(storage, 'auth-audit'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy tenants/clubs path fails the contract', () => {
  assert.throws(() => assertCanonicalPathContract({ sourceRoot: '/tmp/source', storageRoot: '/tmp/storage', indexSource: `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants', 'clubs');` }), /Legacy tenants\/clubs path/);
});

test('legacy root-level auth-users path fails the contract', () => {
  assert.throws(() => assertCanonicalPathContract({ sourceRoot: '/tmp/source', storageRoot: '/tmp/storage', indexSource: `const SHARED_AUTH_USERS_PATH = path.join(STORAGE_ROOT, 'auth-users.json');` }), /Legacy root-level auth-users path/);
});

test('empty tenant database auto-creation fails the contract', () => {
  assert.throws(() => assertCanonicalPathContract({ sourceRoot: '/tmp/source', storageRoot: '/tmp/storage', indexSource: `writeAtomicJsonFile(storagePaths.dbPath, {});` }), /Unsafe empty tenant database auto-creation/);
});

test('fully canonical backend source passes the contract', () => {
  assert.doesNotThrow(() => assertCanonicalPathContract({
    sourceRoot: '/tmp/source', storageRoot: '/tmp/storage',
    indexSource: [
      `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants');`,
      `const SHARED_AUTH_USERS_PATH = path.join(STORAGE_ROOT, 'auth', 'auth-users.json');`,
      `action: 'tenant_database_missing'`,
    ].join('\n'),
  }));
});

test('missing canonical demo database is restored from bundled seed when no meaningful legacy database exists', () => {
  const root = tempDir('athlyrax-demo-bundled-');
  const sourceRoot = path.join(root, 'source');
  const storageRoot = path.join(root, 'persistent');
  const backupRoot = path.join(root, 'backup');
  const bundled = path.join(sourceRoot, 'storage', 'tenants', 'demo-company', 'db.json');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  const payload = meaningfulPayload('bundle-');
  fs.writeFileSync(bundled, `${JSON.stringify(payload)}\n`, 'utf8');
  const result = restoreBundledDemoTenantIfNeeded({ sourceRoot, storageRoot, backupRoot, logger: { info() {} } });
  assert.equal(result.restored, true);
  assert.equal(result.source, 'bundled-seed');
  const live = path.join(storageRoot, 'tenants', 'demo-company', 'db.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(live, 'utf8')), payload);
  fs.rmSync(root, { recursive: true, force: true });
});

test('meaningful legacy demo database is preferred and preserved before bundled seed', () => {
  const root = tempDir('athlyrax-demo-legacy-');
  const sourceRoot = path.join(root, 'source');
  const storageRoot = path.join(root, 'persistent');
  const backupRoot = path.join(root, 'backup');
  const bundled = path.join(sourceRoot, 'storage', 'tenants', 'demo-company', 'db.json');
  const legacy = path.join(storageRoot, 'tenants', 'clubs', 'demo-company', 'db.json');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const bundledPayload = meaningfulPayload('bundle-');
  const legacyPayload = meaningfulPayload('legacy-');
  fs.writeFileSync(bundled, `${JSON.stringify(bundledPayload)}\n`, 'utf8');
  fs.writeFileSync(legacy, `${JSON.stringify(legacyPayload)}\n`, 'utf8');

  const result = restoreBundledDemoTenantIfNeeded({ sourceRoot, storageRoot, backupRoot, logger: { info() {} } });
  assert.equal(result.restored, true);
  assert.equal(result.source, 'legacy-live');
  const live = path.join(storageRoot, 'tenants', 'demo-company', 'db.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(live, 'utf8')), legacyPayload);
  const preserved = fs.readdirSync(path.join(backupRoot, 'demo-bootstrap-replaced'));
  assert.ok(preserved.some((name) => name.includes('legacy-demo-source-preserved')));
  fs.rmSync(root, { recursive: true, force: true });
});
