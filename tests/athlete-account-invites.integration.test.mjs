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
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; let v; while (!(v = fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); assert.ok(v, 'timed out waiting'); return v; };
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
    assert.equal((await post(base, '/athlete-invites/preview', { token }, {})).payload.status, 'pending');
    assert.equal((await request(base, `/athlete-invites/preview?token=${encodeURIComponent(token)}`)).response.status, 404, 'no token in URLs');
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
    // Under 18: a parent/guardian email is required, and the guardian must confirm a code emailed there.
    assert.equal((await post(base, '/coach/swimmers/kid/athlete-invites', {}, coach)).response.status, 400, 'guardian email required');
    const kid = await post(base, '/coach/swimmers/kid/athlete-invites', { guardianEmail: 'parent@example.com' }, coach);
    assert.equal(kid.payload.invite.guardianRequired, true);
    assert.equal((await signup(base, kid.payload.athleteToken, 'kit.young')).response.status, 403);
    const consent = (extra) => post(base, '/athlete-invites/guardian-consent', { token: kid.payload.guardianToken, name: 'Pat Young', relationship: 'Mother', consent: true, consentVersion: 'athlete-app-guardian-consent-v2', ...extra }, {});
    assert.equal((await post(base, '/athlete-invites/guardian-consent', { token: kid.payload.athleteToken, consent: true }, {})).response.status, 404, 'athlete link cannot consent');
    assert.equal((await consent({})).response.status, 403, 'no consent without a verification code');
    const sent = await post(base, '/athlete-invites/guardian-code', { token: kid.payload.guardianToken }, {});
    assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));
    assert.equal(sent.payload.sentTo, 'p*****@example.com');
    assert.equal((await post(base, '/athlete-invites/guardian-code', { token: kid.payload.guardianToken }, {})).response.status, 429, 'resend throttled');
    const code = await waitFor(() => (server.outbox().match(/"to":"parent@example\.com"[^\n]*?Your verification code is: (\d{6})/) || [])[1]);
    assert.ok(!server.output().includes(code), 'the code is not in application logs');
    assert.ok(!server.output().includes(kid.payload.guardianToken.split('.')[3]) && !server.output().includes(token.split('.')[3]), 'no secrets in application logs');
    const stored = tenantDb(server).athleteAccountInvites.find((i) => i.id === kid.payload.invite.id).guardianCode;
    assert.equal(stored.alg, 'hmac-sha256');
    assert.notEqual(stored.hash, crypto.createHash('sha256').update(`${kid.payload.invite.id}:${code}`).digest('hex'), 'not a plain SHA-256 of the code');
    assert.match(code, /^\d{6}$/);
    assert.ok(!JSON.stringify(tenantDb(server)).includes(code), 'the code itself is never stored');
    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal((await consent({ code: wrong })).response.status, 403, 'wrong code refused');
    assert.equal(tenantDb(server).athleteAccountInvites.find((i) => i.id === kid.payload.invite.id).guardianCode.attempts, 1, 'failed attempts are counted');
    assert.equal((await consent({ code, consent: false })).response.status, 400);
    assert.equal((await consent({ code })).response.status, 200);
    const recorded = tenantDb(server).athleteAccountInvites.find((i) => i.id === kid.payload.invite.id).guardianConsent;
    assert.deepEqual([recorded.email, recorded.verifiedBy, recorded.name], ['parent@example.com', 'email-code', 'Pat Young']);
    assert.equal((await signup(base, kid.payload.athleteToken, 'kit.young')).response.status, 201);
    await waitFor(() => /"to":"parent@example\.com","subject":"AthlyraX: Athlete App account linked"/.test(server.outbox()));
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

