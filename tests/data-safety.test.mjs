import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installDataSafetyGuards } from '../scripts/data-safety-preload.mjs';

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}
function withGuard(root, run, extraEnv = {}) {
  const installation = installDataSafetyGuards({ fsModule: fs, env: { ATHLYRAX_SAFETY_BACKUP_ROOT: path.join(root, 'safety'), ...extraEnv }, logger: { info() {}, error() {} } });
  try { return run(); } finally { installation.uninstall(); }
}
function provisioningToken(secret, destination) { return crypto.createHmac('sha256', secret).update(path.resolve(destination)).digest('hex'); }

test('corrupt current database is never overwritten and its bytes are backed up', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-current-');
  const destination = path.join(root, 'tenant', 'db.json');
  const source = path.join(root, 'tenant', 'db.json.tmp');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const corrupt = '{not valid json';
  fs.writeFileSync(destination, corrupt, 'utf8');
  writeJson(source, { swimmers: [], __meta: { storageRevision: 0 } });
  withGuard(root, () => { assert.throws(() => fs.renameSync(source, destination), (error) => error?.code === 'ATHLYRAX_CURRENT_DB_INVALID'); });
  assert.equal(fs.readFileSync(destination, 'utf8'), corrupt);
  const backupRoot = path.join(root, 'safety', 'invalid-current-blocked');
  assert.equal(fs.existsSync(backupRoot), true);
  const scope = fs.readdirSync(backupRoot)[0];
  const backup = path.join(backupRoot, scope, fs.readdirSync(path.join(backupRoot, scope))[0]);
  assert.equal(fs.readFileSync(backup, 'utf8'), corrupt);
  fs.rmSync(root, { recursive: true, force: true });
});

test('invalid incoming database is rejected before replacement', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-incoming-');
  const destination = path.join(root, 'tenant', 'db.json');
  const source = path.join(root, 'tenant', 'db.json.tmp');
  writeJson(destination, { swimmers: [{ id: 'keep' }], __meta: { storageRevision: 3 } });
  fs.writeFileSync(source, '{invalid', 'utf8');
  withGuard(root, () => { assert.throws(() => fs.renameSync(source, destination), (error) => error?.code === 'ATHLYRAX_INCOMING_DB_INVALID'); });
  assert.equal(JSON.parse(fs.readFileSync(destination, 'utf8')).swimmers[0].id, 'keep');
  fs.rmSync(root, { recursive: true, force: true });
});

test('valid matching-revision database replacement increments revision and preserves pre-write backup', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-valid-');
  const destination = path.join(root, 'tenant', 'db.json');
  const source = path.join(root, 'tenant', 'db.json.tmp');
  writeJson(destination, { swimmers: [{ id: 'old' }], __meta: { storageRevision: 4 } });
  writeJson(source, { swimmers: [{ id: 'new' }], __meta: { storageRevision: 4 } });
  withGuard(root, () => fs.renameSync(source, destination));
  const next = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.equal(next.swimmers[0].id, 'new');
  assert.equal(next.__meta.storageRevision, 5);
  assert.equal(fs.existsSync(path.join(root, 'safety', 'pre-write')), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy database without storage revision can be adopted exactly once at revision one', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-legacy-revision-');
  const destination = path.join(root, 'tenant', 'db.json');
  const source = path.join(root, 'tenant', 'db.json.tmp');
  writeJson(destination, { swimmers: [{ id: 'old' }], __meta: {} });
  writeJson(source, { swimmers: [{ id: 'new' }], __meta: {} });
  withGuard(root, () => fs.renameSync(source, destination));
  const next = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.equal(next.swimmers[0].id, 'new');
  assert.equal(next.__meta.storageRevision, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy database accepts an explicit incoming revision zero and advances to revision one', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-legacy-zero-');
  const destination = path.join(root, 'tenant', 'db.json');
  const source = path.join(root, 'tenant', 'db.json.tmp');
  writeJson(destination, { swimmers: [{ id: 'old' }], __meta: {} });
  writeJson(source, { swimmers: [{ id: 'new-zero' }], __meta: { storageRevision: 0 } });
  withGuard(root, () => fs.renameSync(source, destination));
  const next = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.equal(next.swimmers[0].id, 'new-zero');
  assert.equal(next.__meta.storageRevision, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy database rejects an incoming positive revision instead of guessing lineage', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-legacy-positive-conflict-');
  const destination = path.join(root, 'tenant', 'db.json');
  const source = path.join(root, 'tenant', 'db.json.tmp');
  writeJson(destination, { swimmers: [{ id: 'keep' }], __meta: {} });
  writeJson(source, { swimmers: [{ id: 'wrong-lineage' }], __meta: { storageRevision: 2 } });
  withGuard(root, () => {
    assert.throws(() => fs.renameSync(source, destination), (error) => error?.code === 'ATHLYRAX_DB_REVISION_CONFLICT');
  });
  assert.equal(JSON.parse(fs.readFileSync(destination, 'utf8')).swimmers[0].id, 'keep');
  fs.rmSync(root, { recursive: true, force: true });
});

