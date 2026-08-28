import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function cookieHeader(response) {
  const rows = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [String(response.headers.get('set-cookie') || '')];
  return rows.map((row) => String(row || '').split(';')[0].trim()).filter(Boolean).join('; ');
}

async function startAthleteServer({ multiTenant = false } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-athlete-home-route-'));
  const storageRoot = path.join(tempRoot, 'storage');
  const backupRoot = path.join(tempRoot, 'backup');
  const authUsersPath = path.join(storageRoot, 'auth', 'auth-users.json');
  const authUsersBackupPath = path.join(storageRoot, 'auth', 'auth-users.backup.json');
  const tenantDbPath = path.join(storageRoot, 'tenants', 'tenant-a', 'db.json');
  const now = new Date().toISOString();

  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });
  const swimmerUser = {
    username: 'swimmer1',
    password: 'Swimmer!Pass1234',
    role: 'swimmer',
    tenantId: 'tenant-a',
    clubId: 'club-a',
    createdVia: 'admin',
    isApproved: true,
    onboardingCompletedAt: now,
    email: 'swimmer1@example.test',
    ...(multiTenant ? {
      athleteTenantConnections: [
        { tenantId: 'tenant-a', connectionId: 'tenant-a-link', clubId: 'club-a', clubName: 'Club A', squadId: 'squad-a', status: 'active' },
        { tenantId: 'tenant-b', connectionId: 'tenant-b-link', clubId: 'club-b', clubName: 'Club B', squadId: 'squad-b', status: 'active' },
        { tenantId: 'tenant-disconnected', connectionId: 'tenant-old-link', clubId: 'club-old', clubName: 'Old Club', status: 'disconnected' },
      ],
    } : {}),
  };
  const users = [
    swimmerUser,
    {
      username: 'coachA',
      password: 'CoachA!Pass1234',
      role: 'head-coach',
      tenantId: 'tenant-a',
      clubId: 'club-a',
      createdVia: 'admin',
      isApproved: true,
      onboardingCompletedAt: now,
      email: 'coach@example.test',
    },
  ];
  writeJson(authUsersPath, users);
  writeJson(authUsersBackupPath, users);
  writeJson(path.join(storageRoot, 'auth-invites.json'), []);
  writeJson(path.join(storageRoot, 'db.json'), { swimmers: [] });
  writeJson(tenantDbPath, {
    swimmers: [
      {
        id: 'athlete-1',
        name: 'Athlete One',
        swimmerAccountUsername: 'swimmer1',
        swimmerAccountEmail: 'swimmer1@example.test',
        currentSquadId: 'squad-a',
        asaN: '123456',
      },
      {
        id: 'athlete-2',
        name: 'Other Athlete',
        swimmerAccountUsername: 'other',
        currentSquadId: 'squad-b',
      },
    ],
    swimmerClubConnections: [
      { connectionId: 'link-a', swimmerId: 'athlete-1', clubId: 'club-a', clubName: 'Club A', squadId: 'squad-a', sessionPolicies: { swimming: 'coach_only' } },
      { connectionId: 'link-b', swimmerId: 'athlete-2', clubId: 'club-b', clubName: 'Club B', squadId: 'squad-b' },
    ],
    trainingSessions: [
      { id: 'session-a', scheduleId: 'schedule-a', squadId: 'squad-a', clubId: 'club-a', title: 'Coach session A', coachName: 'Coach A', totalVolume: 3200 },
      { id: 'session-b', scheduleId: 'schedule-b', squadId: 'squad-b', clubId: 'club-b', title: 'Other athlete session' },
    ],
    trainingSessionSets: [
      { id: 'set-a1', trainingSessionId: 'session-a', order: 1, reps: 8, distance: 100, stroke: 'Free', sendoff: '1:30' },
      { id: 'set-a-private', trainingSessionId: 'session-a', order: 2, reps: 4, distance: 50, coachPrivate: true },
      { id: 'set-b1', trainingSessionId: 'session-b', reps: 10, distance: 50 },
    ],
    billing: [{ secret: 'must-not-leak' }],
  });

  if (multiTenant) {
    writeJson(path.join(storageRoot, 'tenants', 'tenant-b', 'db.json'), {
      swimmers: [
        {
          id: 'athlete-1',
          name: 'Athlete One',
          swimmerAccountUsername: 'swimmer1',
          swimmerAccountEmail: 'swimmer1@example.test',
          currentSquadId: 'squad-b',
          asaN: '123456',
          clubConnections: [
            {
              connectionId: 'tenant-b-link',
              tenantId: 'tenant-b',
              clubId: 'club-b',
              clubName: 'Club B',
              squadId: 'squad-b',
              status: 'active',
              sessionPolicies: { swimming: 'approval_required', strength: 'athlete_extra' },
            },
          ],
        },
        { id: 'athlete-secret', swimmerAccountUsername: 'secret', currentSquadId: 'squad-b' },
      ],
      trainingSessions: [
        { id: 'session-club-b', scheduleId: 'schedule-club-b', squadId: 'squad-b', clubId: 'club-b', title: 'Club B session', totalVolume: 1800 },
        { id: 'session-secret', swimmerId: 'athlete-secret', squadId: 'squad-b', clubId: 'club-b', title: 'Other Club B athlete' },
        { id: 'session-wrong-club', squadId: 'squad-b', clubId: 'club-secret', title: 'Wrong club collision' },
      ],
      trainingSessionSets: [
        { id: 'set-club-b', trainingSessionId: 'session-club-b', reps: 12, distance: 50, stroke: 'Free' },
        { id: 'set-club-b-private', trainingSessionId: 'session-club-b', coachPrivate: true, reps: 2, distance: 25 },
        { id: 'set-secret', trainingSessionId: 'session-secret', reps: 4, distance: 100 },
        { id: 'set-wrong-club', trainingSessionId: 'session-wrong-club', reps: 1, distance: 25 },
      ],
      privateCoachNotes: [{ swimmerId: 'athlete-1', note: 'must-never-leak' }],
    });
  }

  const port = String(4500 + Math.floor(Math.random() * 300));
  const child = spawn('node', ['index.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: port,
      AUTH_REQUIRED: 'true',
      AUTH_SECRET: 'this-is-a-very-strong-athlete-test-secret-1234',
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
    storageRoot,
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

async function login(baseUrl, username = 'swimmer1', password = 'Swimmer!Pass1234') {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `Login failed: ${JSON.stringify(payload)}`);
  return {
    cookie: cookieHeader(response),
    csrfToken: String(payload?.csrfToken || ''),
    csrfHeaderName: String(payload?.csrfHeaderName || 'x-csrf-token').toLowerCase(),
  };
}

async function requestJson(baseUrl, route, session, method = 'GET', body) {
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

async function athleteHome(baseUrl, session) {
  return requestJson(baseUrl, '/swimmer/athlete-home', session);
}

test('real authenticated athlete-home route returns exact athlete session/sets and no other tenant data', async () => {
  const server = await startAthleteServer();
  try {
    const session = await login(server.baseUrl);
    const result = await athleteHome(server.baseUrl, session);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload?.athlete?.id, 'athlete-1');
    assert.equal(result.payload?.athlete?.asn, '123456');
    assert.deepEqual(result.payload?.sessions?.map((row) => row.id), ['session-a']);
    assert.deepEqual(result.payload?.sessions?.[0]?.sets?.map((row) => row.id), ['set-a1']);
    assert.equal(result.payload?.sessions?.[0]?.sets?.[0]?.reps, 8);
    assert.equal(result.payload?.sessions?.[0]?.sets?.[0]?.distance, 100);
    const serialized = JSON.stringify(result.payload);
    assert.equal(serialized.includes('athlete-2'), false);
    assert.equal(serialized.includes('session-b'), false);
    assert.equal(serialized.includes('set-a-private'), false);
    assert.equal(serialized.includes('must-not-leak'), false);
  } finally {
    await server.stop();
  }
});

test('two independent sign-ins resolve to the same canonical athlete identity and history', async () => {
  const server = await startAthleteServer();
  try {
    const deviceOneSession = await login(server.baseUrl);
    const deviceTwoSession = await login(server.baseUrl);
    const [deviceOne, deviceTwo] = await Promise.all([
      athleteHome(server.baseUrl, deviceOneSession),
      athleteHome(server.baseUrl, deviceTwoSession),
    ]);
    assert.equal(deviceOne.response.status, 200, JSON.stringify(deviceOne.payload));
    assert.equal(deviceTwo.response.status, 200, JSON.stringify(deviceTwo.payload));
    assert.equal(deviceOne.payload?.athlete?.id, 'athlete-1');
    assert.equal(deviceTwo.payload?.athlete?.id, 'athlete-1');
    assert.deepEqual(deviceOne.payload?.sessions, deviceTwo.payload?.sessions);
    assert.deepEqual(deviceOne.payload?.clubConnections, deviceTwo.payload?.clubConnections);
  } finally {
    await server.stop();
  }
});

test('explicit active tenant registry aggregates two clubs but excludes disconnected and private data', async () => {
  const server = await startAthleteServer({ multiTenant: true });
  try {
    const session = await login(server.baseUrl);
    const result = await athleteHome(server.baseUrl, session);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload?.athlete?.id, 'athlete-1');
    assert.deepEqual(result.payload?.sessions?.map((row) => row.id).sort(), ['session-a', 'session-club-b']);
    assert.ok(result.payload?.clubConnections?.some((row) => row.clubId === 'club-a'));
    assert.ok(result.payload?.clubConnections?.some((row) => row.clubId === 'club-b'));
    const clubB = result.payload.sessions.find((row) => row.id === 'session-club-b');
    assert.deepEqual(clubB.sets.map((row) => row.id), ['set-club-b']);
    const serialized = JSON.stringify(result.payload);
    assert.equal(serialized.includes('tenant-old-link'), false);
    assert.equal(serialized.includes('Old Club'), false);
    assert.equal(serialized.includes('session-secret'), false);
    assert.equal(serialized.includes('session-wrong-club'), false);
    assert.equal(serialized.includes('set-club-b-private'), false);
    assert.equal(serialized.includes('must-never-leak'), false);
  } finally {
    await server.stop();
  }
});

