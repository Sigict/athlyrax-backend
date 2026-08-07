import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertCanonicalPathContract,
  canonicalStoragePaths,
  finalizeLegacyStorageMigration,
  migrateLegacyStorageIfNeeded,
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
  assert.equal(paths.legacyMigrationMarker, path.join(storage, '.athlyrax-legacy-storage-migration-v1.json'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy tenants/clubs path fails the runtime contract', () => {
  assert.throws(() => assertCanonicalPathContract({ sourceRoot: '/tmp/source', storageRoot: '/tmp/storage', indexSource: `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants', 'clubs');` }), /Legacy tenants\/clubs path/);
});

test('legacy root-level auth-users path fails the runtime contract', () => {
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

test('legacy auth plus all tenant files migrate to canonical paths and backups', () => {
  const root = tempDir('athlyrax-legacy-all-');
  const sourceRoot = path.join(root, 'source');
  const storageRoot = path.join(root, 'persistent');
  const backupRoot = path.join(root, 'backup');
  fs.mkdirSync(storageRoot, { recursive: true });

  const users = [{ username: 'coach-a', role: 'head-coach' }];
  fs.writeFileSync(path.join(storageRoot, 'auth-users.json'), `${JSON.stringify(users)}\n`, 'utf8');
  fs.writeFileSync(path.join(storageRoot, 'auth-users.backup.json'), `${JSON.stringify(users)}\n`, 'utf8');

  for (const tenantId of ['tenant-a', 'tenant-b']) {
    const legacyDir = path.join(storageRoot, 'tenants', 'clubs', tenantId);
    fs.mkdirSync(path.join(legacyDir, 'db-snapshots'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'db.json'), `${JSON.stringify({ swimmers: [{ id: `${tenantId}-swimmer` }] })}\n`, 'utf8');
    fs.writeFileSync(path.join(legacyDir, 'trainingPlannerTargets.backup.json'), `${JSON.stringify({ rows: [{ id: `${tenantId}-target` }] })}\n`, 'utf8');
    fs.writeFileSync(path.join(legacyDir, 'db-snapshots', 'db-old.json'), `${JSON.stringify({ swimmers: [{ id: `${tenantId}-snapshot` }] })}\n`, 'utf8');
  }

  const result = migrateLegacyStorageIfNeeded({ sourceRoot, storageRoot, backupRoot, logger: { info() {} } });
  assert.equal(result.count, 8);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(storageRoot, 'auth', 'auth-users.json'), 'utf8')), users);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(storageRoot, 'auth', 'auth-users.backup.json'), 'utf8')), users);
  for (const tenantId of ['tenant-a', 'tenant-b']) {
    assert.equal(fs.existsSync(path.join(storageRoot, 'tenants', tenantId, 'db.json')), true);
    assert.equal(fs.existsSync(path.join(storageRoot, 'tenants', tenantId, 'trainingPlannerTargets.backup.json')), true);
    assert.equal(fs.existsSync(path.join(storageRoot, 'tenants', tenantId, 'db-snapshots', 'db-old.json')), true);
    assert.equal(fs.existsSync(path.join(storageRoot, 'tenants', 'clubs', tenantId, 'db.json')), true);
  }
  assert.equal(fs.existsSync(path.join(backupRoot, 'legacy-storage-migration')), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy migration creates a canonical auth backup baseline when old backup is absent', () => {
  const root = tempDir('athlyrax-auth-baseline-');
  const storageRoot = path.join(root, 'persistent');
  const backupRoot = path.join(root, 'backup');
  fs.mkdirSync(storageRoot, { recursive: true });
  const users = [{ username: 'coach-a', role: 'head-coach' }];
  fs.writeFileSync(path.join(storageRoot, 'auth-users.json'), `${JSON.stringify(users)}\n`, 'utf8');
  const result = migrateLegacyStorageIfNeeded({ sourceRoot: root, storageRoot, backupRoot, logger: { info() {} } });
  assert.equal(result.count, 2);
  assert.equal(fs.readFileSync(path.join(storageRoot, 'auth', 'auth-users.json'), 'utf8'), fs.readFileSync(path.join(storageRoot, 'auth', 'auth-users.backup.json'), 'utf8'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy migration never overwrites a meaningful canonical tenant database', () => {
  const root = tempDir('athlyrax-legacy-no-overwrite-');
  const sourceRoot = path.join(root, 'source');
  const storageRoot = path.join(root, 'persistent');
  const backupRoot = path.join(root, 'backup');
  const canonicalDb = path.join(storageRoot, 'tenants', 'tenant-a', 'db.json');
  const legacyDb = path.join(storageRoot, 'tenants', 'clubs', 'tenant-a', 'db.json');
  fs.mkdirSync(path.dirname(canonicalDb), { recursive: true });
  fs.mkdirSync(path.dirname(legacyDb), { recursive: true });
  const canonicalPayload = { swimmers: [{ id: 'canonical' }] };
  const legacyPayload = { swimmers: [{ id: 'legacy' }] };
  fs.writeFileSync(canonicalDb, `${JSON.stringify(canonicalPayload)}\n`, 'utf8');
  fs.writeFileSync(legacyDb, `${JSON.stringify(legacyPayload)}\n`, 'utf8');

  const result = migrateLegacyStorageIfNeeded({ sourceRoot, storageRoot, backupRoot, logger: { info() {} } });
  assert.equal(result.count, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(canonicalDb, 'utf8')), canonicalPayload);
  fs.rmSync(root, { recursive: true, force: true });
});

