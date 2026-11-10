import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
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

async function startServer(envOverrides = {}, seed = null, reuse = null) {
  // `reuse` restarts the application on the same storage (to test what survives a restart).
  const tempRoot = reuse?.tempRoot || mkTempDir('athlyrax-athlete-invites-');
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

const post = (base, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const mails = (server) => server.outbox().split('\n').filter(Boolean).map((l) => JSON.parse(l));

function jar(base) {
  const c = {};
  const req = async (m, p, body, { csrf = true } = {}) => {
    const h = { Accept: 'application/json', Cookie: Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (csrf && m !== 'GET' && c.athlyrax_csrf) h['x-csrf-token'] = decodeURIComponent(c.athlyrax_csrf);
    const r = await fetch(base + p, { method: m, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const sc of r.headers.getSetCookie?.() || []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); c[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  return { get: (p) => req('GET', p), post: (p, b = {}, o) => req('POST', p, b, o), login: (u, pw, as) => req('POST', '/auth/login', { username: u, password: pw, ...(as ? { as } : {}) }, { csrf: false }) };
}

test('one account, several roles: coach adds own swimmer profile, switches with CSRF, keeps permissions apart; guardian view after email confirmation; child invitations never link adults', async () => {
  const seed = (paths) => {
    const users = JSON.parse(fs.readFileSync(paths.authUsersPath, 'utf8'));
    users.push({ username: 'coachm', password: 'CoachM!Pass12345', role: 'head-coach', tenantId: 'tenant-a', clubId: 'club-a', swimClub: 'Club A', teamName: 'Team A', email: 'coach.m@example.com', fullName: 'Morgan Coach', createdVia: 'admin', isApproved: true, onboardingCompletedAt: new Date().toISOString() });
    writeJson(paths.authUsersPath, users); writeJson(paths.authUsersBackupPath, users);
    writeJson(path.join(paths.storageRoot, 'tenants', 'tenant-a', 'db.json'), { squads: [{ id: 'sq-a', name: 'Squad A' }], swimmers: [{ id: 'kid1', firstName: 'Kai', lastName: 'Child', squadId: 'sq-a', dob: '2014-03-03' }, { id: 'kid4', firstName: 'Ola', lastName: 'Child', squadId: 'sq-a', dob: '2014-03-03' }] });
  };
  const server = await startServer({ AUTH_LOGIN_RATE_MAX_ATTEMPTS: '200', AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS: '400' }, seed);
  const base = server.baseUrl;
  try {
    const m = jar(base); assert.equal((await m.login('coachm', 'CoachM!Pass12345')).status, 200);
    let roles = await m.get('/auth/roles');
    assert.deepEqual(roles.j.roles.map((r) => r.role), ['coach']); assert.equal(roles.j.canAddAthlete, true);
    assert.equal((await m.post('/auth/switch-role', { role: 'athlete' })).status, 403, 'no athlete role yet');
    assert.equal((await m.post('/auth/roles/athlete/enable', {})).status, 201);
    assert.equal((await m.post('/auth/switch-role', { role: 'athlete' }, { csrf: false })).status, 403, 'CSRF required');
    const sw = await m.post('/auth/switch-role', { role: 'athlete' });
    assert.equal(sw.status, 200);
    const me = await m.get('/auth/me');
    assert.equal(me.j.user.role, 'swimmer'); assert.equal(me.j.user.activeRole, 'athlete');
    assert.equal((await m.get('/coach/athlete-invites/overview')).status, 403, 'coach routes refused in athlete mode');
    assert.equal((await m.get('/swimmer/personal-training')).status, 200);
    const db = await m.get('/db');
    assert.equal((db.j.swimmers || []).length, 1); assert.ok(!['kid1', 'kid4'].includes(db.j.swimmers[0].id), 'own record, never a coached swimmer');
    assert.equal((await m.post('/auth/switch-role', { role: 'coach' })).status, 200);
    assert.equal((await m.get('/coach/athlete-invites/overview')).status, 200);
    assert.equal((await m.get('/swimmer/personal-training')).status, 403);
    // Swimmer sign-in with the same account opens the athlete role directly; a plain sign-in opens coaching.
    const m2 = jar(base); const li = await m2.login('coachm', 'CoachM!Pass12345', 'athlete');
    assert.equal(li.status, 200); assert.equal(li.j.user.role, 'swimmer');
    const stored = JSON.parse(fs.readFileSync(server.paths.authUsersPath, 'utf8')).find((u) => u.username === 'coachm');
    assert.equal(stored.athleteRole.enabled, true, 'athlete role persisted');
    // Child invitation: the coach (also the parent here) cannot take it as their own record.
    const link = await m.post('/coach/swimmers/kid4/athlete-invites', { guardianEmail: 'coach.m@example.com' });
    assert.equal(link.status, 201);
    const asCoach = await m.post('/athlete-invites/accept', { token: link.j.athleteToken });
    assert.equal(asCoach.status, 409); assert.equal(asCoach.j.code, 'child-invitation-adult-account');
    const anon = jar(base);
    const parentEmail = await anon.post('/athlete-invites/accept', { token: link.j.athleteToken, username: 'olachild', password: 'OlaChild!Pass1234', fullName: 'Ola Child', email: 'coach.m@example.com' });
    assert.equal(parentEmail.status, 400); assert.equal(parentEmail.j.code, 'guardian-email-for-child');
    // Guardian role appears for the account's email; details only after confirming the email by code.
    roles = await m.get('/auth/roles');
    assert.deepEqual(roles.j.roles.map((r) => r.role).sort(), ['athlete', 'coach', 'guardian']);
    assert.equal((await m.get('/guardian/children')).status, 403);
    const before = mails(server).length;
    assert.equal((await m.post('/guardian/verify-email/start', {})).status, 200);
    const code = (mails(server).slice(before).map((x) => (x.text.match(/parent\/guardian view is: (\d{6})/) || [])[1]).filter(Boolean)).pop();
    assert.equal((await m.post('/guardian/verify-email/confirm', { code: code === '000000' ? '111111' : '000000' })).status, 400);
    assert.equal((await m.post('/guardian/verify-email/confirm', { code })).status, 200);
    const kids = await m.get('/guardian/children');
    assert.equal(kids.status, 200); assert.deepEqual(kids.j.children.map((k) => k.swimmerFirstName), ['Ola']);
    const db2 = JSON.parse(fs.readFileSync(path.join(server.paths.storageRoot, 'tenants', 'tenant-a', 'db.json'), 'utf8'));
    assert.equal(db2.swimmers.length, 2, 'no swimmer created in the club');
    assert.ok(!db2.swimmers.some((r) => r.swimmerAccountUsername === 'coachm'));
  } finally { await server.stop(); }
});
