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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createFixtureStorage(rootDir) {
  const storageRoot = path.join(rootDir, 'storage');
  const backupRoot = path.join(rootDir, 'backup');
  const authUsersPath = path.join(storageRoot, 'auth', 'auth-users.json');
  const authUsersBackupPath = path.join(storageRoot, 'auth', 'auth-users.backup.json');
  const tenantDbPath = path.join(storageRoot, 'tenants', 'tenant-a', 'db.json');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });

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
  writeJson(path.join(storageRoot, 'db.json'), { swimmers: [] });

  const occurrence = {
    generatedByPlanner: true,
    scheduleDate: '2026-08-23',
    timetableId: 'tt-main',
    startTime: '17:00',
    endTime: '19:00',
    venueId: 'pool-a',
    squadIds: ['perf-a'],
    sessionTypeId: 'aerobic',
  };
  writeJson(tenantDbPath, {
    swimmers: [],
    squads: [{ id: 'perf-a', name: 'Performance A' }],
    timetable: [{ id: 'tt-main', name: 'Main timetable' }],
    schedule: [
      { ...occurrence, id: 'schedule-a', generatedSourceSlotId: 'slot-old' },
      { ...occurrence, id: 'schedule-b', generatedSourceSlotId: 'slot-new' },
      { ...occurrence, id: 'manual-same-time', manualScheduleEntry: true, generatedByPlanner: false },
      { ...occurrence, id: 'schedule-next-week', scheduleDate: '2026-08-30', generatedSourceSlotId: 'slot-next' },
    ],
    trainingSchedules: [],
    trainingSessions: [
      { id: 'rendered-session-a', scheduleId: 'schedule-a', startTime: '17:00', endTime: '19:00', venueId: 'pool-a', squadIds: ['perf-a'] },
      { id: 'rendered-session-b', scheduleId: 'schedule-b', startTime: '17:00', endTime: '19:00', venueId: 'pool-a', squadIds: ['perf-a'] },
      { id: 'manual-session', scheduleId: 'manual-same-time', startTime: '17:00', endTime: '19:00', venueId: 'pool-a', squadIds: ['perf-a'] },
      { id: 'next-session', scheduleId: 'schedule-next-week', startTime: '17:00', endTime: '19:00', venueId: 'pool-a', squadIds: ['perf-a'] },
    ],
    trainingSessionSets: [
      { id: 'set-a', trainingSessionId: 'rendered-session-a' },
      { id: 'set-b', trainingSessionId: 'rendered-session-b' },
      { id: 'set-manual', trainingSessionId: 'manual-session' },
      { id: 'set-next', trainingSessionId: 'next-session' },
    ],
    trainingSetBlocks: [
      { id: 'block-a', trainingSessionId: 'rendered-session-a', setId: 'set-a', setIds: ['set-a'] },
      { id: 'block-b', trainingSessionId: 'rendered-session-b', setId: 'set-b', setIds: ['set-b'] },
      { id: 'block-manual', trainingSessionId: 'manual-session', setId: 'set-manual', setIds: ['set-manual'] },
      { id: 'block-next', trainingSessionId: 'next-session', setId: 'set-next', setIds: ['set-next'] },
    ],
    attendance: [
      { id: 'attendance-a', scheduleId: 'schedule-a' },
      { id: 'attendance-b', scheduleId: 'schedule-b' },
      { id: 'attendance-manual', scheduleId: 'manual-same-time' },
      { id: 'attendance-next', scheduleId: 'schedule-next-week' },
    ],
    __tombstones: [],
    __meta: { storageRevision: 1, scheduleOccurrenceSuppressions: [] },
  });

  return {
    storageRoot,
    backupRoot,
    authUsersPath,
    authUsersBackupPath,
    tenantDbPath,
  };
}

async function startServer() {
  const tempRoot = mkTempDir('athlyrax-schedule-delete-route-');
  const paths = createFixtureStorage(tempRoot);
  const port = String(3700 + Math.floor(Math.random() * 300));
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

  const child = spawn('node', ['index.js'], {
    cwd: BACKEND_DIR,
    env,
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
    child,
    paths,
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
  const rows = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [String(response.headers.get('set-cookie') || '')];
  return rows
    .map((row) => String(row || '').split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
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

async function request(baseUrl, route, {
  method = 'GET',
  cookie = '',
  csrfToken = '',
  csrfHeaderName = 'x-csrf-token',
  body,
} = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && csrfToken) {
    headers.set(csrfHeaderName, csrfToken);
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

test('real tenant route deletes the whole duplicate occurrence cluster and fresh GET cannot bring it back', async () => {
  const server = await startServer();
  try {
    const session = await login(server.baseUrl);
    const deletion = await request(server.baseUrl, '/db/schedule-delete', {
      method: 'POST',
      cookie: session.cookie,
      csrfToken: session.csrfToken,
      csrfHeaderName: session.csrfHeaderName,
      body: { scheduleIds: ['rendered-session-a'] },
    });

    assert.equal(deletion.response.status, 200, JSON.stringify(deletion.payload));
    assert.equal(deletion.payload?.verified, true);
    assert.deepEqual(new Set(deletion.payload?.deletedScheduleIds || []), new Set(['schedule-a', 'schedule-b']));
    assert.equal(Number(deletion.payload?.serverDerivedScheduleOccurrenceSuppressionCount || 0) >= 1, true);

    const fresh = await request(server.baseUrl, '/db', { cookie: session.cookie });
    assert.equal(fresh.response.status, 200, JSON.stringify(fresh.payload));
    const freshScheduleIds = new Set((fresh.payload?.schedule || []).map((row) => String(row?.id || '')));
    assert.equal(freshScheduleIds.has('schedule-a'), false);
    assert.equal(freshScheduleIds.has('schedule-b'), false);
    assert.equal(freshScheduleIds.has('manual-same-time'), true, 'manual replacement must survive generated occurrence deletion');
    assert.equal(freshScheduleIds.has('schedule-next-week'), true, 'next recurrence must survive current occurrence deletion');

    const freshSessionIds = new Set((fresh.payload?.trainingSessions || []).map((row) => String(row?.id || '')));
    assert.equal(freshSessionIds.has('rendered-session-a'), false);
    assert.equal(freshSessionIds.has('rendered-session-b'), false);
    assert.equal(freshSessionIds.has('manual-session'), true);
    assert.equal(freshSessionIds.has('next-session'), true);

    const persisted = readJson(server.paths.tenantDbPath);
    const persistedScheduleIds = new Set((persisted?.schedule || []).map((row) => String(row?.id || '')));
    assert.equal(persistedScheduleIds.has('schedule-a'), false);
    assert.equal(persistedScheduleIds.has('schedule-b'), false);
    assert.equal(persistedScheduleIds.has('manual-same-time'), true);
    assert.equal(persistedScheduleIds.has('schedule-next-week'), true);
    assert.equal((persisted?.__meta?.scheduleOccurrenceSuppressions || []).length >= 1, true);
  } finally {
    await server.stop();
  }
});
