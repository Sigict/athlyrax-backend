import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const RENDER_BACKEND_DIR = path.resolve(process.cwd());

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
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });

  const users = [
    {
      username: 'softwareowner',
      password: 'Owner!Pass1234',
      role: 'software-owner',
      tenantId: 'global-owner',
      clubId: 'global-owner',
      createdVia: 'admin',
      isApproved: true,
      onboardingCompletedAt: new Date().toISOString(),
    },
    {
      username: 'coachA',
      password: 'CoachA!Pass1234',
      role: 'head-coach',
      tenantId: 'tenant-a',
      clubId: 'club-a',
      swimClub: 'Club A',
      teamName: 'Team A',
      createdVia: 'admin',
      isApproved: true,
      onboardingCompletedAt: new Date().toISOString(),
    },
    {
      username: 'coachB',
      password: 'CoachB!Pass1234',
      role: 'head-coach',
      tenantId: 'tenant-b',
      clubId: 'club-b',
      swimClub: 'Club B',
      teamName: 'Team B',
      createdVia: 'admin',
      isApproved: true,
      onboardingCompletedAt: new Date().toISOString(),
    },
    {
      username: 'viewerA',
      password: 'ViewerA!Pass1234',
      role: 'viewer',
      tenantId: 'tenant-a',
      clubId: 'club-a',
      createdVia: 'admin',
      isApproved: true,
      onboardingCompletedAt: new Date().toISOString(),
    },
    {
      username: 'assistantA',
      password: 'AssistantA!Pass1234',
      role: 'assistant-coach',
      tenantId: 'tenant-a',
      clubId: 'club-a',
      createdVia: 'admin',
      isApproved: true,
      onboardingCompletedAt: new Date().toISOString(),
    },
  ];

  writeJson(path.join(storageRoot, 'auth-users.json'), users);
  writeJson(path.join(storageRoot, 'auth-invites.json'), [
    {
      code: 'EXPR-TEST-0001',
      role: 'viewer',
      createdBy: 'softwareowner',
      tenantId: 'tenant-a',
      clubId: 'club-a',
      createdAt: '2024-01-01T00:00:00.000Z',
      expiresAt: '2024-01-01T00:10:00.000Z',
      targetEmail: 'expired+invite@example.test',
      maxUses: 1,
      usedCount: 0,
      disabled: false,
    },
  ]);

  writeJson(path.join(storageRoot, 'tenants', 'clubs', 'tenant-a', 'db.json'), {
    swimmers: [{ id: 'swimmerA', name: 'Swimmer A' }],
    squads: [{ id: 'squadA', name: 'Squad A' }],
    trainingSessions: [{ id: 'sessionA', title: 'A Session' }],
    tests: [{ id: 'testA', name: 'A Test' }],
    attendance: [{ id: 'attendanceA', swimmerId: 'swimmerA' }],
  });

  writeJson(path.join(storageRoot, 'tenants', 'clubs', 'tenant-b', 'db.json'), {
    swimmers: [{ id: 'swimmerB', name: 'Swimmer B' }],
    squads: [{ id: 'squadB', name: 'Squad B' }],
    trainingSessions: [{ id: 'sessionB', title: 'B Session' }],
    tests: [{ id: 'testB', name: 'B Test' }],
    attendance: [{ id: 'attendanceB', swimmerId: 'swimmerB' }],
  });

  return { storageRoot, backupRoot };
}

async function startServer(envOverrides = {}) {
  const tempRoot = mkTempDir('athlyrax-closed-pilot-');
  const { storageRoot, backupRoot } = createFixtureStorage(tempRoot);
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
    ATHLYRAX_STORAGE_ROOT: storageRoot,
    ATHLYRAX_SAFETY_BACKUP_ROOT: backupRoot,
    ATHLYRAX_SAFE_START_ENFORCED: 'true',
    ...envOverrides,
  };

  const child = spawn('node', ['index.js'], {
    cwd: RENDER_BACKEND_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => {
    stdout += String(buf || '');
  });
  child.stderr.on('data', (buf) => {
    stderr += String(buf || '');
  });

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
    env,
    tempRoot,
    stop: async () => {
      if (!child.killed) child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(() => resolve(), 2000);
      });
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function parseSetCookie(setCookieHeaders = []) {
  return setCookieHeaders
    .map((entry) => String(entry || '').split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `Login failed for ${username}: ${JSON.stringify(payload)}`);
  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const cookie = parseSetCookie(setCookie);
  assert.ok(cookie.includes('athlyrax_session='), 'Expected auth session cookie');
  return {
    cookie,
    csrfToken: String(payload?.csrfToken || ''),
    csrfHeaderName: String(payload?.csrfHeaderName || 'x-csrf-token').toLowerCase(),
  };
}

