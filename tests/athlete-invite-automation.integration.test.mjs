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

// ATHLYRAX_ATHLETE_INVITE_AUTOMATION_V1
const tenantDb = (server) => JSON.parse(fs.readFileSync(path.join(server.tempRoot, 'storage', 'tenants', 'tenant-a', 'db.json'), 'utf8'));
const post = (base, route, body, auth = {}) => request(base, route, { ...auth, method: 'POST', body });
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; let v; while (!(v = fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); assert.ok(v, 'timed out waiting'); return v; };
const mails = (server) => server.outbox().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const linkIn = (mail) => (String(mail?.text || '').match(/#token=([^\s]+)/) || [])[1] ? decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]) : '';
const seedSquad = (paths) => {
  writeJson(path.join(paths.storageRoot, 'tenants', 'tenant-a', 'db.json'), {
    squads: [{ id: 'sq-a', name: 'Squad A' }],
    swimmers: [
      { id: 'adult1', firstName: 'Ada', lastName: 'Long', squadId: 'sq-a', dob: '2000-02-01', email: 'ada@example.com' },
      { id: 'kid1', firstName: 'Kit', lastName: 'Young', squadId: 'sq-a', dob: '2014-05-01', parentEmail: 'kit.parent@example.com' },
      { id: 'kid2', firstName: 'Lou', lastName: 'Small', squadId: 'sq-a', dob: '2015-05-01' },
      { id: 'kid3', firstName: 'Mo', lastName: 'Nogu', squadId: 'sq-a', dob: '2013-05-01' },
      { id: 'adult2', firstName: 'Ben', lastName: 'Saved', squadId: 'sq-a', dob: '1998-02-01', athleteContacts: { athleteEmail: 'ben.old@example.com' } },
      { id: 'adult3', firstName: 'Fay', lastName: 'Fails', squadId: 'sq-a', dob: '1997-02-01' },
      { id: 'linked1', firstName: 'Lin', lastName: 'Ked', squadId: 'sq-a', dob: '1990-01-01', swimmerAccountUsername: 'lin.ked', swimmerAccountEmail: 'lin@example.com' },
    ],
    tests: [{ id: 't1', swimmerId: 'adult1', time: '1:01.00' }],
  });
};

test('bulk squad invitations: review, save with permission, send, guardian first, resend, delivery events', async () => {
  const server = await startServer({ BREVO_WEBHOOK_SECRET: 'whsec-test-0123456789abcdef', ATHLYRAX_TEST_FAIL_INVITE_EMAIL: '1' }, seedSquad);
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const assistant = await login(base, 'assistA', 'AssistA!Pass1234');
    const coachB = await login(base, 'coachB', 'CoachB!Pass1234');
    const before = tenantDb(server);
    assert.equal((await request(base, '/coach/athlete-invites/overview', assistant)).response.status, 403);
    // Overview: pre-filled contacts and states, club-scoped.
    const ov = await request(base, '/coach/athlete-invites/overview', coach);
    assert.equal(ov.response.status, 200, JSON.stringify(ov.payload));
    assert.equal(ov.payload.email.available, true);
    const row = (id) => ov.payload.swimmers.find((r) => r.swimmerId === id);
    assert.deepEqual([row('adult1').athleteEmail, row('adult1').athleteSource, row('adult1').state], ['ada@example.com', 'imported:email', 'not-invited']);
    assert.deepEqual([row('kid1').guardianEmail, row('kid1').guardianRequired], ['kit.parent@example.com', true]);
    assert.equal(row('linked1').state, 'linked');
    assert.ok(!(await request(base, '/coach/athlete-invites/overview', coachB)).payload.swimmers.some((r) => r.swimmerId === 'adult1'), 'other clubs see nothing');
    // Preview: real wording, no link.
    const pv = await post(base, '/coach/athlete-invites/email-preview', { swimmerId: 'kid1', kind: 'guardian' }, coach);
    assert.equal(pv.response.status, 200);
    assert.ok(pv.payload.text.includes('Kit Young') && pv.payload.text.includes('Club A') && pv.payload.text.includes('[secure invitation link]'));
    assert.equal((await post(base, '/coach/athlete-invites/email-preview', { swimmerId: 'swimmerB' }, coach)).response.status, 404);
    // Send to the whole squad.
    const items = [
      { swimmerId: 'adult1', athleteEmail: 'ada@example.com', saveAthleteEmail: true },
      { swimmerId: 'kid1', athleteEmail: 'kit@example.com', guardianEmail: 'kit.parent@example.com', saveAthleteEmail: true, saveGuardianEmail: true },
      { swimmerId: 'kid2', guardianEmail: 'lou.parent@example.com' },
      { swimmerId: 'kid3', athleteEmail: 'mo@example.com' },
      { swimmerId: 'adult2', athleteEmail: 'ben.new@example.com', saveAthleteEmail: true },
      { swimmerId: 'adult3', athleteEmail: 'fail@example.com' },
      { swimmerId: 'linked1', athleteEmail: 'lin@example.com' },
      { swimmerId: 'adult1', athleteEmail: 'ada@example.com' },
      { swimmerId: 'swimmerB', athleteEmail: 'b@example.com' },
    ];
    assert.equal((await post(base, '/coach/athlete-invites/bulk', { items }, coach)).response.status, 400, 'request id required');
    const [r1, r2] = await Promise.all([
      post(base, '/coach/athlete-invites/bulk', { requestId: 'req-aaaaaaaa', items }, coach),
      post(base, '/coach/athlete-invites/bulk', { requestId: 'req-bbbbbbbb', items }, coach),
    ]);
    const statuses = [r1.response.status, r2.response.status].sort();
    assert.ok(statuses[0] === 200 && [200, 409].includes(statuses[1]), `double send: ${statuses}`);
    const bulk = r1.response.status === 200 ? r1 : r2;
    const res = Object.fromEntries(bulk.payload.results.map((r) => [r.swimmerId + (r.code === 'duplicate-in-request' ? '#dup' : ''), r]));
    assert.equal(res.adult1.outcome, 'sent'); assert.equal(res.adult1.kind, 'athlete');
    assert.equal(res.kid1.outcome, 'sent'); assert.equal(res.kid1.kind, 'guardian');
    assert.equal(res.kid2.outcome, 'sent');
    assert.equal(res.kid3.code, 'missing-guardian-email');
    assert.equal(res.adult2.outcome, 'conflict', 'different saved address needs confirmation');
    assert.equal(res.adult3.outcome, 'failed');
    assert.equal(res.linked1.code, 'already-linked');
    assert.equal(res['adult1#dup'].code, 'duplicate-in-request');
    assert.equal(res.swimmerB.code, 'not-found', 'another club\'s swimmer is never invited');
    let db = tenantDb(server);
    const invitesFor = (id) => db.athleteAccountInvites.filter((i) => i.swimmerId === id);
    for (const id of ['adult1', 'kid1', 'kid2', 'adult3']) assert.equal(invitesFor(id).length, 1, `exactly one invitation for ${id} (double-click safe)`);
    assert.equal(invitesFor('adult2').length + invitesFor('kid3').length + invitesFor('linked1').length, 0);
    assert.equal(db.swimmers.length, before.swimmers.length, 'no swimmer created');
    assert.deepEqual(db.tests, before.tests, 'history untouched');
    assert.equal(db.swimmers.find((r) => r.id === 'adult1').athleteContacts.athleteEmail, 'ada@example.com');
    assert.equal(db.swimmers.find((r) => r.id === 'adult1').email, 'ada@example.com', 'imported field untouched');
    assert.deepEqual(db.swimmers.find((r) => r.id === 'kid1').athleteContacts && [db.swimmers.find((r) => r.id === 'kid1').athleteContacts.athleteEmail, db.swimmers.find((r) => r.id === 'kid1').athleteContacts.guardianEmail], ['kit@example.com', 'kit.parent@example.com']);
    assert.equal(db.swimmers.find((r) => r.id === 'kid2').athleteContacts, undefined, 'not saved without permission');
    assert.equal(db.swimmers.find((r) => r.id === 'adult2').athleteContacts.athleteEmail, 'ben.old@example.com', 'never overwritten silently');
    // Emails: adult gets the athlete link; under-18s get only the guardian link; Reply-To is the club.
    let m = mails(server);
    const to = (addr) => m.filter((x) => x.to === addr);
    assert.match(linkIn(to('ada@example.com')[0]), /^AXA1\.tenant-a\./);
    assert.match(linkIn(to('kit.parent@example.com')[0]), /^AXG1\.tenant-a\./);
    assert.equal(to('kit@example.com').length, 0, 'no athlete link before guardian consent');
    assert.ok(m.every((x) => !x.subject.includes('undefined')));
    // Replay of the same request: nothing new.
    const again = await post(base, '/coach/athlete-invites/bulk', { requestId: bulk === r1 ? 'req-aaaaaaaa' : 'req-bbbbbbbb', items }, coach);
    assert.equal(again.payload.replay, true);
    assert.equal(mails(server).length, m.length, 'no duplicate emails');
    // A new request for the same swimmers skips open invitations.
    const third = await post(base, '/coach/athlete-invites/bulk', { requestId: 'req-cccccccc', items: [{ swimmerId: 'adult1', athleteEmail: 'ada@example.com' }] }, coach);
    assert.equal(third.payload.results[0].code, 'already-invited');
    // Confirmed replacement of the saved address.
    const fix = await post(base, '/coach/athlete-invites/bulk', { requestId: 'req-dddddddd', items: [{ swimmerId: 'adult2', athleteEmail: 'ben.new@example.com', saveAthleteEmail: true, confirmReplaceAthleteEmail: true }] }, coach);
    assert.equal(fix.payload.results[0].outcome, 'sent');
    db = tenantDb(server);
    assert.deepEqual(db.swimmers.find((r) => r.id === 'adult2').athleteContacts.history.map((h) => [h.action, h.from, h.to]), [['replaced', 'ben.old@example.com', 'ben.new@example.com']]);
    // States.
    const ov2 = Object.fromEntries((await request(base, '/coach/athlete-invites/overview', coach)).payload.swimmers.map((r) => [r.swimmerId, r]));
    assert.deepEqual([ov2.adult1.state, ov2.kid1.state, ov2.adult3.state, ov2.kid3.state], ['invitation-sent', 'awaiting-guardian', 'delivery-failed', 'not-invited']);
    assert.equal(ov2.adult3.invite.lastDelivery.status, 'failed');
    // Failed delivery: correct the address and resend at once.
    const rs = await post(base, `/coach/athlete-invites/${ov2.adult3.invite.id}/resend`, { email: 'fay@example.com' }, coach);
    assert.equal(rs.response.status, 200, JSON.stringify(rs.payload));
    assert.equal(tenantDb(server).swimmers.find((r) => r.id === 'adult3').athleteContacts, undefined, 'corrected address not saved unless asked');
    assert.equal((await post(base, `/coach/athlete-invites/${ov2.adult3.invite.id}/resend`, {}, coach)).response.status, 429, 'resend throttled');
    // Resend rotates the link: the old adult link stops working.
    const adultOld = linkIn(to('ada@example.com')[0]);
    assert.equal((await post(base, `/coach/athlete-invites/${ov2.adult1.invite.id}/resend`, {}, coach)).response.status, 429, 'a just-sent invitation waits a minute');
    const aged = tenantDb(server);
    aged.athleteAccountInvites = aged.athleteAccountInvites.map((i) => ({ ...i, deliveries: (i.deliveries || []).map((d) => ({ ...d, at: '2026-01-01T00:00:00.000Z' })) }));
    writeJson(path.join(server.tempRoot, 'storage', 'tenants', 'tenant-a', 'db.json'), aged);
    const rsA = await post(base, `/coach/athlete-invites/${ov2.adult1.invite.id}/resend`, {}, coach);
    assert.equal(rsA.response.status, 200, JSON.stringify(rsA.payload));
    m = mails(server);
    const adultNew = linkIn(m.filter((x) => x.to === 'ada@example.com').pop());
    assert.notEqual(adultNew, adultOld);
    assert.equal((await post(base, '/athlete-invites/accept', { token: adultOld, username: 'ada.long', password: 'Athlete!Pass1234', fullName: 'Ada Long', email: 'ada@example.com' })).response.status, 404);
    assert.equal((await post(base, '/athlete-invites/accept', { token: adultNew, username: 'ada.long', password: 'Athlete!Pass1234', fullName: 'Ada Long', email: 'other@example.com' })).response.status, 403, 'email restriction kept');
    assert.equal((await post(base, '/athlete-invites/accept', { token: adultNew, username: 'ada.long', password: 'Athlete!Pass1234', fullName: 'Ada Long', email: 'ada@example.com' })).response.status, 201);
    // Guardian flow for Kit: code, consent, then the athlete link is emailed to Kit automatically.
    const gTok = linkIn(m.find((x) => x.to === 'kit.parent@example.com'));
    assert.equal((await post(base, '/athlete-invites/guardian-code', { token: gTok })).response.status, 200);
    const code = await waitFor(() => (mails(server).filter((x) => x.to === 'kit.parent@example.com').map((x) => (x.text.match(/verification code is: (\d{6})/) || [])[1]).filter(Boolean))[0]);
    const consent = await post(base, '/athlete-invites/guardian-consent', { token: gTok, name: 'Pat Young', relationship: 'Mother', consent: true, consentVersion: 'athlete-app-guardian-consent-v2', code });
    assert.equal(consent.response.status, 200, JSON.stringify(consent.payload));
    assert.equal(consent.payload.athleteInvitation, 'sent');
    const kitLink = linkIn(await waitFor(() => mails(server).find((x) => x.to === 'kit@example.com')));
    assert.match(kitLink, /^AXA1\.tenant-a\./);
    assert.equal((await post(base, '/athlete-invites/accept', { token: kitLink, username: 'kit.young', password: 'Athlete!Pass1234', fullName: 'Kit Young', email: 'kit@example.com' })).response.status, 201);
    // Lou: consent given but no athlete email yet; the coach adds one and the invitation goes out.
    const louTok = linkIn(mails(server).find((x) => x.to === 'lou.parent@example.com'));
    await post(base, '/athlete-invites/guardian-code', { token: louTok });
    const louCode = await waitFor(() => (mails(server).filter((x) => x.to === 'lou.parent@example.com').map((x) => (x.text.match(/verification code is: (\d{6})/) || [])[1]).filter(Boolean))[0]);
    const louConsent = await post(base, '/athlete-invites/guardian-consent', { token: louTok, name: 'Sam Small', relationship: 'Father', consent: true, consentVersion: 'athlete-app-guardian-consent-v2', code: louCode });
    assert.equal(louConsent.payload.athleteInvitation, 'athlete-email-needed');
    const ov3 = Object.fromEntries((await request(base, '/coach/athlete-invites/overview', coach)).payload.swimmers.map((r) => [r.swimmerId, r]));
    assert.equal(ov3.kid2.state, 'awaiting-athlete-email');
    assert.equal(ov3.kid1.state, 'linked');
    assert.equal(ov3.adult1.state, 'linked');
    assert.equal((await post(base, `/coach/athlete-invites/${ov3.kid2.invite.id}/resend`, { email: 'lou.parent@example.com' }, coach)).response.status, 400, 'athlete email must differ from guardian');
    const louSend = await post(base, `/coach/athlete-invites/${ov3.kid2.invite.id}/resend`, { email: 'lou@example.com', save: true }, coach);
    assert.equal(louSend.response.status, 200, JSON.stringify(louSend.payload));
    assert.equal(tenantDb(server).swimmers.find((r) => r.id === 'kid2').athleteContacts.athleteEmail, 'lou@example.com');
    assert.match(linkIn(mails(server).find((x) => x.to === 'lou@example.com')), /^AXA1\./);
    // Delivery events (Brevo webhook): secret required; bounces show as failed delivery.
    db = tenantDb(server);
    const louInv = db.athleteAccountInvites.find((i) => i.swimmerId === 'kid2');
    const last = louInv.deliveries[louInv.deliveries.length - 1];
    const ev = { event: 'hard_bounce', 'message-id': last.messageId, 'X-Mailin-custom': `axi:tenant-a:${louInv.id}`, date: '2026-11-08 12:00:00', reason: 'mailbox unavailable' };
    assert.equal((await post(base, '/webhooks/brevo/athlete-invites', ev)).response.status, 404);
    assert.equal((await post(base, '/webhooks/brevo/athlete-invites?key=wrong-key-0123456789abcd', ev)).response.status, 404);
    assert.equal((await post(base, '/webhooks/brevo/athlete-invites?key=whsec-test-0123456789abcdef', { ...ev, 'X-Mailin-custom': `axi:tenant-b:${louInv.id}` })).payload.applied, 0, 'cannot reach another club');
    assert.equal((await post(base, '/webhooks/brevo/athlete-invites?key=whsec-test-0123456789abcdef', ev)).payload.applied, 1);
    const ov4 = Object.fromEntries((await request(base, '/coach/athlete-invites/overview', coach)).payload.swimmers.map((r) => [r.swimmerId, r]));
    assert.deepEqual([ov4.kid2.state, ov4.kid2.invite.lastDelivery.status], ['delivery-failed', 'bounced']);
    // Revoke still works for automatic invitations.
    assert.equal((await post(base, `/coach/athlete-invites/${ov4.adult3.invite.id}/revoke`, {}, coach)).response.status, 200);
    assert.equal(Object.fromEntries((await request(base, '/coach/athlete-invites/overview', coach)).payload.swimmers.map((r) => [r.swimmerId, r.state])).adult3, 'revoked');
    // Whole-club save cannot change saved contacts.
    const full = (await request(base, '/db', coach)).payload;
    full.swimmers = full.swimmers.map((r) => (r.id === 'kid2' ? { ...r, athleteContacts: { athleteEmail: 'evil@example.com' } } : r));
    assert.equal((await request(base, '/db', { ...coach, method: 'PUT', body: full })).response.status, 200);
    assert.equal(tenantDb(server).swimmers.find((r) => r.id === 'kid2').athleteContacts.athleteEmail, 'lou@example.com');
    // No links, secrets or codes in application logs or in what the coach receives.
    const allLinks = mails(server).map(linkIn).filter(Boolean);
    for (const l of allLinks) assert.ok(!server.output().includes(l.split('.')[3]), 'no secret in logs');
    assert.ok(!/verification code is/.test(server.output()));
    assert.ok(!JSON.stringify(bulk.payload).includes('AXA1') && !JSON.stringify(bulk.payload).includes('AXG1'), 'links never returned to the coach');
    assert.ok(!JSON.stringify(ov4).includes('tokenHash'));
  } finally {
    await server.stop();
  }
});

// ATHLYRAX_GUARDIAN_MANAGED_ACCOUNTS_V1
test('guardian-managed login for an athlete without email: verified consent, separate credentials, guardian recovery and revocation', async () => {
  const server = await startServer({ AUTH_LOGIN_RATE_MAX_ATTEMPTS: '200', AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS: '400' }, seedSquad);
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const bulk = await post(base, '/coach/athlete-invites/bulk', { requestId: 'req-managed1', items: [
      { swimmerId: 'kid2', guardianEmail: 'lou.parent@example.com' },
      { swimmerId: 'kid1', athleteEmail: 'kit@example.com', guardianEmail: 'kit.parent@example.com' },
    ] }, coach);
    assert.equal(bulk.response.status, 200, JSON.stringify(bulk.payload));
    const gLink = (addr) => linkIn(mails(server).find((x) => x.to === addr));
    const louTok = gLink('lou.parent@example.com'); const kitTok = gLink('kit.parent@example.com');
    const make = (token, u = 'lou.small', extra = {}, auth = {}) => post(base, '/athlete-invites/guardian-managed-account', { token, username: u, password: 'Athlete!Pass1234', fullName: 'Lou Small', ...extra }, auth);
    assert.equal((await make(louTok)).response.status, 403, 'no login before verified consent');
    const consentWith = async (token, addr, name) => {
      assert.equal((await post(base, '/athlete-invites/guardian-code', { token })).response.status, 200);
      const code = await waitFor(() => (mails(server).filter((x) => x.to === addr).map((x) => (x.text.match(/verification code is: (\d{6})/) || [])[1]).filter(Boolean))[0]);
      assert.equal((await post(base, '/athlete-invites/guardian-consent', { token, name, relationship: 'Parent', consent: true, consentVersion: 'athlete-app-guardian-consent-v2', code })).response.status, 200);
    };
    await consentWith(louTok, 'lou.parent@example.com', 'Sam Small');
    await consentWith(kitTok, 'kit.parent@example.com', 'Pat Young');
    assert.equal((await make(kitTok, 'kit.managed')).response.status, 409, 'athlete with own email accepts their own invitation');
    const athleteTok = linkIn(mails(server).find((x) => x.to === 'kit@example.com'));
    assert.equal((await make(athleteTok)).response.status, 404, 'an athlete link cannot create a managed login');
    // A parent/guardian who is signed in (e.g. to their coaching account) is no longer turned away: the
    // request reaches the normal checks, and the child's login is always a separate new account.
    assert.equal((await make(louTok, 'lou.small', { password: 'short' }, coach)).response.status, 400, 'signed-in guardian reaches validation');
    assert.equal((await make(louTok, 'lou.small', { password: 'short' })).response.status, 400);
    const created = await make(louTok);
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    assert.equal((await make(louTok, 'lou.other')).response.status, 409, 'single use');
    let db = tenantDb(server);
    const row = db.swimmers.find((r) => r.id === 'kid2');
    assert.deepEqual([row.swimmerAccountUsername, row.swimmerAccountEmail], ['lou.small', '']);
    assert.equal(db.swimmers.length, 7, 'no swimmer created');
    const users = JSON.parse(fs.readFileSync(server.paths.authUsersPath, 'utf8'));
    const u = users.find((x) => x.username === 'lou.small');
    assert.equal(u.email, ''); assert.equal(u.managedBy.guardianEmail, 'lou.parent@example.com'); assert.equal(u.managedBy.consentAt.length > 0, true);
    assert.ok(!JSON.stringify(u).includes('Athlete!Pass1234'), 'password stored only as a hash');
    // Separate credentials: the athlete signs in with their own username and sees only their record.
    const lou = await login(base, 'lou.small', 'Athlete!Pass1234');
    const home = await request(base, '/swimmer/athlete-home', lou);
    assert.equal(home.response.status, 200, JSON.stringify(home.payload));
    assert.equal(home.payload.athlete.id, 'kid2');
    assert.equal(tenantDb(server).swimmers.length, 7, 'signing in created no swimmer');
    assert.ok(mails(server).some((x) => x.to === 'lou.parent@example.com' && /login created/.test(x.subject)));
    // Recovery: the reset code goes to the guardian, never to logs.
    assert.equal((await post(base, '/auth/password-reset/request', { identifier: 'lou.small' })).response.status, 200);
    const reset = await waitFor(() => (mails(server).filter((x) => x.to === 'lou.parent@example.com').map((x) => (x.text.match(/reset code is: (\w+)/) || [])[1]).filter(Boolean))[0]);
    assert.ok(!server.output().includes(reset), 'reset code not logged');
    assert.equal((await post(base, '/auth/password-reset/confirm', { username: 'lou.small', code: reset, password: 'NewAthlete!Pass1234' })).response.status, 200);
    const lou2 = await login(base, 'lou.small', 'NewAthlete!Pass1234');
    // Guardian revocation: a fresh code is required; then access ends and the link is removed.
    assert.equal((await post(base, '/athlete-invites/guardian-revoke', { token: louTok, code: '000000' })).response.status, 403, 'code first');
    const mc = await post(base, '/athlete-invites/guardian-manage-code', { token: louTok });
    assert.equal(mc.response.status, 200, JSON.stringify(mc.payload));
    const mcode = await waitFor(() => (mails(server).filter((x) => x.to === 'lou.parent@example.com').map((x) => (x.text.match(/manage the Athlete App login "lou.small".* is: (\d{6})/) || [])[1]).filter(Boolean))[0]);
    assert.equal((await post(base, '/athlete-invites/guardian-revoke', { token: louTok, code: mcode === '000000' ? '111111' : '000000' })).response.status, 403, 'wrong code');
    const rv = await post(base, '/athlete-invites/guardian-revoke', { token: louTok, code: mcode });
    assert.equal(rv.response.status, 200, JSON.stringify(rv.payload));
    assert.equal(rv.payload.linkRemoved, true);
    assert.equal((await request(base, '/swimmer/athlete-home', lou2)).response.status, 401, 'session ended');
    db = tenantDb(server);
    const after = db.swimmers.find((r) => r.id === 'kid2');
    assert.equal(after.swimmerAccountUsername, undefined);
    assert.deepEqual(after.accountLinkHistory.map((h) => h.action), ['linked', 'unlinked']);
    assert.equal((await post(base, '/athlete-invites/guardian-revoke', { token: louTok, code: mcode })).response.status, 409, 'already removed');
    assert.ok(!/verification code is|reset code is|is: \d{6}/.test(server.output()), 'no codes in logs');
  } finally {
    await server.stop();
  }
});

