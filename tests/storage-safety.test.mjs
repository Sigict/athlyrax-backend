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
function productionEnv(storageRoot, backupRoot, extra = {}) {
  return {
    NODE_ENV: 'production',
    ATHLYRAX_STORAGE_ROOT: storageRoot,
    ATHLYRAX_SAFETY_BACKUP_ROOT: backupRoot,
    AUTH_SECRET: 'test-production-secret-at-least-32-characters-long',
    ...extra,
  };
}
function prepareValidStorage(storageRoot, tenantId = 'demo-company', usersOverride = null) {
  fs.mkdirSync(path.join(storageRoot, 'auth'), { recursive: true });
  fs.mkdirSync(path.join(storageRoot, 'tenants', tenantId), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'db.json'), '{"__meta":{"tenantId":"global-owner"}}\n');
  const users = usersOverride || [{ username: 'softwareowner', role: 'software-owner', passwordHash: 'test-hash' }];
  const serializedUsers = `${JSON.stringify(users)}\n`;
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.json'), serializedUsers);
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.backup.json'), serializedUsers);
  fs.writeFileSync(path.join(storageRoot, 'auth-invites.json'), '[]\n');
  fs.writeFileSync(path.join(storageRoot, 'snapshot-submissions.json'), '[]\n');
  fs.writeFileSync(path.join(storageRoot, 'billing-catalog.json'), '{"plans":[{"key":"tier-1"}]}\n');
  fs.writeFileSync(path.join(storageRoot, 'tenants', tenantId, 'db.json'), `${JSON.stringify({ __meta: { tenantId }, swimmers: [] })}\n`);
  writeStorageReadyMarker(storageRoot, { requiredTenants: [tenantId] });
}

test('production requires explicit storage roots and a strong auth secret', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const configuration = resolveStorageConfiguration({ NODE_ENV: 'production' }, repoRoot);
  const failures = configuration.failures.join('\n');
  assert.match(failures, /ATHLYRAX_STORAGE_ROOT/);
  assert.match(failures, /ATHLYRAX_SAFETY_BACKUP_ROOT/);
  assert.match(failures, /AUTH_SECRET/);
});

test('Render deploy filesystem is rejected for production storage', () => {
  const configuration = resolveStorageConfiguration(productionEnv('/opt/render/project/src/storage', '/var/data/backups'), '/tmp/repo');
  assert.match(configuration.failures.join('\n'), /Render deploy filesystem/);
});

test('allowed persistent paths are accepted', () => {
  const configuration = resolveStorageConfiguration(productionEnv('/var/data/athlyrax', '/var/data/athlyrax-safety'), '/tmp/repo');
  assert.equal(configuration.storageRoot, '/var/data/athlyrax');
  assert.equal(configuration.authUsersPath, '/var/data/athlyrax/auth/auth-users.json');
  assert.equal(configuration.authUsersBackupPath, '/var/data/athlyrax/auth/auth-users.backup.json');
  assert.equal(configuration.legalAcceptancePath, '/var/data/athlyrax/legal-acceptances.jsonl');
  assert.equal(configuration.authInvitesPath, '/var/data/athlyrax/auth-invites.json');
  assert.equal(configuration.snapshotSubmissionsPath, '/var/data/athlyrax/snapshot-submissions.json');
  assert.equal(configuration.billingCatalogPath, '/var/data/athlyrax/billing-catalog.json');
  assert.equal(configuration.tenantRootPath, '/var/data/athlyrax/tenants');
  assert.equal(configuration.failures.length, 0);
});

test('production cannot disable authentication, tenant isolation or canonical auth storage', () => {
  const env = productionEnv('/var/data/athlyrax', '/var/data/athlyrax-safety', {
    AUTH_REQUIRED: 'false',
    PHASE1_TENANT_ISOLATION: 'false',
    AUTH_ENFORCE_CANONICAL_STORE: 'false',
  });
  const failures = resolveStorageConfiguration(env, '/tmp/repo').failures.join('\n');
  assert.match(failures, /AUTH_REQUIRED must not be false/);
  assert.match(failures, /PHASE1_TENANT_ISOLATION must not be false/);
  assert.match(failures, /AUTH_ENFORCE_CANONICAL_STORE must not be false/);
});

test('production rejects insecure auth and Stripe toggles', () => {
  const env = productionEnv('/var/data/athlyrax', '/var/data/athlyrax-safety', {
    AUTH_ALLOW_BEARER_COMPAT: 'true',
    AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE: 'true',
    STRIPE_SECRET_KEY: 'sk_test_configured',
    STRIPE_WEBHOOK_SECRET: '',
  });
  const failures = resolveStorageConfiguration(env, '/tmp/repo').failures.join('\n');
  assert.match(failures, /AUTH_ALLOW_BEARER_COMPAT must be false/);
  assert.match(failures, /AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE must be false/);
  assert.match(failures, /STRIPE_WEBHOOK_SECRET is required/);
});

