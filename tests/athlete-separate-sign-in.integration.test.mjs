import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

// The Athlete App keeps its own sign-in next to the coaching app's in the same browser (22-11-2026).
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
    { username: 'swimA', password: 'SwimA!Pass12345', role: 'swimmer', tenantId: 'tenant-a', clubId: 'club-a', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now },
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

async function startServer(envOverrides = {}, seed = null, reuse = null) {
  // `reuse` restarts the application on the same storage (to test what survives a restart).
  const tempRoot = reuse?.tempRoot || mkTempDir('athlyrax-athlete-signin-');
  const paths = reuse?.paths || createFixtureStorage(tempRoot);
  if (seed && !reuse) seed(paths);
  envOverrides = { ATHLYRAX_DEV_EMAIL_OUTBOX: path.join(tempRoot, 'outbox.jsonl'), ...envOverrides };
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
    output: () => stdout,
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    tempRoot,
    tempRoot, paths,
    outbox: () => (fs.existsSync(path.join(tempRoot, 'outbox.jsonl')) ? fs.readFileSync(path.join(tempRoot, 'outbox.jsonl'), 'utf8') : ''),
    restart: async (env = {}) => {
      if (!child.killed) child.kill('SIGTERM');
      await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 2000); });
      return startServer(env, null, { tempRoot, paths });
    },
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


const ATHLETE = { 'X-AthlyraX-App': 'athlete' };
const setCookies = (response) => (response.headers.getSetCookie ? response.headers.getSetCookie() : []);
const names = (response) => setCookies(response).map((row) => String(row).split('=')[0].trim());
const jar = (...responses) => responses.flatMap((r) => setCookies(r)).map((row) => String(row).split(';')[0].trim()).filter((pair) => !pair.endsWith('=')).join('; ');
const csrfFrom = (cookie, name) => decodeURIComponent((cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)) || [])[1] || '');
async function signIn(baseUrl, username, password, headers = {}) {
  const response = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200, `login ${username}`);
  return response;
}
async function whoAmI(baseUrl, cookie, headers = {}) {
  const response = await fetch(`${baseUrl}/auth/me`, { headers: { Cookie: cookie, ...headers } });
  const body = await response.json().catch(() => ({}));
  return response.ok ? String(body?.user?.username || body?.username || '') : `HTTP ${response.status}`;
}

test('coach and athlete stay signed in side by side; each app reads and clears only its own sign-in', async () => {
  const server = await startServer();
  try {
    const { baseUrl } = server;
    const coach = await signIn(baseUrl, 'coachA', 'CoachA!Pass1234');
    assert.deepEqual(names(coach).sort(), ['athlyrax_csrf', 'athlyrax_session']);
    const athlete = await signIn(baseUrl, 'swimA', 'SwimA!Pass12345', ATHLETE);
    assert.deepEqual(names(athlete).sort(), ['athlyrax_athlete_csrf', 'athlyrax_athlete_session'], 'the athlete sign-in never replaces the coach cookie');
    const both = jar(coach, athlete);
    assert.equal(await whoAmI(baseUrl, both), 'coachA', 'coaching app: coach');
    assert.equal(await whoAmI(baseUrl, both, ATHLETE), 'swimA', 'Athlete App: athlete');

    // A coaching session is never used by the Athlete App, and a coach signing in on the athlete page stays in the shared cookie.
    assert.notEqual(await whoAmI(baseUrl, jar(coach), ATHLETE), 'coachA');
    const coachOnAthletePage = await signIn(baseUrl, 'coachA', 'CoachA!Pass1234', ATHLETE);
    assert.deepEqual(names(coachOnAthletePage).sort(), ['athlyrax_csrf', 'athlyrax_session']);

    // CSRF double-submit uses the cookie of the session actually used.
    const athleteCsrf = csrfFrom(both, 'athlyrax_athlete_csrf');
    const coachCsrf = csrfFrom(both, 'athlyrax_csrf');
    const ping = (headers) => fetch(`${baseUrl}/auth/presence/ping`, { method: 'POST', headers: { Cookie: both, ...headers } }).then((r) => r.status);
    assert.equal(await ping({ ...ATHLETE, 'x-csrf-token': athleteCsrf }), 200);
    assert.equal(await ping({ ...ATHLETE, 'x-csrf-token': coachCsrf }), 403, 'the coach token does not authorise the athlete session');
    assert.equal(await ping({ 'x-csrf-token': coachCsrf }), 200);
    assert.equal(await ping({ 'x-csrf-token': athleteCsrf }), 403, 'the athlete token does not authorise the coach session');

    // Signing out of the Athlete App clears only the athlete sign-in.
    const out = await fetch(`${baseUrl}/auth/logout`, { method: 'POST', headers: { Cookie: both, ...ATHLETE, 'x-csrf-token': athleteCsrf } });
    assert.equal(out.status, 200);
    assert.deepEqual(names(out).sort(), ['athlyrax_athlete_csrf', 'athlyrax_athlete_session']);
    assert.equal(await whoAmI(baseUrl, jar(coach)), 'coachA');
  } finally { await server.stop(); }
});

test('an athlete session already in the shared cookie still works in the Athlete App and signs out there', async () => {
  const server = await startServer();
  try {
    const { baseUrl } = server;
    const legacy = await signIn(baseUrl, 'swimA', 'SwimA!Pass12345');
    assert.deepEqual(names(legacy).sort(), ['athlyrax_csrf', 'athlyrax_session']);
    const cookie = jar(legacy);
    assert.equal(await whoAmI(baseUrl, cookie, ATHLETE), 'swimA');
    const out = await fetch(`${baseUrl}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, ...ATHLETE, 'x-csrf-token': csrfFrom(cookie, 'athlyrax_csrf') } });
    assert.equal(out.status, 200);
    assert.ok(names(out).includes('athlyrax_session'), 'the shared athlete session is cleared too');
  } finally { await server.stop(); }
});
