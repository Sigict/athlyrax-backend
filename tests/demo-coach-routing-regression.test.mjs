import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalStoragePaths } from '../scripts/storage-path-contract.mjs';

const root = path.resolve(process.cwd());

function meaningfulRowCount(db) {
  return Object.values(db && typeof db === 'object' ? db : {})
    .filter(Array.isArray)
    .reduce((sum, rows) => sum + rows.length, 0);
}

test('demo.coach resolves to the populated canonical demo-company tenant', () => {
  const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

  assert.match(indexSource, /const DB_TENANTS_DIR = path\.join\(STORAGE_ROOT, 'tenants'\);/);
  assert.doesNotMatch(indexSource, /path\.join\(STORAGE_ROOT, 'tenants', 'clubs'\)/);
  assert.match(indexSource, /'demo\.coach': 'demo-company'/);
  assert.match(indexSource, /const canonicalTenantId = CANONICAL_TENANT_BY_USERNAME\[String\(user\?\.username \|\| ''\)\.trim\(\)\.toLowerCase\(\)\];/);
  assert.match(indexSource, /if \(canonicalTenantId\) return canonicalTenantId;/);

  const storageRoot = path.join(root, 'storage');
  const paths = canonicalStoragePaths({ sourceRoot: root, storageRoot });
  const expectedDemoDb = path.join(storageRoot, 'tenants', 'demo-company', 'db.json');
  assert.equal(paths.tenantDb('demo-company'), expectedDemoDb);
  assert.equal(fs.existsSync(expectedDemoDb), true, 'Bundled canonical demo-company database must exist.');

  const demoDb = JSON.parse(fs.readFileSync(expectedDemoDb, 'utf8'));
  assert.ok(meaningfulRowCount(demoDb) > 0, 'Bundled demo-company database must contain meaningful demo records.');
  const declaredTenant = String(demoDb?.__meta?.tenantId || '').trim();
  if (declaredTenant) assert.equal(declaredTenant, 'demo-company');
});