async function request(baseUrl, route, { method = 'GET', cookie = '', csrfHeaderName = 'x-csrf-token', csrfToken = '', headers = {}, body } = {}) {
  const finalHeaders = new Headers(headers);
  if (cookie) finalHeaders.set('Cookie', cookie);
  if (body !== undefined) finalHeaders.set('Content-Type', 'application/json');
  const upperMethod = String(method || 'GET').toUpperCase();
  if (upperMethod !== 'GET' && upperMethod !== 'HEAD' && upperMethod !== 'OPTIONS' && csrfToken) {
    finalHeaders.set(csrfHeaderName, csrfToken);
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method: upperMethod,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

test('cookie auth works without localStorage bearer token', async () => {
  const server = await startServer();
  try {
    const session = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const { response, payload } = await request(server.baseUrl, '/auth/me', { cookie: session.cookie });
    assert.equal(response.status, 200);
    assert.equal(String(payload?.user?.username || ''), 'coachA');
  } finally {
    await server.stop();
  }
});

test('missing or incorrect csrf token fails for state-changing requests', async () => {
  const server = await startServer();
  try {
    const session = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const missing = await request(server.baseUrl, '/auth/logout', {
      method: 'POST',
      cookie: session.cookie,
    });
    assert.equal(missing.response.status, 403);

    const wrong = await request(server.baseUrl, '/auth/logout', {
      method: 'POST',
      cookie: session.cookie,
      csrfToken: 'bad-token',
      csrfHeaderName: session.csrfHeaderName,
    });
    assert.equal(wrong.response.status, 403);
  } finally {
    await server.stop();
  }
});

test('logout invalidates the session', async () => {
  const server = await startServer();
  try {
    const session = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const out = await request(server.baseUrl, '/auth/logout', {
      method: 'POST',
      cookie: session.cookie,
      csrfToken: session.csrfToken,
      csrfHeaderName: session.csrfHeaderName,
    });
    assert.equal(out.response.status, 200);

    const after = await request(server.baseUrl, '/auth/me', { cookie: session.cookie });
    assert.equal(after.response.status, 401);
  } finally {
    await server.stop();
  }
});

test('changed password invalidates previous session', async () => {
  const server = await startServer();
  try {
    const coachSession = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const ownerSession = await login(server.baseUrl, 'softwareowner', 'Owner!Pass1234');

    const changed = await request(server.baseUrl, '/auth/users/coachA/password', {
      method: 'PUT',
      cookie: ownerSession.cookie,
      csrfHeaderName: ownerSession.csrfHeaderName,
      csrfToken: ownerSession.csrfToken,
      headers: {
        'x-athlyrax-tenant': 'tenant-a',
        'x-athlyrax-tenant-reason': 'security test revoke',
      },
      body: { password: 'CoachA!Changed1234' },
    });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));

    const stale = await request(server.baseUrl, '/auth/me', { cookie: coachSession.cookie });
    assert.equal(stale.response.status, 401);

    const fresh = await login(server.baseUrl, 'coachA', 'CoachA!Changed1234');
    const ok = await request(server.baseUrl, '/auth/me', { cookie: fresh.cookie });
    assert.equal(ok.response.status, 200);
  } finally {
    await server.stop();
  }
});

