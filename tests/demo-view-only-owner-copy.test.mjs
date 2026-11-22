import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildOwnerWorkspace, copyDemoToOwnerWorkspace, ownerWorkspaceCopyPending, primaryOwnerUsername } from '../scripts/owner-workspace-copy.mjs';

// Public demonstration accounts (Demo Coach, Marco) are view-only for every visitor; the Software Owner gets a
// one-time independent copy of the Demo Coach club (owner decision 22-11-2026).
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
    { username: 'demo.coach', password: 'DemoCoach123!', role: 'head-coach', tenantId: 'demo-company', clubId: 'demo-company', swimClub: 'Demo Company', teamName: 'Demo Team', email: 'demo-owner@example.invalid', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now },
    { username: 'marco', password: 'Marco!Pass12345', role: 'swimmer', tenantId: 'demo-company', clubId: 'demo-company', email: 'marco@example.invalid', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now },
  ];

  writeJson(authUsersPath, users);
  writeJson(authUsersBackupPath, users);
  writeJson(path.join(storageRoot, 'auth-invites.json'), []);
  writeJson(path.join(storageRoot, 'db.json'), { swimmers: [{ id: 'owner-swimmer' }] });
  writeJson(path.join(storageRoot, 'tenants', 'tenant-a', 'db.json'), {
    swimmers: [{ id: 'swimmerA', name: 'Swimmer A' }], squads: [{ id: 'squadA', name: 'Squad A' }], trainingSessions: [{ id: 'sessionA', title: 'A Session' }],
  });
  writeJson(path.join(storageRoot, 'tenants', 'demo-company', 'db.json'), { swimmers: [{ id: 'demo-swimmer', firstName: 'Demo' }], squads: [] });
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
  const tempRoot = reuse?.tempRoot || mkTempDir('athlyrax-demo-view-only-');
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