// ATHLYRAX_ATHLETE_INVITE_ATOMIC: a failed account save never leaves a linked swimmer behind.
test('if the login account cannot be saved, the swimmer link is undone and the invitation stays usable', async () => {
  const server = await startServer({ ATHLYRAX_TEST_FAIL_ATHLETE_AUTH_PERSIST: '1' }, seedInvites);
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const inv = await post(base, '/coach/swimmers/amelia/athlete-invites', {}, coach);
    const acc = await signup(base, inv.payload.athleteToken, 'amelia.athlete');
    assert.equal(acc.response.status, 503, JSON.stringify(acc.payload));
    const db = tenantDb(server);
    const row = db.swimmers.find((r) => r.id === 'amelia');
    assert.equal(row.swimmerAccountUsername, undefined, 'no link left behind');
    assert.deepEqual(row.accountLinkHistory.map((h) => h.action), ['linked', 'reverted']);
    assert.equal(db.swimmers.length, 3, 'no swimmer created');
    assert.equal(db.athleteAccountInvites[0].acceptedAt, '', 'invitation usable again');
    const loginTry = await request(base, '/auth/login', { method: 'POST', body: { username: 'amelia.athlete', password: 'Athlete!Pass1234' } });
    assert.equal(loginTry.response.status, 401, 'no half-created account');
    assert.equal((await post(base, '/athlete-invites/preview', { token: inv.payload.athleteToken }, {})).payload.status, 'pending');
  } finally { await server.stop(); }
});

test('if even the undo fails, the orphaned link is reverted automatically on the next club access', async () => {
  const server = await startServer({ ATHLYRAX_TEST_FAIL_ATHLETE_AUTH_PERSIST: '1', ATHLYRAX_TEST_FAIL_ATHLETE_LINK_COMPENSATION: '1' }, seedInvites);
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const inv = await post(base, '/coach/swimmers/amelia/athlete-invites', {}, coach);
    assert.equal((await signup(base, inv.payload.athleteToken, 'amelia.athlete')).response.status, 503);
    assert.equal(tenantDb(server).swimmers.find((r) => r.id === 'amelia').swimmerAccountUsername, 'amelia.athlete', 'undo failed: the link is still there');
    // The next club access (coach opens the swimmer's Athlete App status) recovers it.
    const status = await request(base, '/coach/swimmers/amelia/athlete-invites', coach);
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.linkedUsername, '');
    const row = tenantDb(server).swimmers.find((r) => r.id === 'amelia');
    assert.equal(row.swimmerAccountUsername, undefined);
    assert.equal(row.accountLinkHistory.at(-1).action, 'reverted');
    assert.match(row.accountLinkHistory.at(-1).reason, /login account missing/);
    assert.equal(status.payload.invites[0].status, 'pending', 'invitation usable again');
  } finally { await server.stop(); }
});

// ATHLYRAX_ATHLETE_LINK_REVOCATION: a correction succeeds only when the old account's access is durably
// revoked; it survives a restart and earlier sessions stay unusable.
const linkAmelia = async (base, coach) => {
  const inv = await post(base, '/coach/swimmers/amelia/athlete-invites', {}, coach);
  assert.equal((await signup(base, inv.payload.athleteToken, 'amelia.athlete')).response.status, 201);
  return login(base, 'amelia.athlete', 'Athlete!Pass1234');
};
test('correction: if revoking the old account cannot be saved, nothing changes; after a restart the retry revokes durably', async () => {
  let server = await startServer({ ATHLYRAX_TEST_FAIL_LINK_CORRECTION_AUTH_PERSIST: '1' }, seedInvites);
  try {
    let coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const oldSession = await linkAmelia(server.baseUrl, coach);
    const failed = await post(server.baseUrl, '/coach/swimmers/amelia/athlete-link/correct', { reason: 'Wrong person linked' }, coach);
    assert.equal(failed.response.status, 503, JSON.stringify(failed.payload));
    assert.match(failed.payload.error, /nothing was changed/);
    assert.equal(tenantDb(server).swimmers.find((r) => r.id === 'amelia').swimmerAccountUsername, 'amelia.athlete', 'link kept: no success reported');
    // Application restart (failure switch off): the stored state is the unchanged one; the retry works.
    server = await server.restart();
    coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const fixed = await post(server.baseUrl, '/coach/swimmers/amelia/athlete-link/correct', { reason: 'Wrong person linked' }, coach);
    assert.equal(fixed.response.status, 200, JSON.stringify(fixed.payload));
    assert.equal((await request(server.baseUrl, '/swimmer/athlete-home', oldSession)).response.status, 401, 'earlier session refused');
    // Another restart: the revocation was saved durably.
    server = await server.restart();
    assert.equal((await request(server.baseUrl, '/swimmer/athlete-home', oldSession)).response.status, 401, 'earlier session still refused after restart');
    assert.equal((await request(server.baseUrl, '/db', oldSession)).response.status, 401);
    const relog = await login(server.baseUrl, 'amelia.athlete', 'Athlete!Pass1234');
    assert.notEqual((await request(server.baseUrl, '/swimmer/athlete-home', relog)).response.status, 200, 'no club data for the revoked login');
    assert.equal((await request(server.baseUrl, '/db', relog)).response.status, 403, 'revoked login gets no club data');
    assert.equal(tenantDb(server).swimmers.length, 3, 'no swimmer created');
  } finally { await server.stop(); }
});

