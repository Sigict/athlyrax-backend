import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { resolveStorageConfiguration } from '../scripts/storage-safety-lib.mjs';

const BACKEND_DIR = path.resolve(process.cwd());

function mkTempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createFixtureStorage(rootDir) {
  const storageRoot = path.join(rootDir, 'storage');
  const backupRoot = path.join(rootDir, 'backup');
  const authUsersPath = path.join(storageRoot, 'auth', 'auth-users.json');
  const authUsersBackupPath = path.join(storageRoot, 'auth', 'auth-users.backup.json');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });

  const now = new Date().toISOString();
  const users = [
    { username: 'softwareowner', password: 'Owner!Pass1234', role: 'software-owner', tenantId: 'global-owner', clubId: 'global-owner', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now },
    { username: 'coachA', password: 'CoachA!Pass1234', role: 'head-coach', tenantId: 'tenant-a', clubId: 'club-a', swimClub: 'Club A', teamName: 'Team A', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now },
    { username: 'coachB', password: 'CoachB!Pass1234', role: 'head-coach', tenantId: 'tenant-b', clubId: 'club-b', swimClub: 'Club B', teamName: 'Team B', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now },
    { username: 'viewerA', password: 'ViewerA!Pass1234', role: 'viewer', tenantId: 'tenant-a', clubId: 'club-a', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now },
    { username: 'coachA2', password: 'CoachA2!Pass1234', role: 'head-coach', tenantId: 'tenant-a', clubId: 'club-a', swimClub: 'Club A', teamName: 'Team A', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now },
    { username: 'assistA', password: 'AssistA!Pass1234', role: 'assistant-coach', tenantId: 'tenant-a', clubId: 'club-a', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now },
  ];

  writeJson(authUsersPath, users);
  writeJson(authUsersBackupPath, users);
  writeJson(path.join(storageRoot, 'auth-invites.json'), []);
  writeJson(path.join(storageRoot, 'db.json'), { swimmers: [{ id: 'owner-swimmer' }] });
  writeJson(path.join(storageRoot, 'tenants', 'tenant-a', 'db.json'), {
    swimmers: [{ id: 'swimmerA', name: 'Swimmer A' }], squads: [{ id: 'squadA', name: 'Squad A' }], trainingSessions: [{ id: 'sessionA', title: 'A Session' }],
  });
  writeJson(path.join(storageRoot, 'tenants', 'tenant-b', 'db.json'), {
    swimmers: [{ id: 'swimmerB', name: 'Swimmer B' }], squads: [{ id: 'squadB', name: 'Squad B' }], trainingSessions: [{ id: 'sessionB', title: 'B Session' }],
  });

  return { storageRoot, backupRoot, authUsersPath, authUsersBackupPath };
}

async function startServer(envOverrides = {}, existing = null) {
  const tempRoot = existing ? existing.tempRoot : mkTempDir('athlyrax-restore-drill-');
  const paths = existing ? existing.paths : createFixtureStorage(tempRoot);
  const port = String(3300 + Math.floor(Math.random() * 300));
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: port,
    AUTH_REQUIRED: 'true',
    AUTH_SECRET: 'this-is-a-very-strong-test-secret-value-1234',
    AUTH_ALLOW_COACH_SIGNUP: 'false',
    AUTH_ALLOW_COACH_INVITES: 'true',
    AUTH_PASSWORD_RESET_DELIVERY: 'console',
    AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE: 'false',
    FRONTEND_PUBLIC_ORIGIN: 'http://localhost:5173',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ATHLYRAX_STORAGE_ROOT: paths.storageRoot,
    ATHLYRAX_SAFETY_BACKUP_ROOT: paths.backupRoot,
    AUTH_USERS_PATH: paths.authUsersPath,
    AUTH_USERS_BACKUP_PATH: paths.authUsersBackupPath,
    ...envOverrides,
  };

  const child = spawn('node', ['index.js'], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => { stdout += String(buf || ''); });
  child.stderr.on('data', (buf) => { stderr += String(buf || ''); });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start. stdout=${stdout} stderr=${stderr}`)), 10000);
    const onData = () => {
      if (stdout.includes('Server running at')) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before ready. stdout=${stdout} stderr=${stderr}`));
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    tempRoot,
    stop: async () => {
      if (!child.killed) child.kill('SIGTERM');
      await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 2000); });
      if (!existing) fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function cookieHeader(response) {
  const rows = response.headers.getSetCookie ? response.headers.getSetCookie() : [String(response.headers.get('set-cookie') || '')];
  return rows.map((row) => String(row || '').split(';')[0].trim()).filter(Boolean).join('; ');
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `Login failed for ${username}: ${JSON.stringify(payload)}`);
  const cookie = cookieHeader(response);
  assert.ok(cookie.includes('athlyrax_session='), 'Expected auth session cookie');
  return { cookie, csrfToken: String(payload?.csrfToken || ''), csrfHeaderName: String(payload?.csrfHeaderName || 'x-csrf-token').toLowerCase() };
}