test('staged rollout: only clubs listed in ATHLETE_INVITE_EMAIL_TENANTS send automatic invitation emails', async () => {
  const sender = { ATHLETE_INVITE_FROM: 'AthlyraX <invites@example.com>' };
  // Club A is not listed: no automatic email, nothing created by the bulk route; link invitations still work.
  const off = await startServer({ ...sender, ATHLETE_INVITE_EMAIL_TENANTS: 'tenant-z' }, seedSquad);
  try {
    const coach = await login(off.baseUrl, 'coachA', 'CoachA!Pass1234');
    const ov = await request(off.baseUrl, '/coach/athlete-invites/overview', coach);
    assert.equal(ov.payload.email.available, false);
    const bulk = await post(off.baseUrl, '/coach/athlete-invites/bulk', { requestId: 'stagedOff0001', items: [{ swimmerId: 'adult1', athleteEmail: 'ada@example.com' }] }, coach);
    assert.equal(bulk.response.status, 503);
    assert.equal((tenantDb(off).athleteAccountInvites || []).length, 0, 'nothing created');
    const link = await post(off.baseUrl, '/coach/swimmers/adult1/athlete-invites', { email: 'ada@example.com' }, coach);
    assert.equal(link.response.status, 201, JSON.stringify(link.payload));
    assert.ok(link.payload.athleteToken, 'link-based invitation unchanged');
  } finally { await off.stop(); }
  // Club A listed: automatic email available.
  const on = await startServer({ ...sender, ATHLETE_INVITE_EMAIL_TENANTS: 'tenant-a' }, seedSquad);
  try {
    const coach = await login(on.baseUrl, 'coachA', 'CoachA!Pass1234');
    assert.equal((await request(on.baseUrl, '/coach/athlete-invites/overview', coach)).payload.email.available, true);
    const bulk = await post(on.baseUrl, '/coach/athlete-invites/bulk', { requestId: 'stagedOn00001', items: [{ swimmerId: 'adult1', athleteEmail: 'ada@example.com' }] }, coach);
    assert.equal(bulk.response.status, 200, JSON.stringify(bulk.payload));
    assert.equal(bulk.payload.results[0].outcome, 'sent');
  } finally { await on.stop(); }
});