test('existing database with core records cannot be replaced by a zero-record payload', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-total-wipe-');
  const destination = path.join(root, 'tenant', 'db.json');
  const source = path.join(root, 'tenant', 'db.json.tmp');
  writeJson(destination, { swimmers: [{ id: 'keep' }], tests: [{ id: 'test-1' }], __meta: { storageRevision: 2 } });
  writeJson(source, { swimmers: [], tests: [], __meta: { storageRevision: 2 } });
  withGuard(root, () => { assert.throws(() => fs.renameSync(source, destination), (error) => error?.code === 'ATHLYRAX_DB_TOTAL_DATA_WIPE_BLOCKED'); });
  assert.equal(JSON.parse(fs.readFileSync(destination, 'utf8')).swimmers[0].id, 'keep');
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing production database cannot be silently recreated from an ordinary write', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-missing-');
  const destination = path.join(root, 'tenant', 'db.json');
  const source = path.join(root, 'tenant', 'db.json.tmp');
  writeJson(source, { swimmers: [] });
  withGuard(root, () => { assert.throws(() => fs.renameSync(source, destination), (error) => error?.code === 'ATHLYRAX_MISSING_DB_CREATE_BLOCKED'); }, { NODE_ENV: 'production', AUTH_SECRET: 'test-auth-secret-at-least-32-characters-long' });
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(source), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('forged client provisioning metadata cannot recreate a missing production database', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-forged-provision-');
  const destination = path.join(root, 'tenant', 'db.json');
  const source = path.join(root, 'tenant', 'db.json.tmp');
  writeJson(source, { __meta: { provisionedBy: 'auth-register', provisioningToken: 'client-controlled-token' }, swimmers: [] });
  withGuard(root, () => { assert.throws(() => fs.renameSync(source, destination), (error) => error?.code === 'ATHLYRAX_MISSING_DB_CREATE_BLOCKED'); }, { NODE_ENV: 'production', AUTH_SECRET: 'test-auth-secret-at-least-32-characters-long' });
  assert.equal(fs.existsSync(destination), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('server-bound tenant provisioning may create a new production database and strips the one-time token', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-provision-');
  const storageRoot = path.join(root, 'storage');
  const destination = path.join(storageRoot, 'tenants', 'club-a', 'db.json');
  const source = path.join(storageRoot, 'tenants', 'club-a', 'db.json.tmp');
  const secret = 'test-auth-secret-at-least-32-characters-long';
  writeJson(source, { __meta: { tenantId: 'club-a', provisionedBy: 'auth-register', provisioningToken: provisioningToken(secret, destination) }, swimmers: [] });
  withGuard(root, () => fs.renameSync(source, destination), { NODE_ENV: 'production', AUTH_SECRET: secret, ATHLYRAX_STORAGE_ROOT: storageRoot });
  const created = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.equal(created.__meta.tenantId, 'club-a');
  assert.equal(created.__meta.provisionedBy, 'auth-register');
  assert.equal(created.__meta.provisioningToken, undefined);
  assert.equal(created.__meta.storageRevision, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('incoming cross-tenant database cannot replace another tenant database', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-cross-tenant-incoming-');
  const storageRoot = path.join(root, 'storage');
  const destination = path.join(storageRoot, 'tenants', 'club-a', 'db.json');
  const source = path.join(storageRoot, 'tenants', 'club-a', 'db.json.tmp');
  writeJson(destination, { __meta: { tenantId: 'club-a', storageRevision: 2 }, swimmers: [{ id: 'keep-a' }] });
  writeJson(source, { __meta: { tenantId: 'club-b', storageRevision: 2 }, swimmers: [{ id: 'wrong-b' }] });
  withGuard(root, () => { assert.throws(() => fs.renameSync(source, destination), (error) => error?.code === 'ATHLYRAX_DB_TENANT_IDENTITY_CONFLICT'); }, { NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: storageRoot, AUTH_SECRET: 'test-auth-secret-at-least-32-characters-long' });
  assert.equal(JSON.parse(fs.readFileSync(destination, 'utf8')).swimmers[0].id, 'keep-a');
  fs.rmSync(root, { recursive: true, force: true });
});

test('tenant write with missing identity is canonicalized to destination tenant', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-canonicalize-tenant-');
  const storageRoot = path.join(root, 'storage');
  const destination = path.join(storageRoot, 'tenants', 'club-a', 'db.json');
  const source = path.join(storageRoot, 'tenants', 'club-a', 'db.json.tmp');
  writeJson(destination, { __meta: { tenantId: 'club-a', storageRevision: 1 }, swimmers: [{ id: 'old' }] });
  writeJson(source, { __meta: { storageRevision: 1 }, swimmers: [{ id: 'new' }] });
  withGuard(root, () => fs.renameSync(source, destination), { NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: storageRoot, AUTH_SECRET: 'test-auth-secret-at-least-32-characters-long' });
  const updated = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.equal(updated.__meta.tenantId, 'club-a');
  assert.equal(updated.__meta.storageRevision, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('critical auth store replacement preserves independent pre-write backup', { concurrency: false }, () => {
  const root = tempDir('athlyrax-critical-auth-backup-');
  const storageRoot = path.join(root, 'storage');
  const destination = path.join(storageRoot, 'auth', 'auth-users.json');
  const source = path.join(storageRoot, 'auth', 'auth-users.json.tmp');
  writeJson(destination, [{ username: 'old-user', role: 'head-coach' }]);
  writeJson(source, [{ username: 'new-user', role: 'head-coach' }]);
  withGuard(root, () => fs.renameSync(source, destination), { NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: storageRoot });
  assert.equal(JSON.parse(fs.readFileSync(destination, 'utf8'))[0].username, 'new-user');
  const backupRoot = path.join(root, 'safety', 'pre-write-auth-users');
  assert.equal(fs.existsSync(backupRoot), true);
  const scope = fs.readdirSync(backupRoot)[0];
  const backup = path.join(backupRoot, scope, fs.readdirSync(path.join(backupRoot, scope))[0]);
  assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8'))[0].username, 'old-user');
  fs.rmSync(root, { recursive: true, force: true });
});

test('invalid critical auth replacement is blocked before current store changes', { concurrency: false }, () => {
  const root = tempDir('athlyrax-critical-auth-invalid-');
  const storageRoot = path.join(root, 'storage');
  const destination = path.join(storageRoot, 'auth', 'auth-users.json');
  const source = path.join(storageRoot, 'auth', 'auth-users.json.tmp');
  writeJson(destination, [{ username: 'keep-user', role: 'head-coach' }]);
  writeJson(source, []);
  withGuard(root, () => { assert.throws(() => fs.renameSync(source, destination), (error) => error?.code === 'ATHLYRAX_CRITICAL_STORE_INCOMING_INVALID'); }, { NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: storageRoot });
  assert.equal(JSON.parse(fs.readFileSync(destination, 'utf8'))[0].username, 'keep-user');
  fs.rmSync(root, { recursive: true, force: true });
});

test('non-empty snapshot history cannot be silently replaced by an empty critical store', { concurrency: false }, () => {
  const root = tempDir('athlyrax-critical-snapshot-');
  const storageRoot = path.join(root, 'storage');
  const destination = path.join(storageRoot, 'snapshot-submissions.json');
  const source = path.join(storageRoot, 'snapshot-submissions.json.tmp');
  writeJson(destination, [{ id: 'old' }]);
  writeJson(source, []);
  withGuard(root, () => { assert.throws(() => fs.renameSync(source, destination), (error) => error?.code === 'ATHLYRAX_SNAPSHOT_HISTORY_EMPTY_WIPE_BLOCKED'); }, { NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: storageRoot });
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), [{ id: 'old' }]);
  fs.rmSync(root, { recursive: true, force: true });
});