test('finalized legacy migration prevents stale legacy data from being reused on future startups', () => {
  const root = tempDir('athlyrax-legacy-finalized-');
  const sourceRoot = path.join(root, 'source');
  const storageRoot = path.join(root, 'persistent');
  const backupRoot = path.join(root, 'backup');
  const legacyDb = path.join(storageRoot, 'tenants', 'clubs', 'tenant-a', 'db.json');
  fs.mkdirSync(path.dirname(legacyDb), { recursive: true });
  fs.writeFileSync(legacyDb, `${JSON.stringify({ swimmers: [{ id: 'legacy' }] })}\n`, 'utf8');
  const first = migrateLegacyStorageIfNeeded({ sourceRoot, storageRoot, backupRoot, logger: { info() {} } });
  assert.equal(first.count, 1);
  const finalized = finalizeLegacyStorageMigration({ storageRoot, migrationResult: first, logger: { info() {} } });
  assert.equal(finalized.finalized, true);
  const canonicalDb = path.join(storageRoot, 'tenants', 'tenant-a', 'db.json');
  fs.writeFileSync(canonicalDb, '{}\n', 'utf8');
  const second = migrateLegacyStorageIfNeeded({ sourceRoot, storageRoot, backupRoot, logger: { info() {} } });
  assert.equal(second.skipped, true);
  assert.equal(fs.readFileSync(canonicalDb, 'utf8'), '{}\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('invalid legacy auth data fails closed instead of being copied', () => {
  const root = tempDir('athlyrax-legacy-auth-invalid-');
  const storageRoot = path.join(root, 'persistent');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'auth-users.json'), '{invalid', 'utf8');
  assert.throws(() => migrateLegacyStorageIfNeeded({ sourceRoot: root, storageRoot, backupRoot: path.join(root, 'backup'), logger: { info() {} } }), /Legacy auth users store is unreadable or invalid/);
  assert.equal(fs.existsSync(path.join(storageRoot, 'auth', 'auth-users.json')), false);
  fs.rmSync(root, { recursive: true, force: true });
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

test('finalized migration makes demo recovery ignore stale legacy demo data and use bundled seed', () => {
  const root = tempDir('athlyrax-demo-marker-');
  const sourceRoot = path.join(root, 'source');
  const storageRoot = path.join(root, 'persistent');
  const backupRoot = path.join(root, 'backup');
  const bundled = path.join(sourceRoot, 'storage', 'tenants', 'demo-company', 'db.json');
  const legacy = path.join(storageRoot, 'tenants', 'clubs', 'demo-company', 'db.json');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(bundled, `${JSON.stringify(meaningfulPayload('bundle-'))}\n`, 'utf8');
  fs.writeFileSync(legacy, `${JSON.stringify(meaningfulPayload('legacy-'))}\n`, 'utf8');
  const migration = migrateLegacyStorageIfNeeded({ sourceRoot, storageRoot, backupRoot, logger: { info() {} } });
  finalizeLegacyStorageMigration({ storageRoot, migrationResult: migration, logger: { info() {} } });
  fs.unlinkSync(path.join(storageRoot, 'tenants', 'demo-company', 'db.json'));
  const result = restoreBundledDemoTenantIfNeeded({ sourceRoot, storageRoot, backupRoot, logger: { info() {} } });
  assert.equal(result.source, 'bundled-seed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('corrupt canonical demo database fails closed instead of being overwritten', () => {
  const root = tempDir('athlyrax-demo-corrupt-');
  const sourceRoot = path.join(root, 'source');
  const storageRoot = path.join(root, 'persistent');
  const backupRoot = path.join(root, 'backup');
  const bundled = path.join(sourceRoot, 'storage', 'tenants', 'demo-company', 'db.json');
  const live = path.join(storageRoot, 'tenants', 'demo-company', 'db.json');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(bundled, `${JSON.stringify(meaningfulPayload('bundle-'))}\n`, 'utf8');
  const corrupt = '{ this is not valid json '.repeat(100);
  fs.writeFileSync(live, corrupt, 'utf8');

  assert.throws(
    () => restoreBundledDemoTenantIfNeeded({ sourceRoot, storageRoot, backupRoot, logger: { info() {} } }),
    /unreadable or invalid JSON/,
  );
  assert.equal(fs.readFileSync(live, 'utf8'), corrupt);
  fs.rmSync(root, { recursive: true, force: true });
});