test('correction: if the link removal fails after revocation, access is already gone and the link is removed automatically', async () => {
  let server = await startServer({ ATHLYRAX_TEST_FAIL_LINK_CORRECTION_DB_WRITE: '1' }, seedInvites);
  try {
    let coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const oldSession = await linkAmelia(server.baseUrl, coach);
    const partial = await post(server.baseUrl, '/coach/swimmers/amelia/athlete-link/correct', { reason: 'Wrong person linked' }, coach);
    assert.equal(partial.response.status, 503);
    assert.equal(partial.payload.accessRevoked, true);
    assert.equal(tenantDb(server).swimmers.find((r) => r.id === 'amelia').swimmerAccountUsername, 'amelia.athlete', 'link not yet removed');
    assert.equal((await request(server.baseUrl, '/swimmer/athlete-home', oldSession)).response.status, 401);
    server = await server.restart();
    const relog = await login(server.baseUrl, 'amelia.athlete', 'Athlete!Pass1234');
    assert.notEqual((await request(server.baseUrl, '/swimmer/athlete-home', relog)).response.status, 200, 'revoked even though the link is still there');
    assert.equal((await request(server.baseUrl, '/db', relog)).response.status, 403, 'revoked login gets no club data');
    coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const status = await request(server.baseUrl, '/coach/swimmers/amelia/athlete-invites', coach);
    assert.equal(status.payload.linkedUsername, '', 'link removed by the recovery step');
    assert.equal(tenantDb(server).swimmers.find((r) => r.id === 'amelia').accountLinkHistory.at(-1).action, 'reverted');
  } finally { await server.stop(); }
});

