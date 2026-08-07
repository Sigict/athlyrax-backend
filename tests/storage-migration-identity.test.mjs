import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateLegacyStorageIfNeeded, restoreBundledDemoTenantIfNeeded } from '../scripts/storage-path-contract.mjs';

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function meaningful(tenantId, prefix = 'row') {
  return {
    __meta: { tenantId },
    swimmers: Array.from({ length: 4 }, (_, index) => ({ id: `${prefix}-${index}` })),
  };
}

test('legacy tenant database with mismatched declared tenant is never copied into canonical storage', () => {
  const root = tempDir('athlyrax-legacy-identity-');
  const storageRoot = path.join(root, 'storage');
  const backupRoot = path.join(root, 'backup');
  const legacyDb = path.join(storageRoot, 'tenants', 'clubs', 'club-a', 'db.json');
  fs.mkdirSync(path.dirname(legacyDb), { recursive: true });
  fs.writeFileSync(legacyDb, `${JSON.stringify(meaningful('club-b'))}\n`, 'utf8');

  assert.throws(
    () => migrateLegacyStorageIfNeeded({ sourceRoot: root, storageRoot, backupRoot, logger: { info() {} } }),
    /Refusing cross-tenant migration or recovery/,
  );
  assert.equal(fs.existsSync(path.join(storageRoot, 'tenants', 'club-a', 'db.json')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy demo recovery source declaring another tenant is rejected without creating demo-company', () => {
  const root = tempDir('athlyrax-demo-legacy-identity-');
  const sourceRoot = path.join(root, 'source');
  const storageRoot = path.join(root, 'storage');
  const backupRoot = path.join(root, 'backup');
  const legacyDb = path.join(storageRoot, 'tenants', 'clubs', 'demo-company', 'db.json');
  const bundledDb = path.join(sourceRoot, 'storage', 'tenants', 'demo-company', 'db.json');
  fs.mkdirSync(path.dirname(legacyDb), { recursive: true });
  fs.mkdirSync(path.dirname(bundledDb), { recursive: true });
  fs.writeFileSync(legacyDb, `${JSON.stringify(meaningful('wrong-demo', 'legacy'))}\n`, 'utf8');
  fs.writeFileSync(bundledDb, `${JSON.stringify(meaningful('demo-company', 'bundle'))}\n`, 'utf8');

  assert.throws(
    () => restoreBundledDemoTenantIfNeeded({ sourceRoot, storageRoot, backupRoot, logger: { info() {} } }),
    /Refusing cross-tenant migration or recovery/,
  );
  assert.equal(fs.existsSync(path.join(storageRoot, 'tenants', 'demo-company', 'db.json')), false);
  fs.rmSync(root, { recursive: true, force: true });
});