test('tenant isolation and role protections are enforced', async () => {
  const server = await startServer();
  try {
    const coachA = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const coachB = await login(server.baseUrl, 'coachB', 'CoachB!Pass1234');
    const viewerA = await login(server.baseUrl, 'viewerA', 'ViewerA!Pass1234');
    const assistantA = await login(server.baseUrl, 'assistantA', 'AssistantA!Pass1234');

    const aRead = await request(server.baseUrl, '/db', { cookie: coachA.cookie });
    assert.equal(aRead.response.status, 200);
    const aSwimmerIds = new Set((aRead.payload?.swimmers || []).map((row) => String(row?.id || '')));
    assert.ok(aSwimmerIds.has('swimmerA'));
    assert.ok(!aSwimmerIds.has('swimmerB'));

    const aCrossHeader = await request(server.baseUrl, '/db', {
      cookie: coachA.cookie,
      headers: { 'x-athlyrax-tenant': 'tenant-b' },
    });
    assert.equal(aCrossHeader.response.status, 403);

    const aCrossUpdate = await request(server.baseUrl, '/db', {
      method: 'PUT',
      cookie: coachA.cookie,
      csrfHeaderName: coachA.csrfHeaderName,
      csrfToken: coachA.csrfToken,
      headers: { 'x-athlyrax-tenant': 'tenant-b' },
      body: { swimmers: [{ id: 'hijack', name: 'Bad' }] },
    });
    assert.equal(aCrossUpdate.response.status, 403);

    const viewerWrite = await request(server.baseUrl, '/db', {
      method: 'PUT',
      cookie: viewerA.cookie,
      csrfHeaderName: viewerA.csrfHeaderName,
      csrfToken: viewerA.csrfToken,
      body: { swimmers: [{ id: 'viewer-write', name: 'No' }] },
    });
    assert.equal(viewerWrite.response.status, 403);

    const assistantAdmin = await request(server.baseUrl, '/auth/users', {
      method: 'GET',
      cookie: assistantA.cookie,
    });
    assert.equal(assistantAdmin.response.status, 403);

    const bRead = await request(server.baseUrl, '/db', { cookie: coachB.cookie });
    assert.equal(bRead.response.status, 200);
    const bSwimmerIds = new Set((bRead.payload?.swimmers || []).map((row) => String(row?.id || '')));
    assert.ok(bSwimmerIds.has('swimmerB'));
    assert.ok(!bSwimmerIds.has('swimmerA'));
  } finally {
    await server.stop();
  }
});

test('software-owner override requires reason and is rejected for non-owner roles', async () => {
  const server = await startServer();
  try {
    const owner = await login(server.baseUrl, 'softwareowner', 'Owner!Pass1234');
    const coachA = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');

    const missingReason = await request(server.baseUrl, '/db', {
      cookie: owner.cookie,
      headers: { 'x-athlyrax-tenant': 'tenant-a' },
    });
    assert.equal(missingReason.response.status, 400);

    const allowed = await request(server.baseUrl, '/db', {
      cookie: owner.cookie,
      headers: {
        'x-athlyrax-tenant': 'tenant-a',
        'x-athlyrax-tenant-reason': 'owner-support-check',
      },
    });
    assert.equal(allowed.response.status, 200);

    const coachDenied = await request(server.baseUrl, '/db', {
      cookie: coachA.cookie,
      headers: {
        'x-athlyrax-tenant': 'tenant-b',
        'x-athlyrax-tenant-reason': 'not-allowed',
      },
    });
    assert.equal(coachDenied.response.status, 403);
  } finally {
    await server.stop();
  }
});