// Concurrency: simultaneous requests cannot create duplicate identities or claim a swimmer twice.
test('simultaneous acceptances and registrations: one account, one link', async () => {
  const server = await startServer({}, seedInvites);
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const inv = await post(base, '/coach/swimmers/amelia/athlete-invites', {}, coach);
    // Ten different people race for one invitation.
    const race = await Promise.all(Array.from({ length: 10 }, (_, i) => signup(base, inv.payload.athleteToken, `racer${i}`)));
    const winners = race.filter((r) => r.response.status === 201);
    assert.equal(winners.length, 1, JSON.stringify(race.map((r) => r.response.status)));
    assert.ok(race.filter((r) => r.response.status !== 201).every((r) => r.response.status === 409));
    const db = tenantDb(server);
    assert.equal(db.swimmers.length, 3);
    const linkedTo = db.swimmers.find((r) => r.id === 'amelia').swimmerAccountUsername;
    let accounts = 0;
    for (let i = 0; i < 10; i += 1) { const r = await request(base, '/auth/login', { method: 'POST', body: { username: `racer${i}`, password: 'Athlete!Pass1234' } }); if (r.response.status === 200) { accounts += 1; assert.equal(`racer${i}`, linkedTo); } }
    assert.equal(accounts, 1, 'losers left no account behind');
    // Two invitations for two different swimmers raced with the same username, then with the same email.
    const raw = tenantDb(server);
    raw.swimmers.push({ id: 'dora', firstName: 'Dora', lastName: 'Adult', squadId: 'sq-a', dob: '1998-03-03' }, { id: 'eli', firstName: 'Eli', lastName: 'Adult', squadId: 'sq-a', dob: '1997-04-04' }, { id: 'fay', firstName: 'Fay', lastName: 'Adult', squadId: 'sq-a', dob: '1996-05-05' });
    writeJson(path.join(server.paths.storageRoot, 'tenants', 'tenant-a', 'db.json'), raw);
    const tok = async (id) => (await post(base, `/coach/swimmers/${id}/athlete-invites`, {}, coach)).payload.athleteToken;
    const [tOther, tDora] = [await tok('other'), await tok('dora')];
    const sameName = await Promise.all([signup(base, tOther, 'samename', { email: 'one@example.com' }), signup(base, tDora, 'samename', { email: 'two@example.com' })]);
    assert.deepEqual(sameName.map((r) => r.response.status).sort(), [201, 409], 'one username, one account');
    const [tEli, tFay] = [await tok('eli'), await tok('fay')];
    const sameEmail = await Promise.all([signup(base, tEli, 'eli.one', { email: 'shared@example.com' }), signup(base, tFay, 'fay.one', { email: 'shared@example.com' })]);
    assert.deepEqual(sameEmail.map((r) => r.response.status).sort(), [201, 409], 'one email, one account');
    const after = tenantDb(server);
    assert.equal(after.swimmers.length, 6, 'no swimmer created');
    assert.equal(after.swimmers.filter((r) => r.swimmerAccountUsername === 'samename').length, 1);
    const linked = after.swimmers.filter((r) => r.swimmerAccountUsername).map((r) => r.swimmerAccountUsername);
    assert.equal(new Set(linked).size, linked.length, 'no account linked to two swimmers');
    assert.equal(linked.length, 3, 'amelia, one samename winner, one shared-email winner');
  } finally { await server.stop(); }
});

// ATHLYRAX_ATHLETE_REVOKED_WRITE_GUARD — security review finding (PR #143): a login removed by
// "Correct account link" re-signed in, used /swimmer/profile/sync to append a duplicate of the
// swimmer row with a client-chosen id, and the next whole-club save moved the real row's link to it.
const ATHLETE_ENDPOINTS = [
  ['GET', '/db'], ['GET', '/swimmer/athlete-home'],
  ['POST', '/swimmer/profile/sync', { swimmer: { id: 'amelia', name: 'Mallory' } }],
  ['POST', '/swimmer/profile/targets', { swimmer: { id: 'amelia' }, targetPreference: { mode: 'independent' } }],
  ['POST', '/swimmer/coach/disconnect', {}], ['POST', '/swimmer/coach/request', { coachEmail: 'x@example.com' }],
  ['POST', '/swimmer/athlete-sessions', { date: '2026-11-20', title: 'X', sets: [] }],
  ['POST', '/swimmer/athlete-sessions/ts-1/wearable-sync', {}],
  ['POST', '/swimmer/capability/compute', {}], ['POST', '/swimmer/capability/apply-event', {}],
  ['POST', '/swimmer/wearable-connections/terra/widget', {}],
];
const snapshotOf = (db) => JSON.stringify(noMeta({ s: db.trainingSessions, ss: db.trainingSessionSets, a: db.attendance, t: db.tests, o: db.coachObservations, an: db.swimmerAnalyses,
  amelia: (({ swimmerAccountUsername, swimmerAccountEmail, accountLinkedAt, accountLinkInviteId, accountLinkHistory, ...rest }) => rest)(db.swimmers.find((r) => r.id === 'amelia')) }));

