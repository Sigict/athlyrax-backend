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
  const tempRoot = mkTempDir('athlyrax-athlete-invites-');
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

// ATHLYRAX_ATHLETE_ACCOUNT_INVITES_V1
const BIG = { trainingSessions: [{ id: 'ts-1', scheduleId: 'sch-1', date: '2026-11-20' }], schedule: [{ id: 'sch-1', scheduleDate: '2026-11-20', squadIds: ['sq-a'], mainFocus: 'Planned session' }],
  trainingSessionSets: [{ id: 'set-1', trainingSessionId: 'ts-1', reps: 3, distance: 100, sendOff: '1:40', resultsBySwimmer: { amelia: { reps: [{ overallTime: '1:12.40' }] } } }],
  attendance: [{ id: 'att-1', scheduleId: 'sch-1', swimmerId: 'amelia', status: 'present' }],
  tests: [{ id: 'test-1', swimmerId: 'amelia', time: '1:02.30' }, { id: 'test-o', swimmerId: 'other', time: '59.90' }],
  coachObservations: [{ id: 'obs-1', swimmerId: 'amelia', note: 'turns' }], swimmerAnalyses: [{ id: 'an-1', swimmerId: 'amelia', summary: 'x' }] };
const seedInvites = (paths) => {
  writeJson(path.join(paths.storageRoot, 'tenants', 'tenant-a', 'db.json'), {
    squads: [{ id: 'sq-a', name: 'Squad A' }],
    swimmers: [
      { id: 'amelia', firstName: 'Amelia', lastName: 'Test', squadId: 'sq-a', dob: '2000-02-01', integratedProfile: { overall: 71 } },
      { id: 'kid', firstName: 'Kit', lastName: 'Young', squadId: 'sq-a', dob: '2014-05-01' },
      { id: 'other', firstName: 'Olive', lastName: 'Other', squadId: 'sq-b', dob: '1999-01-01', email: 'amelia.athlete@example.com' },
    ],
    ...BIG,
  });
};
const tenantDb = (server) => JSON.parse(fs.readFileSync(path.join(server.tempRoot, 'storage', 'tenants', 'tenant-a', 'db.json'), 'utf8'));
const META = new Set(['createdByUserId', 'createdAt', 'updatedByUserId', 'updatedAt', 'tenantId', 'attributionStatus']);
const noMeta = (v) => (Array.isArray(v) ? v.map(noMeta) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !META.has(k)).map(([k, x]) => [k, noMeta(x)])) : v);
const protect = (db) => JSON.stringify(noMeta({ s: db.trainingSessions, ss: db.trainingSessionSets, a: db.attendance, t: db.tests, o: db.coachObservations, an: db.swimmerAnalyses, p: db.swimmers.find((r) => r.id === 'amelia').integratedProfile }));
const post = (base, route, body, auth = {}) => request(base, route, { ...auth, method: 'POST', body });
const signup = (base, token, u, extra = {}) => post(base, '/athlete-invites/accept', { token, username: u, password: 'Athlete!Pass1234', fullName: `${u} name`, email: `${u}@example.com`, ...extra });

