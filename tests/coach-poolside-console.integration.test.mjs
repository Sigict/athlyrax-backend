import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { resolveStorageConfiguration } from '../scripts/storage-safety-lib.mjs';
import Stripe from 'stripe';

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

async function startServer(envOverrides = {}, seed = null) {
  const tempRoot = mkTempDir('athlyrax-poolside-console-');
  const paths = createFixtureStorage(tempRoot);
  if (seed) seed(paths);
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


const DATE = '2026-11-06';
const seed = (paths) => writeJson(path.join(paths.storageRoot, 'tenants', 'tenant-a', 'db.json'), {
  swimmers: [{ id: 'swimmerA', name: 'Swimmer A' }, { id: 'swimmerA2', name: 'Swimmer A2' }],
  squads: [{ id: 'squadA', name: 'Squad A' }],
  schedule: [{ id: 'sch-a', date: DATE, trainingSessionId: 'sessionA', title: 'A Session', startTime: '18:00' }],
  trainingSessions: [{ id: 'sessionA', scheduleId: 'sch-a', date: DATE, title: 'A Session' }],
  trainingSessionSets: [
    { id: 'set-1', trainingSessionId: 'sessionA', order: 1, reps: 4, distance: 50, sendOff: '1:00', title: 'Warm up' },
    { id: 'set-2', trainingSessionId: 'sessionA', order: 2, reps: 8, distance: 100, sendOff: '1:30', title: 'Main', resultsBySwimmer: { swimmerA: { reps: [{ overallTime: '1:10.00' }] } } },
  ],
  attendance: [],
});

test('Coach Pool Console: load session, save results per set and rep without overwriting, lane plan, roles', async () => {
  const server = await startServer({}, seed);
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const loaded = await request(base, `/coach/poolside?date=${DATE}`, coach);
    assert.equal(loaded.response.status, 200, JSON.stringify(loaded.payload));
    const session = loaded.payload.sessions[0];
    assert.equal(session.id, 'sessionA');
    assert.deepEqual(session.sets.map((s) => s.id), ['set-1', 'set-2'], 'every planned set, in order');
    assert.deepEqual(session.sets.map((s) => s.title), ['Warm up', 'Main']);

    // Results to the SECOND set, reps 1 and 3: rep 1 already recorded and kept, rep 3 saved.
    const saved = await request(base, '/coach/poolside/sessions/sessionA/sets/set-2/results', { ...coach, method: 'POST', body: { swimmerId: 'swimmerA', source: 'coach-pool-console', reps: [{ rep: 1, overallTime: '1:20.00' }, { rep: 3, overallTime: '1:12.40' }] } });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    assert.equal(saved.payload.written, 1);
    assert.equal(saved.payload.kept, 1);
    const db = (await request(base, '/db', coach)).payload;
    const set2 = db.trainingSessionSets.find((s) => s.id === 'set-2');
    assert.equal(set2.resultsBySwimmer.swimmerA.reps[0].overallTime, '1:10.00');
    assert.equal(set2.resultsBySwimmer.swimmerA.reps[2].overallTime, '1:12.40');
    assert.equal(db.trainingSessionSets.find((s) => s.id === 'set-1').resultsBySwimmer, undefined, 'first set untouched');

    // Lane plan saves and reloads with the session.
    const lanes = await request(base, '/coach/poolside/sessions/sessionA/lanes', { ...coach, method: 'POST', body: { lanes: [{ lane: 'Lane 1', swimmerIds: ['swimmerA', 'swimmerA2'], sendoffSeconds: 90, staggerSeconds: 5 }] } });
    assert.equal(lanes.response.status, 200, JSON.stringify(lanes.payload));
    const reloaded = await request(base, `/coach/poolside?date=${DATE}`, coach);
    assert.deepEqual(reloaded.payload.sessions[0].lanePlan.lanes[0], { lane: 'Lane 1', swimmerIds: ['swimmerA', 'swimmerA2'], sendoffSeconds: 90, staggerSeconds: 5 });

    // Set change (send-off) saves to the canonical set.
    const change = await request(base, '/coach/poolside/sessions/sessionA/sets/set-1', { ...coach, method: 'POST', body: { reps: 4, sendoffSeconds: 75 } });
    assert.equal(change.response.status, 200, JSON.stringify(change.payload));

    // Viewer cannot write; another club cannot see the session.
    const viewer = await login(base, 'viewerA', 'ViewerA!Pass1234');
    assert.equal((await request(base, '/coach/poolside/sessions/sessionA/lanes', { ...viewer, method: 'POST', body: { lanes: [] } })).response.status, 403);
    const other = await login(base, 'coachB', 'CoachB!Pass1234');
    assert.deepEqual((await request(base, `/coach/poolside?date=${DATE}`, other)).payload.sessions, []);
    assert.equal((await request(base, '/coach/poolside/sessions/sessionA/sets/set-2/results', { ...other, method: 'POST', body: { swimmerId: 'swimmerA', reps: [{ rep: 2, overallTime: '1:00.00' }] } })).response.status, 404);
  } finally { await server.stop(); }
});

test('coach observation routes exist in the production build', async () => {
  const server = await startServer({}, seed);
  try {
    const coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    for (const route of ['/coach/observations', '/coach/poolside/sessions/sessionA/swimmers/swimmerA/observations']) {
      const r = await request(server.baseUrl, route, { ...coach, method: 'POST', body: {} });
      assert.notEqual(r.response.headers.get('content-type')?.includes('text/html') && r.response.status === 404, true, `${route} must be a registered route`);
    }
  } finally { await server.stop(); }
});