test('security: a corrected (revoked) login cannot write, cannot duplicate the swimmer, cannot take the link back', async () => {
  let server = await startServer({}, seedInvites);
  try {
    let base = server.baseUrl;
    let coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const inv1 = await post(base, '/coach/swimmers/amelia/athlete-invites', {}, coach);
    assert.equal((await signup(base, inv1.payload.athleteToken, 'mallory')).response.status, 201);
    const before = snapshotOf(tenantDb(server));
    assert.equal((await post(base, '/coach/swimmers/amelia/athlete-link/correct', { reason: 'Wrong person linked' }, coach)).response.status, 200);
    const inv2 = await post(base, '/coach/swimmers/amelia/athlete-invites', {}, coach);
    assert.equal((await signup(base, inv2.payload.athleteToken, 'carol')).response.status, 201);
    // Logout/login and an application restart: the revocation holds.
    server = await server.restart(); base = server.baseUrl;
    coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const mallory = await login(base, 'mallory', 'Athlete!Pass1234');
    // The original exploit: profile sync with the swimmer's id.
    const exploit = await post(base, '/swimmer/profile/sync', { swimmer: { id: 'amelia', name: 'Mallory Override', dob: '1990-01-01' }, snapshots: [{ id: 'x' }], history: [{ id: 'h' }], pbRows: [] }, mallory);
    assert.equal(exploit.response.status, 403, `exploit must be refused: ${JSON.stringify(exploit.payload)}`);
    // Every protected endpoint refuses the revoked account.
    for (const [method, route, body] of ATHLETE_ENDPOINTS) {
      const r = await request(base, route, { ...mallory, method, ...(body !== undefined ? { body } : {}) });
      assert.equal(r.response.status, 403, `${method} ${route} -> ${r.response.status}`);
    }
    // A whole-club save afterwards cannot move the link; no duplicate swimmer exists.
    const full = (await request(base, '/db', coach)).payload;
    assert.equal((await request(base, '/db', { ...coach, method: 'PUT', body: full })).response.status, 200);
    const db = tenantDb(server);
    assert.equal(db.swimmers.filter((r) => r.id === 'amelia').length, 1, 'no duplicate swimmer id');
    assert.equal(db.swimmers.length, 3, 'no swimmer created');
    const amelia = db.swimmers.find((r) => r.id === 'amelia');
    assert.equal(amelia.swimmerAccountUsername, 'carol', 'the correctly linked athlete keeps the record');
    assert.deepEqual(amelia.accountLinkHistory.map((h) => h.action), ['linked', 'unlinked', 'linked'], 'link history intact');
    assert.equal(snapshotOf(db), before, 'swimmer measurements, history and profile unchanged');
    // The correctly linked athlete keeps access.
    const carol = await login(base, 'carol', 'Athlete!Pass1234');
    const home = await request(base, '/swimmer/athlete-home', carol);
    assert.equal(home.response.status, 200);
    assert.equal(home.payload.athlete.id, 'amelia');
    assert.deepEqual((await request(base, '/db', carol)).payload.swimmers.map((r) => r.id), ['amelia']);
  } finally { await server.stop(); }
});

