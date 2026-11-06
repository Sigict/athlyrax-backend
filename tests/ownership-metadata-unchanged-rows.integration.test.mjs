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

async function startServer(envOverrides = {}, seed = null) {
  const tempRoot = mkTempDir('athlyrax-ownership-unchanged-');
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

// ATHLYRAX_OWNERSHIP_KEEP_UNCHANGED_ROWS: a whole-club save must not restamp rows it did not change.
const OLD = '2026-10-01T08:00:00.000Z';
const audit = { createdByUserId: 'coacha', createdAt: OLD, updatedByUserId: 'coacha', updatedAt: OLD, tenantId: 'tenant-a', attributionStatus: 'attributed' };
const seedRows = {
  swimmers: [{ id: 'swimmerA', name: 'Swimmer A', ...audit }],
  squads: [{ id: 'squadA', name: 'Squad A', ...audit }],
  schedule: [{ id: 'sch-a', date: '2026-11-06', trainingSessionId: 'sessionA', title: 'A Session', ...audit }],
  trainingSessions: [{ id: 'sessionA', scheduleId: 'sch-a', date: '2026-11-06', title: 'A Session', ...audit }],
  trainingSessionSets: [
    { id: 'set-1', trainingSessionId: 'sessionA', order: 1, reps: 4, distance: 50, sendOff: '1:00', resultsBySwimmer: { swimmerA: { reps: [{ overallTime: '31.50', splits: [{ distance: 25, time: '15.20' }] }] } }, ...audit },
    { id: 'set-2', trainingSessionId: 'sessionA', order: 2, reps: 3, distance: 100, sendOff: '1:40', ...audit },
  ],
  attendance: [{ id: 'att-1', scheduleId: 'sch-a', swimmerId: 'swimmerA', status: 'present', ...audit }],
  tests: [{ id: 'test-1', swimmerId: 'swimmerA', event: '100 Free', time: '1:02.30', ...audit }],
  fixtures: [{ id: 'fix-1', name: 'County Champs', date: '2026-12-01', ...audit }],
  // A legacy row stored without any attribution or modification time.
  venues: [{ id: 'venue-legacy', name: 'Old Pool' }],
  coachObservations: [{ id: 'obs-1', swimmerId: 'swimmerA', note: 'Good turns', createdAt: OLD, updatedAt: OLD }],
  swimmerAnalyses: [{ id: 'an-1', swimmerId: 'swimmerA', summary: 'x', updatedAt: OLD }],
};
const seedOwnership = (paths) => writeJson(path.join(paths.storageRoot, 'tenants', 'tenant-a', 'db.json'), seedRows);
const KEYS = ['swimmers', 'squads', 'schedule', 'trainingSessions', 'trainingSessionSets', 'attendance', 'tests', 'fixtures', 'venues', 'coachObservations', 'swimmerAnalyses'];
const byId = (db, key, id) => (db[key] || []).find((r) => r.id === id);

test('whole-club save keeps audit metadata of unchanged rows and stamps only changed rows', async () => {
  const server = await startServer({}, seedOwnership);
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const before = (await request(base, '/db', coach)).payload;
    // Save the whole club back with one genuine change: set-2 send-off 1:40 -> 1:45.
    const body = JSON.parse(JSON.stringify(before));
    byId(body, 'trainingSessionSets', 'set-2').sendOff = '1:45';
    // A client that re-orders keys must not count as a change.
    body.swimmers = body.swimmers.map((r) => Object.fromEntries(Object.entries(r).reverse()));
    const put = await request(base, '/db', { ...coach, method: 'PUT', body });
    assert.equal(put.response.status, 200, JSON.stringify(put.payload));
    const after = (await request(base, '/db', coach)).payload;

    for (const key of KEYS) {
      for (const row of seedRows[key]) {
        if (row.id === 'set-2' || row.id === 'venue-legacy') continue;
        assert.deepEqual(byId(after, key, row.id), byId(before, key, row.id), `${key}/${row.id} unchanged, including audit metadata`);
        assert.equal(byId(after, key, row.id).updatedAt, OLD, `${key}/${row.id} keeps its original updatedAt`);
      }
    }
    // Historical measurements untouched.
    assert.deepEqual(byId(after, 'trainingSessionSets', 'set-1').resultsBySwimmer, seedRows.trainingSessionSets[0].resultsBySwimmer);
    assert.equal(byId(after, 'tests', 'test-1').time, '1:02.30');

    // The changed row: new modification metadata, original creation metadata kept.
    const changed = byId(after, 'trainingSessionSets', 'set-2');
    assert.equal(changed.sendOff, '1:45');
    assert.notEqual(changed.updatedAt, OLD);
    assert.ok(Date.parse(changed.updatedAt) > Date.parse(OLD));
    assert.equal(changed.updatedByUserId, 'coacha');
    assert.equal(changed.createdAt, OLD);
    assert.equal(changed.createdByUserId, 'coacha');

    // Legacy unattributed row: attribution added, no modification time invented.
    const legacy = byId(after, 'venues', 'venue-legacy');
    assert.equal(legacy.name, 'Old Pool');
    assert.equal(legacy.createdByUserId, 'legacy-unattributed');
    assert.equal(legacy.attributionStatus, 'unattributed-legacy');
    assert.equal(legacy.updatedAt, undefined);
    assert.equal(legacy.updatedByUserId, undefined);

    // A second identical save changes nothing at all.
    const again = await request(base, '/db', { ...coach, method: 'PUT', body: after });
    assert.equal(again.response.status, 200, JSON.stringify(again.payload));
    const after2 = (await request(base, '/db', coach)).payload;
    for (const key of KEYS) assert.deepEqual(after2[key], after[key], `${key} identical after an unchanged save`);

    // A new row is attributed to the saving coach.
    const withNew = JSON.parse(JSON.stringify(after2));
    withNew.fixtures.push({ id: 'fix-2', name: 'Winter Open', date: '2026-12-12' });
    assert.equal((await request(base, '/db', { ...coach, method: 'PUT', body: withNew })).response.status, 200);
    const after3 = (await request(base, '/db', coach)).payload;
    const added = byId(after3, 'fixtures', 'fix-2');
    assert.equal(added.createdByUserId, 'coacha');
    assert.ok(added.updatedAt && added.updatedAt !== OLD);
    assert.deepEqual(byId(after3, 'fixtures', 'fix-1'), byId(before, 'fixtures', 'fix-1'));
    assert.deepEqual(byId(after3, 'attendance', 'att-1'), byId(before, 'attendance', 'att-1'));
  } finally {
    await server.stop();
  }
});