test('Send Again on a link-only invitation emails the guardian from the swimmer record; consent, athlete link, one linked record', async () => {
  const seed = (paths) => writeJson(path.join(paths.storageRoot, 'tenants', 'tenant-a', 'db.json'), {
    squads: [{ id: 'sq-a', name: 'Squad A' }],
    swimmers: [{ id: 'amelia', firstName: 'Amelia', lastName: 'Foster', squadId: 'sq-a', dob: '2012-05-01', parent1Name: 'Tom Foster', parent2Name: 'Jane Foster', primaryContact: 'Parent 2', primaryContactEmail: 'jane.foster@example.com', swimmerEmail: 'amelia.f@example.com' }],
    tests: [{ id: 't-am', swimmerId: 'amelia', time: '1:05.00' }],
  });
  const server = await startServer({ AUTH_LOGIN_RATE_MAX_ATTEMPTS: '200', AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS: '400' }, seed);
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const ov = await request(base, '/coach/athlete-invites/overview', coach);
    const r = ov.payload.swimmers.find((x) => x.swimmerId === 'amelia');
    assert.deepEqual([r.athleteEmail, r.athleteSource, r.guardianEmail, r.guardianSource, r.guardianName, r.guardianRelationship], ['amelia.f@example.com', 'profile', 'jane.foster@example.com', 'profile', 'Jane Foster', 'Parent 2 / Mother']);
    // An older invitation shared as a link.
    const link = await post(base, '/coach/swimmers/amelia/athlete-invites', { guardianEmail: 'jane.foster@example.com' }, coach);
    assert.equal(link.response.status, 201);
    const sent = await post(base, `/coach/athlete-invites/${link.payload.invite.id}/resend`, {}, coach);
    assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));
    assert.equal(sent.payload.kind, 'guardian');
    assert.equal(sent.payload.superseded, link.payload.invite.id);
    const invites = tenantDb(server).athleteAccountInvites;
    assert.equal(invites.length, 2, 'history kept');
    assert.equal(invites.find((i) => i.id === link.payload.invite.id).supersededBy, sent.payload.inviteId);
    const st = await request(base, '/coach/swimmers/amelia/athlete-invites', coach);
    assert.deepEqual(st.payload.invites.map((i) => [i.status, i.delivery]).sort(), [['awaiting-guardian', 'email'], ['revoked', 'link']]);
    // Old guardian link refused; the emailed one works.
    assert.notEqual((await post(base, '/athlete-invites/guardian-code', { token: link.payload.guardianToken })).response.status, 200);
    const gTok = linkIn(await waitFor(() => mails(server).find((x) => x.to === 'jane.foster@example.com')));
    assert.equal((await post(base, '/athlete-invites/guardian-code', { token: gTok })).response.status, 200);
    const code = await waitFor(() => (mails(server).filter((x) => x.to === 'jane.foster@example.com').map((x) => (x.text.match(/verification code is: (\d{6})/) || [])[1]).filter(Boolean))[0]);
    const parentPreview = await post(base, '/athlete-invites/preview', { token: gTok });
    assert.equal(parentPreview.response.status, 200);
    assert.equal(parentPreview.payload.guardianHasLogin, false);
    const consentResult = await post(base, '/athlete-invites/guardian-consent', {
      token: gTok, name: 'Jane Foster', relationship: 'Parent',
      consent: true, consentVersion: 'athlete-app-guardian-consent-v2', code,
      createGuardianLogin: true, guardianPassword: 'Guardian!Pass1234',
    });
    assert.equal(consentResult.response.status, 200, JSON.stringify(consentResult.payload));
    assert.equal(consentResult.payload.guardianLogin, 'created');
    assert.equal(consentResult.payload.athleteInvitation, 'sent', 'parent sees truthful activation-email confirmation');
    const parentLogin = await login(base, 'jane.foster@example.com', 'Guardian!Pass1234');
    const children = await request(base, '/guardian/children', parentLogin);
    assert.equal(children.response.status, 200, JSON.stringify(children.payload));
    assert.deepEqual(children.payload.children.map((c) => c.swimmerFirstName), ['Amelia']);
    // The athlete link goes to the Swimmer Email automatically.
    const aTok = linkIn(await waitFor(() => mails(server).find((x) => x.to === 'amelia.f@example.com')));
    // Parent-approved emailed invitation: swimmer only chooses a password.
    // Client-supplied identity is not trusted or required.
    const activated = await post(base, '/athlete-invites/accept', { token: aTok, activationOnly: true, password: 'Athlete!Pass1234', fullName: 'Wrong Name', email: 'impostor@example.com', username: 'attacker' });
    assert.equal(activated.response.status, 201, JSON.stringify(activated.payload));
    const db = tenantDb(server);
    assert.equal(db.swimmers.length, 1, 'no duplicate swimmer');
    assert.match(db.swimmers[0].swimmerAccountUsername, /^amelia.f-[a-f0-9]{8}$/);
    const createdLogin = db.swimmers[0].swimmerAccountUsername;
    const loginResult = await login(base, 'amelia.f@example.com', 'Athlete!Pass1234');
    assert.ok(loginResult.cookie, 'swimmer has an independent login with the verified email');
    assert.equal((await post(base, '/athlete-invites/accept', { token: aTok, activationOnly: true, password: 'Athlete!Pass1234' })).response.status, 409, 'cannot reuse the activation link');
    assert.equal(tenantDb(server).swimmers[0].swimmerAccountUsername, createdLogin, 'replay does not reassign existing swimmer');
    assert.deepEqual(db.tests.map((t) => [t.id, t.swimmerId, t.time]), [['t-am', 'amelia', '1:05.00']]);
    assert.equal(db.swimmers[0].primaryContactEmail, 'jane.foster@example.com');
  } finally { await server.stop(); }
});