test('security: invitation-managed accounts never create swimmer rows; client swimmer ids never decide identity', async () => {
  const server = await startServer({}, seedInvites);
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const inv = await post(base, '/coach/swimmers/amelia/athlete-invites', {}, coach);
    assert.equal((await signup(base, inv.payload.athleteToken, 'amelia.athlete')).response.status, 201);
    const athlete = await login(base, 'amelia.athlete', 'Athlete!Pass1234');
    // Her own record is updated (not a new one), whatever id the app sends.
    const r = await post(base, '/swimmer/profile/targets', { swimmer: { id: 'other' }, targetPreference: { mode: 'independent' } }, athlete);
    assert.equal(r.response.status, 200, JSON.stringify(r.payload));
    let db = tenantDb(server);
    assert.equal(db.swimmers.length, 3);
    assert.equal(db.swimmers.find((x) => x.id === 'other').swimmerAccountUsername, undefined, 'another swimmer untouched');
    // A coach whole-club save cannot introduce a duplicate swimmer id.
    const full = (await request(base, '/db', coach)).payload;
    full.swimmers.push({ ...full.swimmers.find((x) => x.id === 'amelia'), name: 'Copy' });
    const dup = await request(base, '/db', { ...coach, method: 'PUT', body: full });
    assert.equal(dup.response.status, 400, JSON.stringify(dup.payload));
    assert.match(dup.payload.error, /duplicate swimmer/i);
    db = tenantDb(server);
    assert.equal(db.swimmers.filter((x) => x.id === 'amelia').length, 1);
  } finally { await server.stop(); }
});

test('independent athletes still work, and new records always get a server-generated id', async () => {
  const server = await startServer({}, (paths) => {
    seedInvites(paths);
    const usersPath = path.join(paths.storageRoot, 'auth', 'auth-users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push({ username: 'indie', password: 'Indie!Pass1234', role: 'swimmer', tenantId: 'athlete-indie', createdVia: 'admin', isApproved: true, onboardingCompletedAt: new Date().toISOString() });
    writeJson(usersPath, users); writeJson(path.join(paths.storageRoot, 'auth', 'auth-users.backup.json'), users);
    writeJson(path.join(paths.storageRoot, 'tenants', 'athlete-indie', 'db.json'), { swimmers: [] });
  });
  const base = server.baseUrl;
  try {
    const indie = await login(base, 'indie', 'Indie!Pass1234');
    const sync = await post(base, '/swimmer/profile/sync', { swimmer: { id: 'amelia', name: 'Indie Athlete' }, snapshots: [], history: [], pbRows: [] }, indie);
    assert.equal(sync.response.status, 200, JSON.stringify(sync.payload));
    const own = JSON.parse(fs.readFileSync(path.join(server.paths.storageRoot, 'tenants', 'athlete-indie', 'db.json'), 'utf8'));
    assert.equal(own.swimmers.length, 1);
    assert.notEqual(own.swimmers[0].id, 'amelia', 'the client id is not used');
    assert.match(own.swimmers[0].id, /^swimmer-/);
    assert.equal(sync.payload.swimmerId, own.swimmers[0].id);
    // A second sync updates the same record.
    assert.equal((await post(base, '/swimmer/profile/sync', { swimmer: { name: 'Indie Athlete' }, snapshots: [], history: [], pbRows: [] }, indie)).response.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(server.paths.storageRoot, 'tenants', 'athlete-indie', 'db.json'), 'utf8')).swimmers.length, 1);
    // Personal sessions and the Athlete App still work.
    assert.equal((await post(base, '/swimmer/athlete-sessions', { date: '2026-11-20', title: 'My 6x100', disciplineId: 'swimming', sets: [{ reps: 6, distance: 100 }] }, indie)).response.status, 201);
    const home = await request(base, '/swimmer/athlete-home', indie);
    assert.equal(home.response.status, 200);
    assert.deepEqual(home.payload.sessions.map((s) => s.title), ['My 6x100']);
    // The club's data was not touched.
    assert.equal(tenantDb(server).swimmers.length, 3);
  } finally { await server.stop(); }
});