test('invitation-only registration enforces single-use and tenant/role binding', async () => {
  const server = await startServer();
  try {
    const coachA = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const coachB = await login(server.baseUrl, 'coachB', 'CoachB!Pass1234');

    const inviteCreate = await request(server.baseUrl, '/auth/invites', {
      method: 'POST',
      cookie: coachA.cookie,
      csrfHeaderName: coachA.csrfHeaderName,
      csrfToken: coachA.csrfToken,
      body: {
        role: 'viewer',
        email: 'newcoach+tenantA@example.test',
      },
    });
    assert.equal(inviteCreate.response.status, 201, JSON.stringify(inviteCreate.payload));
    const inviteCode = String(inviteCreate.payload?.invite?.code || '').trim();
    assert.ok(inviteCode);

    const registerOk = await request(server.baseUrl, '/auth/register', {
      method: 'POST',
      body: {
        username: 'invited_user_a',
        password: 'InvitedUserA!Pass1234',
        inviteCode,
        fullName: 'Invited User A',
        email: 'newcoach+tenantA@example.test',
        swimClub: 'Malicious Override Club',
        teamName: 'Malicious Override Team',
        city: 'X',
        country: 'Y',
      },
    });
    assert.equal(registerOk.response.status, 201, JSON.stringify(registerOk.payload));

    const reused = await request(server.baseUrl, '/auth/register', {
      method: 'POST',
      body: {
        username: 'invited_user_reuse',
        password: 'InvitedReuse!Pass1234',
        inviteCode,
        fullName: 'Invited User Reuse',
        email: 'newcoach+tenantA@example.test',
        swimClub: 'Club A',
        teamName: 'Team A',
      },
    });
    assert.notEqual(reused.response.status, 201);

    const altered = await request(server.baseUrl, '/auth/register', {
      method: 'POST',
      body: {
        username: 'invited_user_altered',
        password: 'InvitedAltered!Pass1234',
        inviteCode: `${inviteCode.slice(0, -1)}X`,
        fullName: 'Invited User Altered',
        email: 'newcoach+tenantA@example.test',
        swimClub: 'Club A',
        teamName: 'Team A',
      },
    });
    assert.notEqual(altered.response.status, 201);

    const crossTenantEmail = await request(server.baseUrl, '/auth/register', {
      method: 'POST',
      body: {
        username: 'invited_user_wrong_email',
        password: 'WrongEmail!Pass1234',
        inviteCode,
        fullName: 'Wrong Email User',
        email: 'newcoach+tenantB@example.test',
        swimClub: 'Club B',
        teamName: 'Team B',
      },
    });
    assert.notEqual(crossTenantEmail.response.status, 201);

    const expiredInviteAttempt = await request(server.baseUrl, '/auth/register', {
      method: 'POST',
      body: {
        username: 'invited_user_expired',
        password: 'ExpiredInvite!Pass1234',
        inviteCode: 'EXPR-TEST-0001',
        fullName: 'Expired Invite User',
        email: 'expired+invite@example.test',
        swimClub: 'Club A',
        teamName: 'Team A',
      },
    });
    assert.notEqual(expiredInviteAttempt.response.status, 201);

    const usersA = await request(server.baseUrl, '/auth/users', {
      method: 'GET',
      cookie: coachA.cookie,
    });
    assert.equal(usersA.response.status, 200);
    const createdUser = (usersA.payload?.users || []).find((row) => String(row?.username || '') === 'invited_user_a');
    assert.ok(createdUser);
    assert.equal(String(createdUser?.role || ''), 'viewer');
    assert.equal(String(createdUser?.tenantId || ''), 'tenant-a');

    const usersB = await request(server.baseUrl, '/auth/users', {
      method: 'GET',
      cookie: coachB.cookie,
    });
    assert.equal(usersB.response.status, 200);
    const leaked = (usersB.payload?.users || []).find((row) => String(row?.username || '') === 'invited_user_a');
    assert.equal(leaked, undefined);
  } finally {
    await server.stop();
  }
});

test('production rejects bearer compatibility mode', async () => {
  const tempRoot = mkTempDir('athlyrax-prod-bearer-reject-');
  const { storageRoot, backupRoot } = createFixtureStorage(tempRoot);
  const child = spawn('node', ['index.js'], {
    cwd: RENDER_BACKEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: '3499',
      AUTH_REQUIRED: 'true',
      AUTH_SECRET: 'this-is-a-very-strong-production-test-secret-1234',
      AUTH_ALLOW_COACH_SIGNUP: 'false',
      AUTH_ALLOW_COACH_INVITES: 'true',
      AUTH_PASSWORD_RESET_DELIVERY: 'smtp',
      AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE: 'false',
      AUTH_SMTP_HOST: 'smtp.example.test',
      AUTH_SMTP_FROM: 'noreply@example.test',
      FRONTEND_PUBLIC_ORIGIN: 'https://athlyrax.com',
      ALLOWED_ORIGINS: 'https://athlyrax.com',
      ATHLYRAX_STORAGE_ROOT: storageRoot,
      ATHLYRAX_SAFETY_BACKUP_ROOT: backupRoot,
      ATHLYRAX_SAFE_START_ENFORCED: 'true',
      AUTH_ALLOW_BEARER_COMPAT: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (buf) => {
    stderr += String(buf || '');
  });

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(Number(code || 0)));
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });
  assert.notEqual(exitCode, 0);
  assert.ok(stderr.includes('AUTH_ALLOW_BEARER_COMPAT must be false in production'));
});
