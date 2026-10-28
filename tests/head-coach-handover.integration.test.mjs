import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
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

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

async function startServer(envOverrides = {}) {
  const tempRoot = mkTempDir('athlyrax-handover-');
  const paths = createFixtureStorage(tempRoot);
  // A port the operating system reports free, so parallel or back-to-back
  // servers never collide (a random port in a fixed range sometimes did).
  const port = String(await freePort());
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
      fs.rmSync(tempRoot, { recursive: true, force: true });
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

test('head-coach handover: the head coach passes the role to an assistant in one step', async () => {
  const server = await startServer();
  try {
    const coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const result = await request(server.baseUrl, '/auth/head-coach/handover', { method: 'POST', body: { username: 'assistA' }, ...coach });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.headCoach, 'assistA');
    assert.equal(result.payload.signInAgain, true);
    // The old session ends; both sign in again with their new roles.
    const stale = await request(server.baseUrl, '/db', { cookie: coach.cookie });
    assert.equal(stale.response.status, 401, 'old head-coach session revoked');
    const newHead = await login(server.baseUrl, 'assistA', 'AssistA!Pass1234');
    const me = await request(server.baseUrl, '/auth/me', newHead);
    assert.equal(me.payload?.user?.role, 'head-coach');
    const former = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const formerMe = await request(server.baseUrl, '/auth/me', former);
    assert.equal(formerMe.payload?.user?.role, 'assistant-coach');
    // The former head coach can no longer hand anything over.
    const again = await request(server.baseUrl, '/auth/head-coach/handover', { method: 'POST', body: { username: 'assistA' }, ...former });
    assert.equal(again.response.status, 403);
  } finally { await server.stop(); }
});

test('head-coach handover is refused for assistants, viewers, other clubs and yourself', async () => {
  const server = await startServer();
  try {
    const assistant = await login(server.baseUrl, 'assistA', 'AssistA!Pass1234');
    const byAssistant = await request(server.baseUrl, '/auth/head-coach/handover', { method: 'POST', body: { username: 'assistA' }, ...assistant });
    assert.equal(byAssistant.response.status, 403, 'an assistant cannot make themselves head coach');
    const coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    for (const [username, status, why] of [['viewerA', 400, 'viewer'], ['coachB', 403, 'other club'], ['coachA', 400, 'self'], ['nobody', 404, 'unknown']]) {
      const result = await request(server.baseUrl, '/auth/head-coach/handover', { method: 'POST', body: { username }, ...coach });
      assert.equal(result.response.status, status, `${why}: ${JSON.stringify(result.payload)}`);
    }
    const still = await request(server.baseUrl, '/auth/me', coach);
    assert.equal(still.payload?.user?.role, 'head-coach', 'refused handovers change nothing');
  } finally { await server.stop(); }
});