async function request(baseUrl, route, { method = 'GET', cookie = '', csrfToken = '', csrfHeaderName = 'x-csrf-token', headers = {}, body } = {}) {
  const finalHeaders = new Headers(headers);
  if (cookie) finalHeaders.set('Cookie', cookie);
  if (body !== undefined) finalHeaders.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && csrfToken) finalHeaders.set(csrfHeaderName, csrfToken);
  const response = await fetch(`${baseUrl}${route}`, { method, headers: finalHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

test('restore drill: club exports staged into a clean root boot and serve the same data per club', async () => {
  const work = mkTempDir('athlyrax-restore-work-');
  const source = await startServer();
  const exportsDir = path.join(work, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const exported = {};
  try {
    // 1. Back up: each club's database exported through the API as that club.
    for (const [user, password, tenant] of [['coachA', 'CoachA!Pass1234', 'tenant-a'], ['coachB', 'CoachB!Pass1234', 'tenant-b']]) {
      const session = await login(source.baseUrl, user, password);
      const response = await fetch(`${source.baseUrl}/db`, { headers: { Cookie: session.cookie } });
      assert.equal(response.status, 200);
      exported[tenant] = await response.json();
      writeJson(path.join(exportsDir, `${tenant}.json`), { ...exported[tenant], __meta: { ...(exported[tenant].__meta || {}), tenantId: tenant } });
    }
    writeJson(path.join(exportsDir, 'global.json'), { __meta: { tenantId: 'global-owner' }, swimmers: [] });
  } finally { await source.stop(); }

  // 2. Restore: stage into an empty directory (never production) and time it.
  const startedAt = Date.now();
  const stageDir = path.join(work, 'restored', 'storage');
  const staged = spawnSync(process.execPath, [path.join(BACKEND_DIR, 'scripts', 'stage-storage-restore.mjs'),
    '--destination', stageDir, '--global-db', path.join(exportsDir, 'global.json'),
    '--tenant', `tenant-a=${path.join(exportsDir, 'tenant-a.json')}`, '--tenant', `tenant-b=${path.join(exportsDir, 'tenant-b.json')}`,
    '--approve', 'STAGE_ONLY'], { cwd: BACKEND_DIR, encoding: 'utf8' });
  assert.equal(staged.status, 0, staged.stderr || staged.stdout);
  // Accounts are not in the API export; in a real incident they come from the
  // Render disk snapshot. The drill copies the fixture accounts.
  const fixture = createFixtureStorage(path.join(work, 'accounts'));
  const restoredPaths = { storageRoot: stageDir, backupRoot: path.join(work, 'restored', 'backup'),
    authUsersPath: path.join(stageDir, 'auth', 'auth-users.json'), authUsersBackupPath: path.join(stageDir, 'auth', 'auth-users.backup.json') };
  fs.mkdirSync(restoredPaths.backupRoot, { recursive: true });
  fs.mkdirSync(path.dirname(restoredPaths.authUsersPath), { recursive: true });
  fs.copyFileSync(fixture.authUsersPath, restoredPaths.authUsersPath);
  fs.copyFileSync(fixture.authUsersBackupPath, restoredPaths.authUsersBackupPath);

  // 3. Boot on the restored copy and read each club back.
  const restored = await startServer({}, { tempRoot: path.join(work, 'restored'), paths: restoredPaths });
  try {
    for (const [user, password, tenant, foreign] of [['coachA', 'CoachA!Pass1234', 'tenant-a', 'swimmerB'], ['coachB', 'CoachB!Pass1234', 'tenant-b', 'swimmerA']]) {
      const session = await login(restored.baseUrl, user, password);
      const response = await fetch(`${restored.baseUrl}/db`, { headers: { Cookie: session.cookie } });
      assert.equal(response.status, 200);
      const back = await response.json();
      assert.deepEqual(back.swimmers, exported[tenant].swimmers, `${tenant} swimmers restored`);
      assert.deepEqual(back.squads, exported[tenant].squads, `${tenant} squads restored`);
      assert.deepEqual(back.trainingSessions, exported[tenant].trainingSessions, `${tenant} sessions restored`);
      assert.ok(!JSON.stringify(back.swimmers || []).includes(foreign), `${tenant} does not see the other club`);
    }
    console.log(`ATHLYRAX_RESTORE_DRILL_RTO_MS=${Date.now() - startedAt}`);
  } finally {
    await restored.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
});