test('production rejects default or weak auth secret', () => {
  for (const secret of ['', 'athlyrax-dev-secret-change-me', 'short-secret']) {
    const failures = resolveStorageConfiguration({
      NODE_ENV: 'production',
      ATHLYRAX_STORAGE_ROOT: '/var/data/athlyrax',
      ATHLYRAX_SAFETY_BACKUP_ROOT: '/var/data/athlyrax-safety',
      AUTH_SECRET: secret,
    }, '/tmp/repo').failures.join('\n');
    assert.match(failures, /AUTH_SECRET must be explicitly configured/);
  }
});

test('nested primary and backup roots are rejected', () => {
  const root = tempDir('athlyrax-nested-');
  const configuration = resolveStorageConfiguration(productionEnv(path.join(root, 'data'), path.join(root, 'data', 'backups')), root);
  assert.match(configuration.failures.join('\n'), /must not be nested/);
});

test('noncanonical auth path override is rejected', () => {
  const root = tempDir('athlyrax-auth-path-');
  const storageRoot = path.join(root, 'storage');
  const configuration = resolveStorageConfiguration(productionEnv(storageRoot, path.join(root, 'backup'), { AUTH_USERS_PATH: path.join(storageRoot, 'auth-users.json') }), root);
  assert.match(configuration.failures.join('\n'), /AUTH_USERS_PATH must equal the canonical path/);
});

test('noncanonical legal acceptance path override is rejected', () => {
  const root = tempDir('athlyrax-legal-path-');
  const storageRoot = path.join(root, 'storage');
  const configuration = resolveStorageConfiguration(productionEnv(storageRoot, path.join(root, 'backup'), { AUTH_LEGAL_ACCEPTANCE_PATH: path.join(root, 'elsewhere', 'legal.jsonl') }), root);
  assert.match(configuration.failures.join('\n'), /AUTH_LEGAL_ACCEPTANCE_PATH must equal the canonical path/);
});

test('production check succeeds only with marker and all startup-loaded stores', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  prepareValidStorage(storageRoot);
  const env = productionEnv(storageRoot, backupRoot, { ATHLYRAX_REQUIRED_TENANTS: 'demo-company' });
  const result = runStorageSafetyCheck({ env, repoRoot, createDirectories: true, requireFiles: true, logger: { info() {}, warn() {} } });
  assert.equal(result.configuration.storageRoot, path.resolve(storageRoot));
  assert.equal(env.AUTH_USERS_PATH, path.join(path.resolve(storageRoot), 'auth', 'auth-users.json'));
  assert.equal(env.AUTH_USERS_BACKUP_PATH, path.join(path.resolve(storageRoot), 'auth', 'auth-users.backup.json'));
  assert.equal(env.AUTH_LEGAL_ACCEPTANCE_PATH, path.join(path.resolve(storageRoot), 'legal-acceptances.jsonl'));
});

test('authentication primary and backup mismatch fails closed', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  prepareValidStorage(storageRoot);
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.backup.json'), '[{"username":"different","role":"software-owner","passwordHash":"x"}]\n');
  assert.throws(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot), repoRoot, logger: { info() {}, warn() {} } }), /primary and backup stores differ/);
});

test('every auth-bound tenant must have a non-empty canonical tenant database', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  const users = [
    { username: 'softwareowner', role: 'software-owner', passwordHash: 'owner-hash' },
    { username: 'coach-a', role: 'head-coach', passwordHash: 'coach-hash', tenantId: 'club-a' },
  ];
  prepareValidStorage(storageRoot, 'demo-company', users);
  assert.throws(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot), repoRoot, logger: { info() {}, warn() {} } }), /Auth-bound tenant database club-a/);
});

test('auth-bound tenant derivation from swim club and team is checked', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  const users = [
    { username: 'softwareowner', role: 'software-owner', passwordHash: 'owner-hash' },
    { username: 'coach-b', role: 'head-coach', passwordHash: 'coach-hash', swimClub: 'North Club', teamName: 'Senior Team' },
  ];
  prepareValidStorage(storageRoot, 'demo-company', users);
  const tenantPath = path.join(storageRoot, 'tenants', 'north-club__senior-team', 'db.json');
  fs.mkdirSync(path.dirname(tenantPath), { recursive: true });
  fs.writeFileSync(tenantPath, '{"__meta":{"tenantId":"north-club__senior-team"},"swimmers":[]}\n');
  assert.doesNotThrow(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot), repoRoot, logger: { info() {}, warn() {} } }));
});

test('missing required tenant DB fails closed', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  fs.mkdirSync(path.join(storageRoot, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'db.json'), '{"__meta":{"tenantId":"global-owner"}}\n');
  const users = '[{"username":"softwareowner","role":"software-owner","passwordHash":"test-hash"}]\n';
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.json'), users);
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.backup.json'), users);
  writeStorageReadyMarker(storageRoot);
  assert.throws(() => runStorageSafetyCheck({
    env: productionEnv(storageRoot, backupRoot, { ATHLYRAX_REQUIRED_TENANTS: 'demo-company' }),
    repoRoot, createDirectories: true, requireFiles: true, logger: { info() {}, warn() {} },
  }), /demo-company/);
});