test('athlete session write enforces CSRF and coach-only policy', async () => {
  const server = await startAthleteServer({ multiTenant: true });
  try {
    const session = await login(server.baseUrl);
    const withoutCsrf = await fetch(`${server.baseUrl}/swimmer/athlete-sessions`, {
      method: 'POST',
      headers: { Cookie: session.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clubId: 'club-b', date: '2026-08-29', title: 'No CSRF' }),
    });
    assert.equal(withoutCsrf.status, 403);

    const denied = await requestJson(server.baseUrl, '/swimmer/athlete-sessions', session, 'POST', {
      clubId: 'club-a',
      disciplineId: 'swimming',
      date: '2026-08-29',
      title: 'Club A athlete proposal',
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.match(String(denied.payload?.error || ''), /club controls/i);
  } finally {
    await server.stop();
  }
});

test('approval-required athlete proposal persists once in the authorised club tenant and returns through athlete-home', async () => {
  const server = await startAthleteServer({ multiTenant: true });
  try {
    const session = await login(server.baseUrl);
    const created = await requestJson(server.baseUrl, '/swimmer/athlete-sessions', session, 'POST', {
      clubId: 'club-b',
      disciplineId: 'swimming',
      date: '2026-08-29',
      title: 'Athlete extra aerobic swim',
      volume: 1200,
      sets: [
        { title: 'Main', rounds: 2, reps: 6, distance: 100, stroke: 'Free', sendoff: '1:45' },
      ],
      approvalStatus: 'approved',
      ownerClubId: 'club-a',
      swimmerId: 'athlete-secret',
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    assert.equal(created.payload?.approvalRequired, true);
    assert.equal(created.payload?.policy, 'approval_required');
    assert.equal(created.payload?.session?.approvalStatus, 'pending');
    assert.equal(created.payload?.session?.ownerClubId, 'club-b');
    assert.equal(created.payload?.session?.ownerTenantId, 'tenant-b');
    assert.equal(created.payload?.session?.swimmerId, 'athlete-1');
    assert.ok(String(created.payload?.session?.id || '').startsWith('athlete-session:'));
    assert.equal(created.payload?.session?.sets?.length, 1);
    assert.equal(created.payload.session.sets[0].trainingSessionId, created.payload.session.id);

    const home = await athleteHome(server.baseUrl, session);
    assert.equal(home.response.status, 200, JSON.stringify(home.payload));
    const projected = home.payload?.sessions?.find((row) => row.id === created.payload.session.id);
    assert.ok(projected, 'Persisted athlete proposal did not return through athlete-home.');
    assert.equal(projected.approvalStatus, 'pending');
    assert.deepEqual(projected.sets.map((row) => row.id), created.payload.session.sets.map((row) => row.id));

    const targetDb = JSON.parse(fs.readFileSync(path.join(server.storageRoot, 'tenants', 'tenant-b', 'db.json'), 'utf8'));
    const primaryDb = JSON.parse(fs.readFileSync(path.join(server.storageRoot, 'tenants', 'tenant-a', 'db.json'), 'utf8'));
    assert.equal(targetDb.trainingSessions.filter((row) => row.id === created.payload.session.id).length, 1);
    assert.equal(targetDb.trainingSessionSets.filter((row) => row.trainingSessionId === created.payload.session.id).length, 1);
    assert.equal(primaryDb.trainingSessions.some((row) => row.id === created.payload.session.id), false);
  } finally {
    await server.stop();
  }
});

test('independent athlete session is server-owned, immediately approved and returns on the same canonical id', async () => {
  const server = await startAthleteServer();
  try {
    const session = await login(server.baseUrl);
    const created = await requestJson(server.baseUrl, '/swimmer/athlete-sessions', session, 'POST', {
      disciplineId: 'running',
      date: '2026-08-29',
      title: 'Independent easy run',
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    assert.equal(created.payload?.approvalRequired, false);
    assert.equal(created.payload?.policy, 'independent');
    assert.equal(created.payload?.session?.approvalStatus, 'approved');
    assert.equal(created.payload?.session?.ownerClubId, '');
    assert.equal(created.payload?.session?.ownerType, 'athlete');

    const home = await athleteHome(server.baseUrl, session);
    assert.equal(home.response.status, 200, JSON.stringify(home.payload));
    assert.ok(home.payload?.sessions?.some((row) => row.id === created.payload.session.id));
  } finally {
    await server.stop();
  }
});

test('coach-authoritative session write appears to the swimmer with the same session and set ids', async () => {
  const server = await startAthleteServer();
  try {
    const coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const before = await requestJson(server.baseUrl, '/db', coach);
    assert.equal(before.response.status, 200, JSON.stringify(before.payload));

    const nextDb = {
      ...before.payload,
      trainingSessions: [
        ...(before.payload?.trainingSessions || []),
        {
          id: 'coach-created-session',
          scheduleId: 'coach-created-schedule',
          squadId: 'squad-a',
          clubId: 'club-a',
          title: 'Coach-created race pace',
          coachName: 'Coach A',
          totalVolume: 2400,
        },
      ],
      trainingSessionSets: [
        ...(before.payload?.trainingSessionSets || []),
        {
          id: 'coach-created-set',
          trainingSessionId: 'coach-created-session',
          order: 1,
          reps: 12,
          distance: 50,
          stroke: 'Free',
          sendoff: '0:50',
        },
      ],
    };
    const saved = await requestJson(server.baseUrl, '/db', coach, 'PUT', nextDb);
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));

    const swimmer = await login(server.baseUrl);
    const result = await athleteHome(server.baseUrl, swimmer);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    const coachSession = result.payload?.sessions?.find((row) => row.id === 'coach-created-session');
    assert.ok(coachSession, 'Coach-created session was not visible to the swimmer.');
    assert.equal(coachSession.title, 'Coach-created race pace');
    assert.deepEqual(coachSession.sets.map((row) => row.id), ['coach-created-set']);
    assert.equal(coachSession.sets[0].reps, 12);
    assert.equal(coachSession.sets[0].distance, 50);
  } finally {
    await server.stop();
  }
});