test('Athlete App invitations link a login to the existing swimmer record, securely', async () => {
  const server = await startServer({}, seedInvites);
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const assistant = await login(base, 'assistA', 'AssistA!Pass1234');
    const coachB = await login(base, 'coachB', 'CoachB!Pass1234');
    const before = tenantDb(server);
    // Who may invite: coaches of the club only.
    assert.equal((await post(base, '/coach/swimmers/amelia/athlete-invites', {}, assistant)).response.status, 403);
    assert.equal((await post(base, '/coach/swimmers/amelia/athlete-invites', {}, coachB)).response.status, 404, 'another club cannot see this swimmer');
    const inv = await post(base, '/coach/swimmers/amelia/athlete-invites', {}, coach);
    assert.equal(inv.response.status, 201, JSON.stringify(inv.payload));
    const token = inv.payload.athleteToken;
    assert.match(token, /^AXA1\.tenant-a\.ai_[a-f0-9]+\./);
    assert.equal(inv.payload.invite.guardianRequired, false);
    assert.ok(!JSON.stringify(tenantDb(server)).includes(token.split('.')[3]), 'the secret is never stored');
    // Tampering: another club, another invite id, another secret, a guardian prefix.
    const [, , id, sec] = token.split('.');
    for (const bad of [`AXA1.tenant-b.${id}.${sec}`, `AXA1.tenant-a.ai_${'0'.repeat(24)}.${sec}`, `AXA1.tenant-a.${id}.${'A'.repeat(43)}`, `AXG1.tenant-a.${id}.${sec}`, 'garbage']) {
      assert.equal((await signup(base, bad, 'mallory')).response.status, 404, bad);
    }
    assert.equal((await request(base, `/athlete-invites/preview?token=${encodeURIComponent(token)}`)).payload.status, 'pending');
    // Accept with a new login; a supplied swimmerId is ignored.
    const acc = await signup(base, token, 'amelia.athlete', { swimmerId: 'other' });
    assert.equal(acc.response.status, 201, JSON.stringify(acc.payload));
    let db = tenantDb(server);
    assert.equal(db.swimmers.length, 3, 'no swimmer created');
    assert.equal(db.swimmers.find((r) => r.id === 'amelia').swimmerAccountUsername, 'amelia.athlete');
    assert.equal(db.swimmers.find((r) => r.id === 'other').swimmerAccountUsername, undefined);
    assert.equal(protect(db), protect(before), 'sessions, attendance, tests, observations, analyses and profile unchanged');
    // Single use.
    assert.equal((await signup(base, token, 'second.person')).response.status, 409);
    // The athlete signs in: own record only, no extra swimmer row.
    const athlete = await login(base, 'amelia.athlete', 'Athlete!Pass1234');
    const home = await request(base, '/swimmer/athlete-home', athlete);
    assert.equal(home.response.status, 200, JSON.stringify(home.payload));
    assert.equal(home.payload.athlete.id, 'amelia');
    assert.deepEqual(home.payload.sessions.map((s) => [s.id, s.sets.map((x) => [x.reps, x.distance, x.sendoff])]), [['ts-1', [[3, 100, '1:40']]]]);
    assert.deepEqual(home.payload.clubConnections.map((c) => [c.clubId, c.status]), [['tenant-a', 'active']], 'the Athlete App shows her club');
    assert.equal(home.payload.sessions[0].ownerClubId, 'tenant-a', 'club sessions belong to the club context');
    const own = await request(base, '/db', athlete);
    assert.deepEqual((own.payload.swimmers || []).map((r) => r.id), ['amelia'], 'only her own swimmer record');
    assert.ok(!JSON.stringify(own.payload).includes('59.90'), 'no other swimmer results');
    assert.equal(tenantDb(server).swimmers.length, 3, 'signing in created no swimmer');
    // A signed-in repeat of her own accepted invitation is harmless.
    assert.equal((await post(base, '/athlete-invites/accept', { token }, athlete)).payload.already, true);
    // A whole-club save cannot remove or forge links, nor revive invitations.
    const full = (await request(base, '/db', coach)).payload;
    full.swimmers = full.swimmers.map((r) => (r.id === 'amelia' ? { ...r, swimmerAccountUsername: undefined, swimmerAccountEmail: undefined } : r.id === 'other' ? { ...r, swimmerAccountUsername: 'amelia.athlete' } : r));
    full.athleteAccountInvites = [];
    assert.equal((await request(base, '/db', { ...coach, method: 'PUT', body: full })).response.status, 200);
    db = tenantDb(server);
    assert.equal(db.swimmers.find((r) => r.id === 'amelia').swimmerAccountUsername, 'amelia.athlete');
    assert.equal(db.swimmers.find((r) => r.id === 'other').swimmerAccountUsername, undefined);
    assert.equal(db.athleteAccountInvites.length, 1);
    // Already linked: no second account without a correction.
    assert.equal((await post(base, '/coach/swimmers/amelia/athlete-invites', {}, coach)).response.status, 409);
    // Correction: head coach only, with a reason; history stays, the old login loses access.
    assert.equal((await post(base, '/coach/swimmers/amelia/athlete-link/correct', { reason: 'wrong person' }, assistant)).response.status, 403);
    assert.equal((await post(base, '/coach/swimmers/amelia/athlete-link/correct', { reason: '' }, coach)).response.status, 400);
    const fix = await post(base, '/coach/swimmers/amelia/athlete-link/correct', { reason: 'Account belonged to a parent' }, coach);
    assert.equal(fix.response.status, 200, JSON.stringify(fix.payload));
    db = tenantDb(server);
    const ameliaRow = db.swimmers.find((r) => r.id === 'amelia');
    assert.equal(ameliaRow.swimmerAccountUsername, undefined);
    assert.deepEqual(ameliaRow.accountLinkHistory.map((h) => h.action), ['linked', 'unlinked']);
    assert.equal(protect(db), protect(before), 'correction keeps all training history');
    assert.equal((await request(base, '/swimmer/athlete-home', athlete)).response.status, 401, 'old session revoked');
    const relog = await login(base, 'amelia.athlete', 'Athlete!Pass1234');
    assert.notEqual((await request(base, '/swimmer/athlete-home', relog)).response.status, 200);
    assert.equal(tenantDb(server).swimmers.length, 3, 'no swimmer row created for the unlinked login');
    // Recovery: a new invitation, accepted by the correct login.
    const inv2 = await post(base, '/coach/swimmers/amelia/athlete-invites', {}, coach);
    assert.equal((await signup(base, inv2.payload.athleteToken, 'amelia.real')).response.status, 201);
    assert.equal(tenantDb(server).swimmers.find((r) => r.id === 'amelia').swimmerAccountUsername, 'amelia.real');
    // Under 18: a parent/guardian must authorise first.
    const kid = await post(base, '/coach/swimmers/kid/athlete-invites', { guardianEmail: 'parent@example.com' }, coach);
    assert.equal(kid.payload.invite.guardianRequired, true);
    assert.equal((await signup(base, kid.payload.athleteToken, 'kit.young')).response.status, 403);
    assert.equal((await post(base, '/athlete-invites/guardian-consent', { token: kid.payload.athleteToken, consent: true }, {})).response.status, 404, 'athlete link cannot consent');
    assert.equal((await post(base, '/athlete-invites/guardian-consent', { token: kid.payload.guardianToken, name: 'P', relationship: 'Mother', email: 'someone@example.com', consent: true, consentVersion: 'athlete-app-guardian-consent-v1' }, {})).response.status, 403, 'wrong guardian email');
    assert.equal((await post(base, '/athlete-invites/guardian-consent', { token: kid.payload.guardianToken, name: 'Pat Young', relationship: 'Mother', email: 'parent@example.com', consent: true, consentVersion: 'athlete-app-guardian-consent-v1' }, {})).response.status, 200);
    assert.equal((await signup(base, kid.payload.athleteToken, 'kit.young')).response.status, 201);
    // Revoked and expired invitations.
    const oth = await post(base, '/coach/swimmers/other/athlete-invites', {}, coach);
    assert.equal((await post(base, `/coach/athlete-invites/${oth.payload.invite.id}/revoke`, {}, coach)).response.status, 200);
    assert.equal((await signup(base, oth.payload.athleteToken, 'olive.one')).response.status, 410);
    const oth2 = await post(base, '/coach/swimmers/other/athlete-invites', {}, coach);
    const raw = tenantDb(server);
    raw.athleteAccountInvites = raw.athleteAccountInvites.map((i) => (i.id === oth2.payload.invite.id ? { ...i, expiresAt: '2020-01-01T00:00:00.000Z' } : i));
    writeJson(path.join(server.tempRoot, 'storage', 'tenants', 'tenant-a', 'db.json'), raw);
    assert.equal((await signup(base, oth2.payload.athleteToken, 'olive.two')).response.status, 410);
    // Status list for the coach shows states, never secrets.
    const listRes = await request(base, '/coach/swimmers/amelia/athlete-invites', coach);
    assert.deepEqual(listRes.payload.invites.map((i) => i.status), ['accepted', 'accepted']);
    assert.ok(!JSON.stringify(listRes.payload).includes('tokenHash'));
    assert.equal(tenantDb(server).swimmers.length, 3, 'still exactly three swimmers');
  } finally {
    await server.stop();
  }
});
