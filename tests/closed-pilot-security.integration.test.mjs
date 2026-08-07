import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BACKEND_DIR = path.resolve(process.cwd());

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
  ];

  writeJson(authUsersPath, users);
  writeJson(authUsersBackupPath, users);
  writeJson(path.join(storageRoot, 'auth-invites.json'), []);
  writeJson(path.join(storageRoot, 'db.json'), { swimmers: [{ id: 'owner-swimmer' }] });
  writeJson(path.join(storageRoot, 'tenants', 'tenant-a', 'db.json'), {
    swimmers: [{ id: 'swimmerA', name: 'Swimmer A' }],
    squads: [{ id: 'squadA', name: 'Squad A' }],
    trainingSessions: [{ id: 'sessionA', title: 'A Session' }],
  });
  writeJson(path.join(storageRoot, 'tenants', 'tenant-b', 'db.json'), {
    swimmers: [{ id: 'swimmerB', name: 'Swimmer B' }],
    squads: [{ id: 'squadB', name: 'Squad B' }],
    trainingSessions: [{ id: 'sessionB', title: 'B Session' }],
  });

  return { storageRoot, backupRoot, authUsersPath, authUsersBackupPath };
}

async function startServer(envOverrides = {}) {
  const tempRoot = mkTempDir('athlyrax-closed-pilot-');
  const paths = createFixtureStorage(tempRoot);
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
    ATHLYRAX_SAFE_START_ENFORCED: 'true',
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
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 2000);
      });
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function cookieHeader(response) {
  const rows = response.headers.getSetCookie ? response.headers.getSetCookie() : [String(response.headers.get('set-cookie') || '')];
  return rows.map((row) => String(row || '').split(';')[0].trim()).filter(Boolean).join('; ');
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `Login failed for ${username}: ${JSON.stringify(payload)}`);
  const cookie = cookieHeader(response);
  assert.ok(cookie.includes('athlyrax_session='), 'Expected auth session cookie');
  return {
    cookie,
    csrfToken: String(payload?.csrfToken || ''),
    csrfHeaderName: String(payload?.csrfHeaderName || 'x-csrf-token').toLowerCase(),
  };
}

async function request(baseUrl, route, { method = 'GET', cookie = '', csrfToken = '', csrfHeaderName = 'x-csrf-token', headers = {}, body } = {}) {
  const finalHeaders = new Headers(headers);
  if (cookie) finalHeaders.set('Cookie', cookie);
  if (body !== undefined) finalHeaders.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && csrfToken) finalHeaders.set(csrfHeaderName, csrfToken);
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

test('cookie authentication works against canonical auth store', async () => {
  const server = await startServer();
  try {
    const session = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const me = await request(server.baseUrl, '/auth/me', { cookie: session.cookie });
    assert.equal(me.response.status, 200);
    assert.equal(me.payload?.user?.username, 'coachA');
    assert.equal(me.payload?.user?.tenantId, 'tenant-a');
  } finally { await server.stop(); }
});

test('state-changing database requests require csrf', async () => {
  const server = await startServer();
  try {
    const session = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const missing = await request(server.baseUrl, '/db', { method: 'PUT', cookie: session.cookie, body: { swimmers: [] } });
    assert.equal(missing.response.status, 403);
  } finally { await server.stop(); }
});

test('logout destroys the session without allowing csrf state to trap the user', async () => {
  const server = await startServer();
  try {
    const session = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const out = await request(server.baseUrl, '/auth/logout', { method: 'POST', cookie: session.cookie });
    assert.equal(out.response.status, 200);
    const after = await request(server.baseUrl, '/auth/me', { cookie: session.cookie });
    assert.equal(after.response.status, 401);
  } finally { await server.stop(); }
});

test('tenant isolation reads only the canonical tenant database', async () => {
  const server = await startServer();
  try {
    const a = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const b = await login(server.baseUrl, 'coachB', 'CoachB!Pass1234');
    const aRead = await request(server.baseUrl, '/db', { cookie: a.cookie });
    const bRead = await request(server.baseUrl, '/db', { cookie: b.cookie });
    assert.equal(aRead.response.status, 200);
    assert.equal(bRead.response.status, 200);
    const aIds = new Set((aRead.payload?.swimmers || []).map((row) => row.id));
    const bIds = new Set((bRead.payload?.swimmers || []).map((row) => row.id));
    assert.ok(aIds.has('swimmerA'));
    assert.ok(!aIds.has('swimmerB'));
    assert.ok(bIds.has('swimmerB'));
    assert.ok(!bIds.has('swimmerA'));
  } finally { await server.stop(); }
});

test('cross-tenant override is blocked for coaches and requires owner reason', async () => {
  const server = await startServer();
  try {
    const coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const owner = await login(server.baseUrl, 'softwareowner', 'Owner!Pass1234');
    const denied = await request(server.baseUrl, '/db', { cookie: coach.cookie, headers: { 'x-athlyrax-tenant': 'tenant-b' } });
    assert.equal(denied.response.status, 403);
    const missingReason = await request(server.baseUrl, '/db', { cookie: owner.cookie, headers: { 'x-athlyrax-tenant': 'tenant-a' } });
    assert.equal(missingReason.response.status, 400);
    const allowed = await request(server.baseUrl, '/db', {
      cookie: owner.cookie,
      headers: { 'x-athlyrax-tenant': 'tenant-a', 'x-athlyrax-tenant-reason': 'support-test' },
    });
    assert.equal(allowed.response.status, 200);
  } finally { await server.stop(); }
});

test('viewer cannot write tenant database', async () => {
  const server = await startServer();
  try {
    const viewer = await login(server.baseUrl, 'viewerA', 'ViewerA!Pass1234');
    const result = await request(server.baseUrl, '/db', {
      method: 'PUT',
      cookie: viewer.cookie,
      csrfToken: viewer.csrfToken,
      csrfHeaderName: viewer.csrfHeaderName,
      body: { swimmers: [{ id: 'forbidden' }] },
    });
    assert.equal(result.response.status, 403);
  } finally { await server.stop(); }
});

test('production rejects bearer compatibility mode', async () => {
  const tempRoot = mkTempDir('athlyrax-prod-bearer-reject-');
  const paths = createFixtureStorage(tempRoot);
  const child = spawn('node', ['index.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: '3499',
      AUTH_REQUIRED: 'true',
      AUTH_SECRET: 'this-is-a-very-strong-production-test-secret-1234',
      AUTH_ALLOW_COACH_SIGNUP: 'false',
      AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE: 'false',
      FRONTEND_PUBLIC_ORIGIN: 'https://athlyrax.com',
      ALLOWED_ORIGINS: 'https://athlyrax.com',
      ATHLYRAX_STORAGE_ROOT: paths.storageRoot,
      ATHLYRAX_SAFETY_BACKUP_ROOT: paths.backupRoot,
      AUTH_USERS_PATH: paths.authUsersPath,
      AUTH_USERS_BACKUP_PATH: paths.authUsersBackupPath,
      ATHLYRAX_SAFE_START_ENFORCED: 'true',
      AUTH_ALLOW_BEARER_COMPAT: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (buf) => { stderr += String(buf || ''); });
  const exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(Number(code || 0))));
  fs.rmSync(tempRoot, { recursive: true, force: true });
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /AUTH_ALLOW_BEARER_COMPAT must be false in production/);
});