test('a guardian who already consented can securely set their password later without another swimmer', async () => {
  const server = await startServer({ AUTH_LOGIN_RATE_MAX_ATTEMPTS: '200', AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS: '400' }, seedSquad);
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const invite = await post(base, '/coach/athlete-invites/bulk', {
      requestId: 'late-parent-login-001',
      items: [{ swimmerId: 'kid1', athleteEmail: 'kit@example.com', guardianEmail: 'kit.parent@example.com' }]
    }, coach);
    assert.equal(invite.response.status, 200, JSON.stringify(invite.payload));
    const gTok = linkIn(await waitFor(() => mails(server).find((x) => x.to === 'kit.parent@example.com')));
    assert.equal((await post(base, '/athlete-invites/guardian-code', { token: gTok })).response.status, 200);
    const firstCode = await waitFor(() => (mails(server).filter((m) => m.to === 'kit.parent@example.com')
      .map((m) => (m.text.match(/verification code is: (\d{6})/) || [])[1]).filter(Boolean))[0]);
    const consent = await post(base, '/athlete-invites/guardian-consent', {
      token: gTok, name: 'Kit Parent', relationship: 'Father', code: firstCode,
      consent: true, consentVersion: 'athlete-app-guardian-consent-v2'
    });
    assert.equal(consent.response.status, 200, JSON.stringify(consent.payload));
    assert.equal(consent.payload.athleteInvitation, 'sent');
    const before = tenantDb(server);
    const consentAt = before.athleteAccountInvites.at(-1).guardianConsent.at;
    assert.equal((await post(base, '/athlete-invites/preview', { token: gTok })).payload.guardianHasLogin, false);
    const sent = await post(base, '/athlete-invites/guardian-account-code', { token: gTok });
    assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));
    const secondCode = await waitFor(() => (mails(server).filter((m) => m.to === 'kit.parent@example.com')
      .map((m) => (m.text.match(/Parent \/ Guardian login is: (\d{6})/) || [])[1]).filter(Boolean))[0]);
    const wrong = await post(base, '/athlete-invites/guardian-account-activate', {
      token: gTok, code: secondCode === '000000' ? '111111' : '000000', password: 'Parent!Pass1234'
    });
    assert.equal(wrong.response.status, 403);
    const activated = await post(base, '/athlete-invites/guardian-account-activate', { token: gTok, code: secondCode, password: 'Parent!Pass1234' });
    assert.equal(activated.response.status, 201, JSON.stringify(activated.payload));
    const parent = await login(base, 'kit.parent@example.com', 'Parent!Pass1234');
    assert.equal((await request(base, '/guardian/children', parent)).response.status, 200);
    assert.equal((await post(base, '/athlete-invites/guardian-account-code', { token: gTok })).response.status, 409, 'cannot duplicate parent login');
    const after = tenantDb(server);
    assert.equal(after.swimmers.length, before.swimmers.length);
    assert.equal(after.athleteAccountInvites.at(-1).guardianConsent.at, consentAt, 'original consent evidence preserved');
    assert.deepEqual(after.tests, before.tests, 'training results untouched');
    assert.equal(mails(server).filter((m) => m.to === 'kit@example.com').length, 1, 'swimmer not invited twice');
  } finally { await server.stop(); }
});