test('empty production global database fails closed', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  prepareValidStorage(storageRoot);
  fs.writeFileSync(path.join(storageRoot, 'db.json'), '{}\n');
  assert.throws(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot, { ATHLYRAX_REQUIRED_TENANTS: 'demo-company' }), repoRoot, logger: { info() {}, warn() {} } }), /Global database must not be empty in production/);
});

test('empty production authentication store fails closed', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  prepareValidStorage(storageRoot);
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.json'), '[]\n');
  assert.throws(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot, { ATHLYRAX_REQUIRED_TENANTS: 'demo-company' }), repoRoot, logger: { info() {}, warn() {} } }), /at least one user in production/);
});

test('empty production required tenant database fails closed', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  prepareValidStorage(storageRoot);
  fs.writeFileSync(path.join(storageRoot, 'tenants', 'demo-company', 'db.json'), '{}\n');
  assert.throws(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot, { ATHLYRAX_REQUIRED_TENANTS: 'demo-company' }), repoRoot, logger: { info() {}, warn() {} } }), /Tenant database demo-company must not be empty in production/);
});

test('missing authentication backup fails closed', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  prepareValidStorage(storageRoot);
  fs.unlinkSync(path.join(storageRoot, 'auth', 'auth-users.backup.json'));
  assert.throws(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot, { ATHLYRAX_REQUIRED_TENANTS: 'demo-company' }), repoRoot, createDirectories: true, requireFiles: true, logger: { info() {}, warn() {} } }), /auth-users.backup.json/);
});

test('corrupt global database fails closed', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  prepareValidStorage(storageRoot);
  fs.writeFileSync(path.join(storageRoot, 'db.json'), '{invalid', 'utf8');
  assert.throws(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot, { ATHLYRAX_REQUIRED_TENANTS: 'demo-company' }), repoRoot, logger: { info() {}, warn() {} } }), /Global database is not valid JSON/);
});

test('corrupt authentication store fails closed', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  prepareValidStorage(storageRoot);
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.json'), '{invalid', 'utf8');
  assert.throws(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot, { ATHLYRAX_REQUIRED_TENANTS: 'demo-company' }), repoRoot, logger: { info() {}, warn() {} } }), /Authentication user store is not valid JSON/);
});

test('corrupt authentication backup fails closed', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  prepareValidStorage(storageRoot);
  fs.writeFileSync(path.join(storageRoot, 'auth', 'auth-users.backup.json'), '{invalid', 'utf8');
  assert.throws(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot, { ATHLYRAX_REQUIRED_TENANTS: 'demo-company' }), repoRoot, logger: { info() {}, warn() {} } }), /Authentication user backup is not valid JSON/);
});

test('corrupt required tenant database fails closed', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  prepareValidStorage(storageRoot);
  fs.writeFileSync(path.join(storageRoot, 'tenants', 'demo-company', 'db.json'), '{invalid', 'utf8');
  assert.throws(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot, { ATHLYRAX_REQUIRED_TENANTS: 'demo-company' }), repoRoot, logger: { info() {}, warn() {} } }), /Tenant database demo-company is not valid JSON/);
});

test('missing startup-loaded stores fail closed instead of being created', () => {
  for (const fileName of ['auth-invites.json', 'snapshot-submissions.json', 'billing-catalog.json']) {
    const repoRoot = tempDir('athlyrax-repo-');
    const storageRoot = tempDir('athlyrax-storage-');
    const backupRoot = tempDir('athlyrax-backup-');
    prepareValidStorage(storageRoot);
    fs.unlinkSync(path.join(storageRoot, fileName));
    assert.throws(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot), repoRoot, logger: { info() {}, warn() {} } }), /Required storage file is missing/);
  }
});

test('noncanonical tenant metadata fails closed', () => {
  const repoRoot = tempDir('athlyrax-repo-');
  const storageRoot = tempDir('athlyrax-storage-');
  const backupRoot = tempDir('athlyrax-backup-');
  const users = [{ username: 'coach-a', role: 'head-coach', passwordHash: 'x', tenantId: 'demo-company' }];
  prepareValidStorage(storageRoot, 'demo-company', users);
  fs.writeFileSync(path.join(storageRoot, 'tenants', 'demo-company', 'db.json'), '{"__meta":{"tenantId":"Demo.Company"},"swimmers":[]}\n');
  assert.throws(() => runStorageSafetyCheck({ env: productionEnv(storageRoot, backupRoot), repoRoot, logger: { info() {}, warn() {} } }), /noncanonical tenant ID/);
});
