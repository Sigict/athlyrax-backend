import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BACKEND_DIR = path.resolve(process.cwd());
const BULK_COUNT = 3443;
const SET_COUNT = 71;
const DELETED_AT = '2026-08-18T15:30:00.000Z';

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makePlanningDb() {
  const schedule = Array.from({ length: BULK_COUNT }, (_, index) => ({
    id: `sch-${index + 1}`,
    scheduleDate: '2026-09-01',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }));
  const trainingSessions = schedule.map((row, index) => ({
    id: `session-${index + 1}`,
    scheduleId: row.id,
    updatedAt: '2026-08-01T00:00:00.000Z',
  }));
  const trainingSessionSets = Array.from({ length: SET_COUNT }, (_, index) => ({
    id: `set-${index + 1}`,
    sessionId: `session-${index + 1}`,
    updatedAt: '2026-08-01T00:00:00.000Z',
  }));
  return {
    __meta: { updatedAt: '2026-08-01T00:00:00.000Z' },
    schedule,
    trainingSessions,
    trainingSessionSets,
    trainingSetBlocks: [],
    attendance: [],
    __tombstones: [],
  };
}

function createFixtureStorage(rootDir) {
  const storageRoot = path.join(rootDir, 'storage');
  const backupRoot = path.join(rootDir, 'backup');
  const authUsersPath = path.join(storageRoot, 'auth', 'auth-users.json');
  const authUsersBackupPath = path.join(storageRoot, 'auth', 'auth-users.backup.json');
  const now = new Date().toISOString();
  const users = [
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
      onboardingCompletedAt: now,
    },
  ];

  writeJson(authUsersPath, users);
  writeJson(authUsersBackupPath, users);
  writeJson(path.join(storageRoot, 'auth-invites.json'), []);
  writeJson(path.join(storageRoot, 'db.json'), {});
  writeJson(path.join(storageRoot, 'tenants', 'tenant-a', 'db.json'), makePlanningDb());

  return { storageRoot, backupRoot, authUsersPath, authUsersBackupPath };
}

async function startServer() {
  const tempRoot = mkTempDir('athlyrax-bulk-delete-roundtrip-');
  const paths = createFixtureStorage(tempRoot);
  const port = String(3800 + Math.floor(Math.random() * 300));
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

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'coachA', password: 'CoachA!Pass1234' }),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `Login failed: ${JSON.stringify(payload)}`);
  return {
    cookie: cookieHeader(response),
    csrfToken: String(payload?.csrfToken || ''),
    csrfHeaderName: String(payload?.csrfHeaderName || 'x-csrf-token').toLowerCase(),
  };
}

async function request(baseUrl, route, { method = 'GET', cookie = '', csrfToken = '', csrfHeaderName = 'x-csrf-token', body } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && csrfToken) headers.set(csrfHeaderName, csrfToken);
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function deletionTombstones() {
  return [
    ...Array.from({ length: BULK_COUNT }, (_, index) => ({
      collection: 'schedule', id: `sch-${index + 1}`, deletedAt: DELETED_AT, deletedBy: 'coacha',
    })),
    ...Array.from({ length: BULK_COUNT }, (_, index) => ({
      collection: 'trainingSessions', id: `session-${index + 1}`, deletedAt: DELETED_AT, deletedBy: 'coacha',
    })),
    ...Array.from({ length: SET_COUNT }, (_, index) => ({
      collection: 'trainingSessionSets', id: `set-${index + 1}`, deletedAt: DELETED_AT, deletedBy: 'coacha',
    })),
  ];
}

test('3443 Scheduled Sessions delete persists after fresh GET and blocks a stale full-db resurrection', async () => {
  const server = await startServer();
  try {
    const session = await login(server.baseUrl);
    const before = await request(server.baseUrl, '/db', { cookie: session.cookie });
    assert.equal(before.response.status, 200);
    assert.equal(before.payload.schedule.length, BULK_COUNT);
    assert.equal(before.payload.trainingSessions.length, BULK_COUNT);
    assert.equal(before.payload.trainingSessionSets.length, SET_COUNT);

    const tombstones = deletionTombstones();
    assert.equal(tombstones.length, (BULK_COUNT * 2) + SET_COUNT);
    assert.ok(tombstones.length > 5000, 'Regression must exceed the old production tombstone cap.');
    assert.ok(tombstones.length < 20000, 'Regression must fit within the new production tombstone cap.');

    const deletePayload = {
      ...before.payload,
      schedule: [],
      trainingSessions: [],
      trainingSessionSets: [],
      trainingSetBlocks: [],
      __tombstones: tombstones,
      __meta: {
        ...(before.payload.__meta || {}),
        updatedAt: DELETED_AT,
      },
    };
    const deleted = await request(server.baseUrl, '/db', {
      method: 'PUT',
      cookie: session.cookie,
      csrfToken: session.csrfToken,
      csrfHeaderName: session.csrfHeaderName,
      body: deletePayload,
    });
    assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
    assert.ok(Number(deleted.payload?.tombstoneCount || 0) >= tombstones.length, 'Backend must retain every deletion tombstone from the 3443-row operation.');

    const afterDelete = await request(server.baseUrl, '/db', { cookie: session.cookie });
    assert.equal(afterDelete.response.status, 200);
    assert.equal(afterDelete.payload.schedule.length, 0, 'Fresh GET must prove all selected Schedule rows are gone.');
    assert.equal(afterDelete.payload.trainingSessions.length, 0, 'Fresh GET must prove all linked Training Sessions are gone.');
    assert.equal(afterDelete.payload.trainingSessionSets.length, 0, 'Fresh GET must prove all linked sets are gone.');
    assert.ok((afterDelete.payload.__tombstones || []).length >= tombstones.length);

    const stalePayload = {
      ...before.payload,
      __tombstones: [],
      __meta: {
        ...(before.payload.__meta || {}),
        ...(afterDelete.payload.__meta?.storageRevision !== undefined
          ? { storageRevision: afterDelete.payload.__meta.storageRevision }
          : {}),
        updatedAt: '2026-08-18T15:31:00.000Z',
      },
    };
    const staleWrite = await request(server.baseUrl, '/db', {
      method: 'PUT',
      cookie: session.cookie,
      csrfToken: session.csrfToken,
      csrfHeaderName: session.csrfHeaderName,
      body: stalePayload,
    });
    assert.equal(staleWrite.response.status, 200, JSON.stringify(staleWrite.payload));
    assert.ok((staleWrite.payload?.blockedResurrections || []).length >= BULK_COUNT * 2, 'Backend must explicitly report blocked Schedule/Training Session resurrection attempts.');

    const afterStaleWrite = await request(server.baseUrl, '/db', { cookie: session.cookie });
    assert.equal(afterStaleWrite.response.status, 200);
    assert.equal(afterStaleWrite.payload.schedule.length, 0, 'Stale client must not resurrect deleted Schedule rows.');
    assert.equal(afterStaleWrite.payload.trainingSessions.length, 0, 'Stale client must not resurrect linked Training Sessions.');
    assert.equal(afterStaleWrite.payload.trainingSessionSets.length, 0, 'Stale client must not resurrect linked set rows.');
  } finally {
    await server.stop();
  }
});
