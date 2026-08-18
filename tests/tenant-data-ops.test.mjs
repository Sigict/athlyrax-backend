import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  exportTenantData,
  retireTenantData,
  purgeRetiredTenantArchive,
} from '../scripts/tenant-data-ops.mjs';

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function createStorage(root) {
  const storageRoot = path.join(root, 'storage');
  const backupRoot = path.join(root, 'backup');
  fs.mkdirSync(backupRoot, { recursive: true });
  writeJson(path.join(storageRoot, 'tenants', 'club-a', 'db.json'), {
    __meta: { tenantId: 'club-a' },
    swimmers: [{ id: 'swimmer-a', name: 'A' }],
    squads: [{ id: 'squad-a', name: 'A Squad' }],
  });
  writeJson(path.join(storageRoot, 'tenants', 'club-b', 'db.json'), {
    __meta: { tenantId: 'club-b' },
    swimmers: [{ id: 'swimmer-b', name: 'B' }],
  });
  const users = [
    { username: 'coach-a', email: 'a@example.test', role: 'head-coach', tenantId: 'club-a', passwordHash: 'scrypt$SECRET$HASH', tokenValidAfter: 123, billing: { planKey: 'manual' } },
    { username: 'assistant-a', email: 'assistant@example.test', role: 'assistant-coach', tenantId: 'club-a', passwordHash: 'scrypt$SECOND$HASH' },
    { username: 'coach-b', email: 'b@example.test', role: 'head-coach', tenantId: 'club-b', passwordHash: 'scrypt$OTHER$HASH' },
  ];
  writeJson(path.join(storageRoot, 'auth', 'auth-users.json'), users);
  writeJson(path.join(storageRoot, 'auth', 'auth-users.backup.json'), users);
  fs.writeFileSync(path.join(storageRoot, 'legal-acceptances.jsonl'), [
    JSON.stringify({ eventId: 'legal-a', tenantId: 'club-a', username: 'coach-a', ipAddress: '192.0.2.1' }),
    JSON.stringify({ eventId: 'legal-b', tenantId: 'club-b', username: 'coach-b', ipAddress: '192.0.2.2' }),
  ].join('\n') + '\n');
  return { storageRoot, backupRoot };
}

test('tenant export is tenant-scoped, portable and excludes credential secrets', () => {
  const root = tempDir('athlyrax-tenant-export-');
  try {
    const { storageRoot } = createStorage(root);
    const destination = path.join(root, 'export');
    const result = exportTenantData({ tenantId: 'club-a', storageRoot, destination });
    assert.equal(result.manifest.tenantId, 'club-a');
    assert.equal(result.manifest.operation, 'tenant-data-export');
    assert.equal(result.manifest.accountCount, 2);
    assert.equal(result.manifest.legalAcceptanceCount, 1);
    assert.ok(result.manifest.files.every((row) => /^[a-f0-9]{64}$/.test(row.sha256)));

    const tenant = JSON.parse(fs.readFileSync(path.join(destination, 'tenant-data.json'), 'utf8'));
    assert.equal(tenant.__meta.tenantId, 'club-a');
    assert.equal(tenant.swimmers[0].id, 'swimmer-a');

    const accounts = JSON.parse(fs.readFileSync(path.join(destination, 'accounts.json'), 'utf8'));
    assert.deepEqual(accounts.map((row) => row.username).sort(), ['assistant-a', 'coach-a']);
    for (const row of accounts) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, 'passwordHash'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(row, 'password'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(row, 'tokenValidAfter'), false);
    }
    assert.equal(JSON.stringify(accounts).includes('coach-b'), false);

    const legal = fs.readFileSync(path.join(destination, 'legal-acceptances.jsonl'), 'utf8');
    assert.match(legal, /legal-a/);
    assert.doesNotMatch(legal, /legal-b/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tenant export rejects cross-tenant identity and live-storage destination', () => {
  const root = tempDir('athlyrax-tenant-export-guard-');
  try {
    const { storageRoot } = createStorage(root);
    const wrong = path.join(storageRoot, 'tenants', 'club-a', 'db.json');
    writeJson(wrong, { __meta: { tenantId: 'club-b' }, swimmers: [] });
    assert.throws(() => exportTenantData({ tenantId: 'club-a', storageRoot, destination: path.join(root, 'out') }), /declares tenant club-b/);
    writeJson(wrong, { __meta: { tenantId: 'club-a' }, swimmers: [] });
    assert.throws(() => exportTenantData({ tenantId: 'club-a', storageRoot, destination: path.join(storageRoot, 'exports', 'club-a') }), /outside production storage/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('retirement creates and verifies a safety archive before removing live tenant data', () => {
  const root = tempDir('athlyrax-tenant-retire-');
  try {
    const { storageRoot, backupRoot } = createStorage(root);
    const result = retireTenantData({ tenantId: 'club-a', storageRoot, backupRoot });
    assert.equal(fs.existsSync(path.join(storageRoot, 'tenants', 'club-a')), false);
    assert.equal(fs.existsSync(path.join(storageRoot, 'tenants', 'club-b', 'db.json')), true);
    assert.equal(fs.existsSync(path.join(result.archiveDir, 'db.json')), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.archiveDir, 'retirement-manifest.json'), 'utf8'));
    assert.equal(manifest.tenantId, 'club-a');
    assert.equal(manifest.operation, 'tenant-data-retirement');
    assert.ok(manifest.files.length >= 1);
    assert.ok(manifest.files.every((row) => /^[a-f0-9]{64}$/.test(row.sha256)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('retirement refuses protected tenants and nested backup roots', () => {
  const root = tempDir('athlyrax-tenant-retire-guard-');
  try {
    const { storageRoot, backupRoot } = createStorage(root);
    for (const tenantId of ['global-owner', 'demo-company', 'snapshot-public']) {
      assert.throws(() => retireTenantData({ tenantId, storageRoot, backupRoot }), /cannot be retired/);
    }
    assert.throws(() => retireTenantData({ tenantId: 'club-a', storageRoot, backupRoot: path.join(storageRoot, 'backup') }), /separate and non-nested/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('retired archive purge verifies manifest and hashes before final deletion', () => {
  const root = tempDir('athlyrax-tenant-purge-');
  try {
    const { storageRoot, backupRoot } = createStorage(root);
    const retired = retireTenantData({ tenantId: 'club-a', storageRoot, backupRoot });
    const result = purgeRetiredTenantArchive({ tenantId: 'club-a', backupRoot, archive: retired.archiveDir });
    assert.equal(result.tenantId, 'club-a');
    assert.equal(fs.existsSync(retired.archiveDir), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('retired archive purge fails closed after tampering', () => {
  const root = tempDir('athlyrax-tenant-purge-tamper-');
  try {
    const { storageRoot, backupRoot } = createStorage(root);
    const retired = retireTenantData({ tenantId: 'club-a', storageRoot, backupRoot });
    fs.appendFileSync(path.join(retired.archiveDir, 'db.json'), '\nTAMPERED\n');
    assert.throws(() => purgeRetiredTenantArchive({ tenantId: 'club-a', backupRoot, archive: retired.archiveDir }), /integrity verification failed/);
    assert.equal(fs.existsSync(retired.archiveDir), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
