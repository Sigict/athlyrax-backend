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

test('independent swimmer sign-up verifies the email before the first sign-in; existing accounts unaffected', async () => {
  const server = await startServer({ AUTH_LOGIN_RATE_MAX_ATTEMPTS: '200', AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS: '400' });
  const base = server.baseUrl;
  try {
    const email = 'indie.swimmer@example.com';
    const created = await post(base, '/snapshot/account/auth', { email, password: 'Indie!Pass1234', fullName: 'Indie Swimmer', createAccount: true, requireEmailVerification: true });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.verificationRequired, true);
    assert.equal(created.json.token, undefined, 'no session before verification');
    // Sign-in is refused until verified (both sign-in routes).
    const blocked = await post(base, '/auth/login', { username: email, password: 'Indie!Pass1234' });
    assert.equal(blocked.status, 403); assert.equal(blocked.json.needsEmailVerification, true);
    assert.equal((await post(base, '/snapshot/account/auth', { email, password: 'Indie!Pass1234' })).status, 403);
    const code = (mails(server).filter((m) => m.to === email).map((m) => (m.text.match(/verification code is: (\d{6})/) || [])[1]).filter(Boolean)).pop();
    assert.ok(code, 'verification code emailed');
    assert.ok(!server.output().includes(code), 'code not in logs');
    assert.equal((await post(base, '/snapshot/account/verify-email', { email, code: code === '000000' ? '111111' : '000000' })).status, 400);
    assert.equal((await post(base, '/snapshot/account/verify-email/resend', { email })).status, 429, 'resend waits a minute');
    const ok = await post(base, '/snapshot/account/verify-email', { email, code });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const login = await post(base, '/auth/login', { username: email, password: 'Indie!Pass1234' });
    assert.equal(login.status, 200, JSON.stringify(login.json));
    assert.equal(login.json.user.role, 'swimmer');
    // Verification survives a restart (persisted on the account).
    const stored = JSON.parse(fs.readFileSync(server.paths.authUsersPath, 'utf8')).find((u) => u.email === email);
    assert.ok(stored.emailVerifiedAt && stored.emailVerificationRequired === true);
    // Free Snapshot sign-up (no verification flag) still signs in at once, as before.
    const snap = await post(base, '/snapshot/account/auth', { email: 'snap.user@example.com', password: 'Snap!Pass1234', fullName: 'Snap User', createAccount: true });
    assert.equal(snap.status, 201); assert.ok(snap.json.token);
    assert.equal((await post(base, '/auth/login', { username: 'coachA', password: 'CoachA!Pass1234' })).status, 200, 'existing accounts unaffected');
  } finally { await server.stop(); }
});

test('independent athlete joins a club through its invitation and can leave; personal training and club history kept', async () => {
  const seed = (paths) => writeJson(path.join(paths.storageRoot, 'tenants', 'tenant-a', 'db.json'), {
    squads: [{ id: 'sq-a', name: 'Squad A' }], swimmers: [{ id: 'rec-1', firstName: 'Ivy', lastName: 'Indie', squadId: 'sq-a', dob: '1999-02-02', swimmerEmail: 'ivy@example.com' }], tests: [{ id: 't1', swimmerId: 'rec-1', time: '1:01.00' }],
  });
  const server = await startServer({ AUTH_LOGIN_RATE_MAX_ATTEMPTS: '200', AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS: '400' }, seed);
  const base = server.baseUrl;
  const jar = { cookie: '', csrf: '' };
  const send = async (route, body, method = 'POST') => { const r = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(jar.cookie ? { Cookie: jar.cookie } : {}), ...(jar.csrf && method !== 'GET' ? { 'x-csrf-token': jar.csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); const c = cookieHeader(r); if (c) jar.cookie = c; const j = await r.json().catch(() => ({})); if (j.csrfToken) jar.csrf = j.csrfToken; return { status: r.status, json: j }; };
  try {
    const email = 'ivy@example.com';
    await post(base, '/snapshot/account/auth', { email, password: 'Ivy!Pass123456', fullName: 'Ivy Indie', createAccount: true, requireEmailVerification: true });
    await post(base, '/snapshot/account/verify-email', { email, code: (mails(server).map((m) => (m.text.match(/verification code is: (\d{6})/) || [])[1]).filter(Boolean)).pop() });
    assert.equal((await send('/auth/login', { username: email, password: 'Ivy!Pass123456' })).status, 200);
    const day = { kind: 'day', id: 'day-1', baseRev: 0, data: { date: '2026-11-01', sessions: [{ id: 'ses-1', label: 'My own swim', pool: 'SCM', sets: [], questionnaire: {} }] } };
    assert.equal((await send('/swimmer/personal-training/sync', { changes: [day] })).status, 200);
    // The club invites the athlete (coach session in its own cookie jar).
    const coachLogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'coachA', password: 'CoachA!Pass1234' }) });
    const coach = { cookie: cookieHeader(coachLogin), csrf: (await coachLogin.json()).csrfToken };
    const bulk = await fetch(`${base}/coach/athlete-invites/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: coach.cookie, 'x-csrf-token': coach.csrf }, body: JSON.stringify({ requestId: 'req-indie-join-1', items: [{ swimmerId: 'rec-1', athleteEmail: email }] }) });
    assert.equal(bulk.status, 200);
    const token = decodeURIComponent((mails(server).map((m) => (m.text.match(/#token=([^\s]+)/) || [])[1]).filter(Boolean)).pop());
    const accepted = await send('/athlete-invites/accept', { token });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    let db = JSON.parse(fs.readFileSync(path.join(server.paths.storageRoot, 'tenants', 'tenant-a', 'db.json'), 'utf8'));
    assert.equal(db.swimmers.length, 1); assert.ok(db.swimmers[0].swimmerAccountUsername);
    const stored = JSON.parse(fs.readFileSync(server.paths.authUsersPath, 'utf8')).find((u) => u.email === email);
    assert.ok(stored.athleteTenantConnections.some((c) => c.tenantId === 'tenant-a' && c.status === 'active'), 'club connection persisted');
    assert.ok(stored.independentProfile?.tenantId, 'independent profile recorded, not merged');
    assert.ok(JSON.stringify((await send('/swimmer/personal-training', null, 'GET')).json).includes('My own swim'));
    // Leave the club.
    const left = await send('/swimmer/clubs/leave', { tenantId: 'tenant-a' });
    assert.equal(left.status, 200, JSON.stringify(left.json));
    db = JSON.parse(fs.readFileSync(path.join(server.paths.storageRoot, 'tenants', 'tenant-a', 'db.json'), 'utf8'));
    assert.ok(!db.swimmers[0].swimmerAccountUsername); assert.equal(db.tests.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(server.paths.authUsersPath, 'utf8')).find((u) => u.email === email).athleteTenantConnections.find((c) => c.tenantId === 'tenant-a').status, 'left');
    assert.ok(JSON.stringify((await send('/swimmer/personal-training', null, 'GET')).json).includes('My own swim'));
    assert.equal((await send('/swimmer/clubs/leave', { tenantId: 'tenant-a' })).status, 404, 'already left');
  } finally { await server.stop(); }
});