const setCookies = (response) => (response.headers.getSetCookie ? response.headers.getSetCookie() : []);
const jar = (response) => setCookies(response).map((row) => String(row).split(';')[0].trim()).filter((pair) => !pair.endsWith('=')).join('; ');
const csrfFrom = (cookie, name = 'athlyrax_csrf') => decodeURIComponent((cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)) || [])[1] || '');
async function signIn(baseUrl, username, password, headers = {}) {
  const response = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200, `login ${username}`);
  const cookie = jar(response); return { cookie, csrf: csrfFrom(cookie, headers['X-AthlyraX-App'] ? 'athlyrax_athlete_csrf' : 'athlyrax_csrf'), headers };
}
const call = (baseUrl, s, method, url, body) => fetch(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json', Cookie: s.cookie, 'x-csrf-token': s.csrf, ...s.headers }, body: body === undefined ? undefined : JSON.stringify(body) });

test('Demo Coach and Marco: many visitors, everything readable, every change refused; other accounts unaffected', async () => {
  const server = await startServer();
  try {
    const { baseUrl, paths } = server;
    const demoFile = path.join(paths.storageRoot, 'tenants', 'demo-company', 'db.json');
    const before = crypto.createHash('sha256').update(fs.readFileSync(demoFile)).digest('hex');
    const v1 = await signIn(baseUrl, 'demo.coach', 'DemoCoach123!');
    const v2 = await signIn(baseUrl, 'demo.coach', 'DemoCoach123!');
    for (const v of [v1, v2]) {
      const me = await (await call(baseUrl, v, 'GET', '/auth/me')).json();
      assert.equal(me.user.username, 'demo.coach'); assert.equal(me.user.demoViewOnly, true);
      const db = await (await call(baseUrl, v, 'GET', '/db')).json();
      assert.equal(db.swimmers[0].id, 'demo-swimmer');
    }
    const put = await call(baseUrl, v1, 'PUT', '/db', { swimmers: [] });
    assert.equal(put.status, 403); assert.equal((await put.json()).demoViewOnly, true);
    assert.equal((await call(baseUrl, v2, 'POST', '/auth/change-password', { currentPassword: 'DemoCoach123!', newPassword: 'Other!Pass12345' })).status, 403);
    assert.equal((await call(baseUrl, v1, 'POST', '/auth/presence/ping')).status, 200);
    assert.equal((await call(baseUrl, v2, 'POST', '/auth/presence/ping')).status, 200);
    const marco = await signIn(baseUrl, 'marco', 'Marco!Pass12345', { 'X-AthlyraX-App': 'athlete' });
    assert.equal((await call(baseUrl, marco, 'POST', '/swimmer/personal-training', { changes: [] })).status, 403);
    assert.equal((await call(baseUrl, marco, 'POST', '/auth/change-username', { newUsername: 'marco2', password: 'Marco!Pass12345' })).status, 403);
    assert.equal((await call(baseUrl, marco, 'POST', '/swimmer/capability/compute', { axisIds: [], snapshots: [] })).status, 200, 'calculation-only requests stay open');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(demoFile)).digest('hex'), before, 'Demo Coach data unchanged');

    // Public password reset for a demonstration account: the usual neutral answer, no code, no e-mail.
    const reset = await fetch(`${baseUrl}/auth/password-reset/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'demo.coach' }) });
    assert.equal(reset.status, 200);
    assert.equal(server.outbox().includes('demo-owner@example.invalid'), false);
    assert.equal((await fetch(`${baseUrl}/auth/password-reset/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo.coach', code: '123456', password: 'Other!Pass12345' }) })).status, 400);
    assert.equal(await (await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo.coach', password: 'DemoCoach123!' }) })).status, 200, 'password unchanged');

    // Another club's coach still writes; the owner sees every demo visitor separately.
    const coach = await signIn(baseUrl, 'coachA', 'CoachA!Pass1234');
    const clubDb = await (await call(baseUrl, coach, 'GET', '/db')).json();
    assert.equal((await call(baseUrl, coach, 'PUT', '/db', { ...clubDb, swimmers: [...clubDb.swimmers, { id: 'new', name: 'New' }] })).status, 200);
    const owner = await signIn(baseUrl, 'softwareowner', 'Owner!Pass1234');
    const presence = await (await call(baseUrl, owner, 'GET', '/auth/presence/summary')).json();
    const demoVisitors = presence.connectedUsers.filter((u) => u.username.startsWith('demo.coach · visitor '));
    assert.equal(demoVisitors.length, 2); assert.ok(demoVisitors.every((u) => u.role === 'head-coach'));
    assert.ok(presence.connectedUsers.some((u) => u.username.startsWith('marco · visitor ')));
    assert.ok(presence.connectedUsers.some((u) => u.username === 'coachA'), 'ordinary accounts keep one entry');
  } finally { await server.stop(); }
});

const demoDb = () => ({
  __meta: { storageRevision: 50, activeAccountId: 'demo-company:demo.coach', demoSeed: { tenantId: 'demo-company', version: 3 } },
  swimmers: [{ id: 's1', firstName: 'Ann', accountId: 'demo-company:demo.coach', ownerUsername: 'demo.coach', tenantId: 'demo-company', swimmerAccountUsername: 'marco', swimmerAccountEmail: 'm@example.invalid', accountLinkHistory: [{ by: 'demo.coach' }] }],
  trainingSessionSets: [{ id: 'set1', swimmerId: 's1', accountScope: 'demo.coach', tenantScope: 'demo-company', createdBy: 'demo.coach', notes: 'demo.coach wrote this', expectedAccountIds: ['demo-company:demo.coach', 'demo.coach'] }],
  athleteAccountInvites: [{ id: 'inv1', token: 'secret' }],
  documents: [],
});

test('owner copy: ownership moved to the configured owner, owner documents and own collections kept, links and invitations not copied', () => {
  const demo = demoDb(); const frozen = JSON.stringify(demo);
  const owner = { documents: [{ id: 'page' }], websiteNotes: [{ id: 'w' }], swimmers: [{ id: 'old' }], __meta: { storageRevision: 70 } };
  const out = buildOwnerWorkspace(demo, owner, { ownerUsername: 'Chief.Owner' });
  assert.equal(JSON.stringify(demo), frozen, 'demo input untouched');
  assert.deepEqual(out.swimmers.map((s) => s.id), ['s1']);
  assert.equal(out.swimmers[0].accountId, 'global-owner:chief.owner'); assert.equal(out.swimmers[0].ownerUsername, 'chief.owner'); assert.equal(out.swimmers[0].tenantId, 'global-owner');
  assert.equal(out.swimmers[0].swimmerAccountUsername, undefined); assert.equal(out.swimmers[0].swimmerAccountEmail, undefined); assert.equal(out.swimmers[0].accountLinkHistory, undefined);
  const set = out.trainingSessionSets[0];
  assert.deepEqual([set.accountScope, set.tenantScope, set.createdBy], ['chief.owner', 'global-owner', 'chief.owner']);
  assert.deepEqual(set.expectedAccountIds, ['global-owner:chief.owner', 'chief.owner']);
  assert.equal(set.notes, 'demo.coach wrote this', 'free text is never rewritten');
  assert.deepEqual(out.athleteAccountInvites, []);
  assert.deepEqual(out.documents, [{ id: 'page' }]); assert.deepEqual(out.websiteNotes, [{ id: 'w' }]);
  assert.equal(out.__meta.activeAccountId, 'global-owner:chief.owner'); assert.deepEqual(out.__meta.demoSeed, { tenantId: 'demo-company', version: 3 });
  assert.equal(out.__meta.storageRevision, 71); assert.equal(ownerWorkspaceCopyPending(out), false);
  assert.equal(primaryOwnerUsername({}), 'softwareowner'); assert.equal(primaryOwnerUsername({ AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME: ' Boss ' }), 'boss');
});

test('owner copy on storage: verified backup first, one write, never twice, Demo Coach only read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-owner-copy-')); const storage = path.join(root, 'storage'); const backup = path.join(root, 'backup');
  try {
    fs.mkdirSync(path.join(storage, 'tenants', 'demo-company'), { recursive: true });
    fs.writeFileSync(path.join(storage, 'tenants', 'demo-company', 'db.json'), JSON.stringify(demoDb()));
    const ownerOriginal = JSON.stringify({ documents: [{ id: 'page' }], swimmers: [{ id: 'old' }], __meta: { storageRevision: 3 } });
    fs.writeFileSync(path.join(storage, 'db.json'), ownerOriginal);
    const demoBefore = fs.readFileSync(path.join(storage, 'tenants', 'demo-company', 'db.json'));
    const r = copyDemoToOwnerWorkspace({ storageRoot: storage, backupRoot: backup, logger: { log() {} }, ownerUsername: 'softwareowner' });
    assert.equal(r.changed, true); assert.equal(fs.readFileSync(r.backupPath, 'utf8'), ownerOriginal);
    const owner = JSON.parse(fs.readFileSync(path.join(storage, 'db.json'), 'utf8'));
    assert.deepEqual(owner.swimmers.map((s) => s.id), ['s1']); assert.deepEqual(owner.documents, [{ id: 'page' }]);
    assert.ok(fs.readFileSync(path.join(storage, 'tenants', 'demo-company', 'db.json')).equals(demoBefore));
    // The owner edits; a later start never copies again.
    fs.writeFileSync(path.join(storage, 'db.json'), JSON.stringify({ ...owner, swimmers: [...owner.swimmers, { id: 'owner-new' }] }));
    assert.equal(copyDemoToOwnerWorkspace({ storageRoot: storage, backupRoot: backup, logger: { log() {} } }).reason, 'already-copied');
    assert.equal(JSON.parse(fs.readFileSync(path.join(storage, 'db.json'), 'utf8')).swimmers.length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
