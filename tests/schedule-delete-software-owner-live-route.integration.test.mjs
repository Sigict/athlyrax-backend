import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BACKEND_DIR = path.resolve(process.cwd());

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function startSoftwareOwnerSparseLegacyServer() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-sparse-delete-route-'));
  const storageRoot = path.join(tempRoot, 'storage');
  const backupRoot = path.join(tempRoot, 'backup');
  const authUsersPath = path.join(storageRoot, 'auth', 'auth-users.json');
  const authUsersBackupPath = path.join(storageRoot, 'auth', 'auth-users.backup.json');
  const ownerDbPath = path.join(storageRoot, 'db.json');
  const now = new Date().toISOString();

  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });
  const users = [{
    username: 'softwareowner',
    password: 'SoftwareOwner!Pass1234',
    role: 'software-owner',
    tenantId: 'global-owner',
    createdVia: 'admin',
    isApproved: true,
    onboardingCompletedAt: now,
  }];
  writeJson(authUsersPath, users);
  writeJson(authUsersBackupPath, users);
  writeJson(path.join(storageRoot, 'auth-invites.json'), []);
  // Intentionally old/sparse: no timetable id, source slot, times, venue, squad,
  // or session type. This is the real class that the old 409 refusal made undeletable.
  writeJson(ownerDbPath, {
    swimmers: [],
    schedule: [{ id: 'sparse-old-schedule', generatedByPlanner: true, scheduleDate: '2026-08-23' }],
    trainingSchedules: [],
    trainingSessions: [{ id: 'sparse-rendered-session', scheduleId: 'sparse-old-schedule' }],
    trainingSessionSets: [{ id: 'sparse-set', trainingSessionId: 'sparse-rendered-session' }],
    trainingSetBlocks: [{ id: 'sparse-block', trainingSessionId: 'sparse-rendered-session', setId: 'sparse-set', setIds: ['sparse-set'] }],
    attendance: [{ id: 'sparse-attendance', scheduleId: 'sparse-old-schedule' }],
    __tombstones: [],
    __meta: { storageRevision: 1, scheduleOccurrenceSuppressions: [] },
  });

  const port = String(4100 + Math.floor(Math.random() * 300));
  const child = spawn('node', ['index.js'], {
    cwd: BACKEND_DIR,
    env: {
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
      AUTH_USERS_PATH: authUsersPath,
      AUTH_USERS_BACKUP_PATH: authUsersBackupPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buffer) => { stdout += String(buffer || ''); });
  child.stderr.on('data', (buffer) => { stderr += String(buffer || ''); });

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
    ownerDbPath,
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
  const rows = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [String(response.headers.get('set-cookie') || '')];
  return rows.map((row) => String(row || '').split(';')[0].trim()).filter(Boolean).join('; ');
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'softwareowner', password: 'SoftwareOwner!Pass1234' }),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `Login failed: ${JSON.stringify(payload)}`);
  return {
    cookie: cookieHeader(response),
    csrfToken: String(payload?.csrfToken || ''),
    csrfHeaderName: String(payload?.csrfHeaderName || 'x-csrf-token').toLowerCase(),
  };
}

async function request(baseUrl, route, session, method = 'GET', body) {
  const headers = new Headers();
  headers.set('Cookie', session.cookie);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set(session.csrfHeaderName, session.csrfToken);
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function scheduleIds(db) {
  return new Set((db?.schedule || []).map((row) => String(row?.id || '')));
}

test('sparse legacy Schedule deletes through the real software-owner global storage route and a stale whole-db PUT cannot resurrect it', async () => {
  const server = await startSoftwareOwnerSparseLegacyServer();
  try {
    const session = await login(server.baseUrl);

    const deletion = await request(
      server.baseUrl,
      '/db/schedule-delete',
      session,
      'POST',
      { scheduleIds: ['sparse-rendered-session'] },
    );
    assert.equal(deletion.response.status, 200, JSON.stringify(deletion.payload));
    assert.equal(deletion.payload?.verified, true);
    assert.deepEqual(deletion.payload?.deletedScheduleIds, ['sparse-old-schedule']);
    assert.deepEqual(deletion.payload?.physicalOnlyScheduleIds, ['sparse-old-schedule']);
    assert.equal(Number(deletion.payload?.serverDerivedScheduleOccurrenceSuppressionCount || 0), 0);

    const afterDelete = await request(server.baseUrl, '/db', session);
    assert.equal(afterDelete.response.status, 200, JSON.stringify(afterDelete.payload));
    assert.equal(scheduleIds(afterDelete.payload).has('sparse-old-schedule'), false);
    assert.equal((afterDelete.payload?.trainingSessions || []).some((row) => row?.id === 'sparse-rendered-session'), false);

    // Simulate a stale browser carrying the deleted physical row but no tombstone.
    // Use the fresh storage revision so this tests permanent server-side deletion
    // protection rather than merely winning on an old-revision conflict.
    const staleResurrectionPayload = {
      ...afterDelete.payload,
      schedule: [
        ...(afterDelete.payload?.schedule || []),
        { id: 'sparse-old-schedule', generatedByPlanner: true, scheduleDate: '2026-08-23', updatedAt: '2099-01-01T00:00:00.000Z' },
      ],
      trainingSessions: [
        ...(afterDelete.payload?.trainingSessions || []),
        { id: 'sparse-rendered-session', scheduleId: 'sparse-old-schedule', updatedAt: '2099-01-01T00:00:00.000Z' },
      ],
      __tombstones: [],
    };
    const stalePut = await request(server.baseUrl, '/db', session, 'PUT', staleResurrectionPayload);
    assert.ok([200, 409].includes(stalePut.response.status), JSON.stringify(stalePut.payload));

    const finalGet = await request(server.baseUrl, '/db', session);
    assert.equal(finalGet.response.status, 200, JSON.stringify(finalGet.payload));
    assert.equal(scheduleIds(finalGet.payload).has('sparse-old-schedule'), false, 'fresh GET resurrected sparse Schedule');
    assert.equal((finalGet.payload?.trainingSessions || []).some((row) => row?.id === 'sparse-rendered-session'), false, 'fresh GET resurrected linked Training Session');

    const persisted = readJson(server.ownerDbPath);
    assert.equal(scheduleIds(persisted).has('sparse-old-schedule'), false, 'global-owner db.json resurrected sparse Schedule');
    assert.equal((persisted?.trainingSessions || []).some((row) => row?.id === 'sparse-rendered-session'), false, 'global-owner db.json resurrected linked Training Session');
    assert.equal((persisted?.__tombstones || []).some((row) => row?.collection === 'schedule' && row?.id === 'sparse-old-schedule'), true, 'permanent Schedule tombstone missing from disk');
  } finally {
    await server.stop();
  }
});