test('security: writes racing a link correction never survive it, never duplicate the swimmer, never keep the link', async () => {
  const server = await startServer({}, seedInvites);
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const inv = await post(base, '/coach/swimmers/amelia/athlete-invites', {}, coach);
    assert.equal((await signup(base, inv.payload.athleteToken, 'mallory')).response.status, 201);
    const mallory = await login(base, 'mallory', 'Athlete!Pass1234');
    const sync = (i) => post(base, '/swimmer/profile/sync', { swimmer: { id: `client-${i}`, name: 'Mallory Override' }, snapshots: [], history: [], pbRows: [] }, mallory);
    const results = await Promise.all([
      sync(0), sync(1), sync(2),
      post(base, '/coach/swimmers/amelia/athlete-link/correct', { reason: 'Wrong person linked' }, coach),
      sync(3), sync(4), sync(5),
    ]);
    assert.equal(results[3].response.status, 200, JSON.stringify(results[3].payload));
    for (const r of [...results.slice(0, 3), ...results.slice(4)]) assert.ok([200, 401, 403].includes(r.response.status), `unexpected ${r.response.status}`);
    const settled = tenantDb(server);
    assert.equal(settled.swimmers.length, 3, 'no swimmer created by any racing write');
    assert.equal(settled.swimmers.filter((r) => r.id === 'amelia').length, 1);
    assert.ok(!settled.swimmers.some((r) => String(r.id).startsWith('client-')), 'client ids never used');
    assert.equal(settled.swimmers.find((r) => r.id === 'amelia').swimmerAccountUsername || '', '', 'link removed');
    // After the correction, nothing from the old login gets through, before or after re-login.
    const after = snapshotOf(settled);
    assert.equal((await sync(6)).response.status, 401, 'earlier session refused');
    const relog = await login(base, 'mallory', 'Athlete!Pass1234');
    assert.equal((await post(base, '/swimmer/profile/sync', { swimmer: { id: 'amelia', name: 'Mallory Override' } }, relog)).response.status, 403);
    assert.equal(snapshotOf(tenantDb(server)), after, 'no write after the correction');
  } finally { await server.stop(); }
});

test('legacy data: stored duplicate swimmer ids are left exactly as saved; nothing new can be duplicated or linked to them', async () => {
  const legacy = [
    { id: 'legacy', firstName: 'Lee', lastName: 'One', squadId: 'sq-a', dob: '2001-03-03' },
    { id: 'legacy', firstName: 'Lee', lastName: 'Two', squadId: 'sq-a', dob: '2001-03-03' },
  ];
  const server = await startServer({}, (paths) => {
    seedInvites(paths);
    const file = path.join(paths.storageRoot, 'tenants', 'tenant-a', 'db.json');
    const db = JSON.parse(fs.readFileSync(file, 'utf8'));
    db.swimmers.push(...legacy);
    writeJson(file, db);
  });
  const base = server.baseUrl;
  try {
    const before = JSON.parse(fs.readFileSync(path.join(server.tempRoot, 'storage', 'tenants', 'tenant-a', 'db.json'), 'utf8'));
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    // An ordinary whole-club save of the data as loaded still works and changes no stored record.
    const full = (await request(base, '/db', coach)).payload;
    assert.equal((await request(base, '/db', { ...coach, method: 'PUT', body: full })).response.status, 200);
    let db = tenantDb(server);
    assert.deepEqual(noMeta(db.swimmers), noMeta(before.swimmers), 'swimmer rows unchanged');
    for (const k of Object.keys(BIG)) assert.deepEqual(noMeta(db[k]), noMeta(before[k]), `${k} unchanged`);
    // A third copy is refused before anything is written.
    full.swimmers.push({ ...legacy[0], lastName: 'Three' });
    const third = await request(base, '/db', { ...coach, method: 'PUT', body: full });
    assert.equal(third.response.status, 400);
    assert.deepEqual(third.payload.duplicateSwimmerIds, ['legacy']);
    assert.deepEqual(noMeta(tenantDb(server).swimmers), noMeta(before.swimmers));
    // An ambiguous record cannot be invited or linked.
    assert.equal((await post(base, '/coach/swimmers/legacy/athlete-invites', {}, coach)).response.status, 409);
    db = tenantDb(server);
    assert.equal((db.athleteAccountInvites || []).length, 0);
  } finally { await server.stop(); }
});
