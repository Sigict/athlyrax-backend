import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { acceptDemoActivity, buildDemoActivityReport, createActiveTimeBudget, verifiedGeoFrom, appendDemoActivity, readDemoActivity, pruneDemoActivity, sessionRefOf, eraseBrowserFromDemoActivity } from '../demo-activity.mjs';
import { buildDemoStatsReport, classifySession, createDemoStatsCollector, pruneDemoStats, testMarkerValid } from '../demo-stats.mjs';

// Demo visitor activity (23-11-2026): sessions, optional returning-browser IDs, sections, estimated active time,
// signed approximate location; owner-only report; audit addresses and retention.
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
  const tempRoot = reuse?.tempRoot || mkTempDir('athlyrax-demo-activity-');
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




const SECRET = 'test-geo-shared-secret-with-at-least-32-chars';
const signGeo = (geo, secret = SECRET) => { const p = Buffer.from(JSON.stringify(geo)).toString('base64url'); return { 'x-athlyrax-geo': p, 'x-athlyrax-geo-sig': crypto.createHmac('sha256', secret).update(p).digest('hex') }; };
const B1 = '1b4e28ba-2fa1-4d3b-9a5e-0c3f6d1e2a4b'; const B2 = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const jar = (response) => (response.headers.getSetCookie ? response.headers.getSetCookie() : []).map((r) => String(r).split(';')[0].trim()).filter((p) => !p.endsWith('=')).join('; ');
const csrfOf = (cookie, name = 'athlyrax_csrf') => decodeURIComponent((cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)) || [])[1] || '');
async function signIn(baseUrl, username, password, extra = {}) {
  const r = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ username, password }) });
  assert.equal(r.status, 200, username); const cookie = jar(r);
  return { cookie, csrf: csrfOf(cookie, extra['X-AthlyraX-App'] ? 'athlyrax_athlete_csrf' : 'athlyrax_csrf'), extra };
}
const send = (baseUrl, s, body, headers = {}) => fetch(`${baseUrl}/demo-activity`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: s.cookie, 'x-csrf-token': s.csrf, ...s.extra, ...headers }, body: JSON.stringify(body) });
const now = () => Date.now();

test('unit: sections allow-listed per app, browser ID only with consent, active time never above elapsed time + 60 s, no unknown fields', () => {
  const budget = createActiveTimeBudget(60); const t = Date.now();
  const r = acceptDemoActivity({ account: 'demo.coach', csrf: 'c1', now: t, activeBudget: budget, body: { consent: 'granted', browserId: B1, events: [
    { type: 'enter', section: 'training-planner', at: t }, { type: 'active', section: 'training-planner', seconds: 45, at: t }, { type: 'active', section: 'training-planner', seconds: 45, at: t },
    { type: 'enter', section: 'home', at: t }, { type: 'enter', section: 'not-a-section', at: t }, { type: 'click', section: 'calendar', at: t, text: 'secret' } ] } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.records.map((x) => [x.kind, x.section, x.seconds || 0]), [['enter', 'training-planner', 0], ['active', 'training-planner', 45], ['active', 'training-planner', 15]]);
  assert.ok(r.records.every((x) => x.browser === B1 && x.session === sessionRefOf('c1') && !('text' in x)));
  // Later, genuine time is not clipped: after 2 minutes the same session may add up to 120 s more, never more.
  const later = acceptDemoActivity({ account: 'demo.coach', csrf: 'c1', now: t + 120000, activeBudget: budget, body: { events: [
    { type: 'active', section: 'training-planner', seconds: 60, at: t + 120000 }, { type: 'active', section: 'training-planner', seconds: 60, at: t + 120000 }, { type: 'active', section: 'training-planner', seconds: 60, at: t + 120000 } ] } });
  assert.deepEqual(later.records.map((x) => x.seconds), [60, 60]);
  const declined = acceptDemoActivity({ account: 'marco', csrf: 'c2', now: t, body: { consent: 'declined', browserId: B1, events: [{ type: 'enter', section: 'home', at: t }] } });
  assert.equal(declined.records[0].browser, null, 'no browser link without consent');
  assert.equal(acceptDemoActivity({ account: 'coachA', csrf: 'x', body: { events: [] } }).ok, false);
  assert.equal(acceptDemoActivity({ account: 'marco', csrf: 'x', body: { events: Array(21).fill({ type: 'enter', section: 'home' }) } }).ok, false);
  assert.equal(acceptDemoActivity({ account: 'marco', csrf: 'x', body: { consent: 'granted', browserId: 'not-a-uuid', events: [{ type: 'enter', section: 'home' }] } }).records[0].browser, null);
});

test('unit: location only with a valid, fresh signature; forged, unsigned or stale is Unknown', () => {
  const geo = { cc: 'GB', c: 'United Kingdom', r: 'Scotland', ci: 'Aberdeen', t: Date.now() };
  assert.deepEqual(verifiedGeoFrom(signGeo(geo), SECRET), { countryCode: 'GB', country: 'United Kingdom', region: 'Scotland', city: 'Aberdeen' });
  assert.equal(verifiedGeoFrom(signGeo(geo, 'another-secret-another-secret-another!!'), SECRET), null, 'wrong key');
  assert.equal(verifiedGeoFrom({ 'x-athlyrax-geo': signGeo(geo)['x-athlyrax-geo'] }, SECRET), null, 'unsigned');
  assert.equal(verifiedGeoFrom(signGeo({ ...geo, t: Date.now() - 10 * 60000 }), SECRET), null, 'stale');
  assert.equal(verifiedGeoFrom(signGeo(geo), ''), null, 'no secret configured');
  const accented = { cc: 'CH', c: 'Switzerland', r: 'Zürich', ci: 'Zürich', t: Date.now() };
  assert.deepEqual(verifiedGeoFrom(signGeo(accented), SECRET), { countryCode: 'CH', country: 'Switzerland', region: 'Zürich', city: 'Zürich' });
});

test('unit: report keeps sessions, linked browsers, returning browsers, connected and estimated active time apart; withdrawal unlinks; incomplete sessions flagged', () => {
  const t0 = Date.parse('2026-11-23T10:00:00Z'); const iso = (m) => new Date(t0 + m * 60000).toISOString();
  const rec = (session, browser, kind, section, m, seconds, geo) => ({ v: 1, at: iso(m), kind, account: 'demo.coach', session, browser, section, ...(seconds ? { seconds } : {}), ...(geo ? { geo } : {}) });
  const g = { countryCode: 'IE', country: 'Ireland', region: 'Leinster', city: 'Dublin' };
  const records = [
    rec('s1', B1, 'enter', 'overview', 0), rec('s1', B1, 'active', 'overview', 1, 60, g), rec('s1', B1, 'enter', 'reports-home', 2), rec('s1', B1, 'active', 'reports-home', 3, 30), rec('s1', B1, 'end', 'reports-home', 4),
    rec('s2', B1, 'enter', 'calendar', 600), rec('s2', B1, 'active', 'calendar', 601, 40), rec('s2', B1, 'end', 'calendar', 602),
    rec('s3', null, 'enter', 'analysis-isp', 30), rec('s3', null, 'active', 'analysis-isp', 31, 20),
    rec('s4', B2, 'enter', 'overview', 40), { v: 1, at: iso(50), kind: 'withdrawn', account: 'demo.coach', session: 's4', browser: B2 },
  ];
  const r = buildDemoActivityReport(records, { logins: 5, now: t0 + 700 * 60000 });
  assert.deepEqual(r.measures, { successfulLogins: 5, sessions: 4, linkedBrowsers: 1, returningBrowsers: 1, unlinkedSessions: 2, connectedSeconds: 4 * 60 + 2 * 60 + 60 + 0, estimatedActiveSeconds: 150 });
  const a = r.visitors.find((v) => v.visitor === 'Visitor A');
  assert.equal(a.sessions, 2); assert.equal(a.returning, true); assert.equal(a.location, 'Dublin, Leinster, Ireland');
  assert.deepEqual(a.sectionsViewed, ['overview', 'reports-home', 'calendar']); assert.equal(a.estimatedActiveSeconds, 130);
  const s1 = a.sessionDetails.find((s) => s.session === 's1');
  assert.deepEqual(s1.sections.map((x) => [x.section, x.estimatedActiveSeconds]), [['overview', 60], ['reports-home', 30]]);
  const unlinked = r.visitors.filter((v) => !v.browserLinked);
  assert.equal(unlinked.length, 2); assert.ok(unlinked.every((v) => v.visitor === 'Unlinked session' && v.returning === false));
  assert.ok(unlinked.find((v) => v.sessionDetails[0].session === 's3').sessionDetails[0].incomplete, 'no close observed and quiet for > 30 min');
  assert.equal(unlinked.find((v) => v.sessionDetails[0].session === 's3').location, 'Unknown');
  assert.equal(JSON.stringify(r).includes(B1) || JSON.stringify(r).includes(B2), false, 'browser IDs are never sent to the report');
  // A section opened twice: each visit keeps its own active time (never the section total twice).
  const again = buildDemoActivityReport([rec('s9', null, 'enter', 'analysis-isp', 0), rec('s9', null, 'active', 'analysis-isp', 0.5, 13), rec('s9', null, 'enter', 'calendar', 1),
    rec('s9', null, 'active', 'calendar', 1.5, 5), rec('s9', null, 'enter', 'analysis-isp', 2), rec('s9', null, 'active', 'analysis-isp', 2.5, 7)], { now: t0 + 3 * 60000 });
  assert.deepEqual(again.visitors[0].sessionDetails[0].sections.map((x) => [x.section, x.estimatedActiveSeconds]), [['analysis-isp', 13], ['calendar', 5], ['analysis-isp', 7]]);
});

test('unit: 90-day retention deletes old day files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-demo-ret-'));
  try {
    const t = Date.parse('2026-11-23T12:00:00Z');
    appendDemoActivity(root, [{ v: 1, at: '2026-08-01T10:00:00.000Z', kind: 'enter', account: 'marco', session: 'old', browser: null, section: 'home' }], { now: Date.parse('2026-08-01T12:00:00Z') });
    appendDemoActivity(root, [{ v: 1, at: '2026-11-23T10:00:00.000Z', kind: 'enter', account: 'marco', session: 'new', browser: null, section: 'home' }], { now: t });
    assert.deepEqual(readDemoActivity(root, { now: t }).map((r) => r.session), ['new']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'demo-activity')), ['2026-11-23.jsonl'], 'the old day file is gone');
    assert.equal(pruneDemoActivity(root, { now: t }), 0);
    appendDemoActivity(root, [{ v: 1, at: '2026-11-23T11:00:00.000Z', kind: 'enter', account: 'marco', session: 'w', browser: B2, section: 'home' }], { now: t });
    assert.equal(eraseBrowserFromDemoActivity(root, B2), 1);
    assert.equal(fs.readFileSync(path.join(root, 'demo-activity', '2026-11-23.jsonl'), 'utf8').includes(B2), false);
    assert.equal(readDemoActivity(root, { now: t }).length, 2, 'the visit itself is kept, unlinked');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('server: aggregate statistics — three classes, verified test marker, no identifiers, objection, owner-only report', async () => {
  const MARKER = 'marker-secret-for-tests-with-at-least-32-chars';
  const server = await startServer({ DEMO_GEO_SHARED_SECRET: SECRET, DEMO_TEST_MARKER_SECRET: MARKER });
  try {
    const { baseUrl, paths } = server;
    const geo = () => signGeo({ cc: 'GB', c: 'United Kingdom', r: 'Scotland', ci: 'Aberdeen', t: now() });
    // human-likely: interaction, no automation signal, no marker
    const human = await signIn(baseUrl, 'demo.coach', 'DemoCoach123!');
    let r = await send(baseUrl, human, { events: [{ type: 'enter', section: 'calendar', at: now() }, { type: 'active', section: 'calendar', seconds: 50, at: now() }] }, geo());
    assert.equal(r.status, 200); assert.equal((await r.json()).locationVerified, true);
    await send(baseUrl, human, { events: [{ type: 'end', section: 'calendar', at: now() }] });
    // verified test: the session is marked with the server-held secret
    const tester = await signIn(baseUrl, 'demo.coach', 'DemoCoach123!');
    const mark = (s, value) => fetch(`${baseUrl}/demo-activity/test-session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: s.cookie, 'x-csrf-token': s.csrf, ...s.extra, ...(value ? { 'x-athlyrax-test-marker': value } : {}) }, body: '{}' });
    assert.equal((await mark(tester, MARKER)).status, 200);
    await send(baseUrl, tester, { automation: true, events: [{ type: 'enter', section: 'reports-home', at: now() }, { type: 'active', section: 'reports-home', seconds: 30, at: now() }, { type: 'end', section: 'reports-home', at: now() }] });
    // forged markers: wrong value, missing header, client-side claims -> never verified
    const forger = await signIn(baseUrl, 'demo.coach', 'DemoCoach123!');
    assert.equal((await mark(forger, 'wrong-marker-value-wrong-marker-value-123')).status, 403);
    assert.equal((await mark(forger)).status, 403);
    await send(baseUrl, forger, { verifiedTest: true, testMarker: MARKER, events: [{ type: 'enter', section: 'overview', at: now() }, { type: 'active', section: 'overview', seconds: 20, at: now() }, { type: 'end', section: 'overview', at: now() }] }, { 'x-athlyrax-test-marker': MARKER });
    // unclassified: automation signal without a marker; Marco with no interaction
    const bot = await signIn(baseUrl, 'demo.coach', 'DemoCoach123!');
    await send(baseUrl, bot, { automation: true, events: [{ type: 'enter', section: 'calendar', at: now() }, { type: 'active', section: 'calendar', seconds: 40, at: now() }, { type: 'end', section: 'calendar', at: now() }] });
    const marco = await signIn(baseUrl, 'marco', 'Marco!Pass12345', { 'X-AthlyraX-App': 'athlete' });
    await send(baseUrl, marco, { events: [{ type: 'enter', section: 'timetable', at: now() }, { type: 'end', section: 'timetable', at: now() }] });
    // objection: the open session is discarded
    const objector = await signIn(baseUrl, 'demo.coach', 'DemoCoach123!');
    await send(baseUrl, objector, { events: [{ type: 'enter', section: 'squads', at: now() }, { type: 'active', section: 'squads', seconds: 30, at: now() }] });
    assert.equal((await (await send(baseUrl, objector, { optOut: true, events: [] })).json()).discarded, true);
    // ordinary accounts and anonymous visitors are never counted; marker refused for them
    const coach = await signIn(baseUrl, 'coachA', 'CoachA!Pass1234');
    assert.equal((await send(baseUrl, coach, { events: [{ type: 'enter', section: 'overview' }] })).status, 403);
    assert.equal((await mark(coach, MARKER)).status, 403);
    assert.equal((await fetch(`${baseUrl}/demo-activity`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"events":[]}' })).status, 401);
    // owner-only report
    for (const s of [coach, human, marco]) assert.equal((await fetch(`${baseUrl}/owner/demo-activity`, { headers: { Cookie: s.cookie, ...s.extra } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/owner/demo-activity`)).status, 401);
    const owner = await signIn(baseUrl, 'softwareowner', 'Owner!Pass1234');
    const report = await (await fetch(`${baseUrl}/owner/demo-activity?days=7`, { headers: { Cookie: owner.cookie } })).json();
    const c = report.classes;
    assert.equal(c.human_likely.sessions, 2, 'the human-like session and the forged-marker session (forging changes nothing)');
    assert.equal(c.verified_test.sessions, 1);
    assert.equal(c.unclassified.sessions, 2, 'automation without marker; Marco without interaction');
    assert.equal(c.human_likely.byAccount.coach.sessions, 2); assert.equal(c.unclassified.byAccount.athlete.sessions, 1);
    assert.equal(c.human_likely.activeSeconds, 70); assert.equal(c.verified_test.activeSeconds, 30);
    assert.deepEqual(c.human_likely.sections.map((x) => `${x.app}:${x.section}:${x.seconds}`), ['coach:calendar:50', 'coach:overview:20']);
    assert.deepEqual(c.human_likely.geography, [{ countryCode: 'GB', country: 'United Kingdom', region: 'Scotland', sessions: 1 }]);
    assert.deepEqual(c.human_likely.cities, [], 'a city shared by fewer than 5 sessions is not shown');
    assert.equal(c.human_likely.unknownLocationSessions, 1);
    assert.equal(c.human_likely.daily.length, 1); assert.equal(c.human_likely.weekly.length, 1);
    assert.equal(report.securityLog.successfulDemoSignIns, 6, 'sign-ins are reported apart from engagement');
    assert.equal(report.openSessionsNotYetCounted, 0);
    const text = JSON.stringify(report);
    for (const leak of [human.csrf, human.cookie.split('=')[1], MARKER, '127.0.0.1', '::1', 'browserId']) assert.equal(text.includes(leak), false, `report leaks ${leak}`);
    // storage: aggregates only (no session reference, no IP, no identifiers), no new per-session files
    const dir = path.join(paths.storageRoot, 'demo-stats');
    const stored = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    for (const leak of [human.csrf, sessionRefOf(human.csrf), '127.0.0.1', MARKER]) assert.equal(stored.includes(leak), false);
    assert.equal(fs.existsSync(path.join(paths.storageRoot, 'demo-activity')), false, 'per-session records are no longer written');
    // marker without server configuration is refused
  } finally { await server.stop(); }
  const plain = await startServer({});
  try {
    const s = await signIn(plain.baseUrl, 'demo.coach', 'DemoCoach123!');
    const r = await fetch(`${plain.baseUrl}/demo-activity/test-session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: s.cookie, 'x-csrf-token': s.csrf, 'x-athlyrax-test-marker': 'anything-anything-anything-anything' }, body: '{}' });
    assert.equal(r.status, 503);
  } finally { await plain.stop(); }
});

test('unit: aggregate collector — idle sessions are counted after 30 minutes, shutdown flushes, legacy records are unclassified, retention', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-demo-stats-'));
  try {
    let t = Date.parse('2026-11-24T10:00:00Z');
    const col = createDemoStatsCollector({ storageRoot: root, now: () => t });
    col.accept({ account: 'demo.coach', csrf: 'idle', body: { events: [{ type: 'enter', section: 'calendar' }, { type: 'active', section: 'calendar', seconds: 45 }] } });
    col.accept({ account: 'marco', csrf: 'open', body: { events: [{ type: 'enter', section: 'home' }, { type: 'active', section: 'home', seconds: 10 }] } });
    assert.equal(col.openSessions(), 2);
    t += 31 * 60000; col.accept({ account: 'marco', csrf: 'open', body: { events: [{ type: 'active', section: 'home', seconds: 5 }] } }); col.sweep();
    assert.equal(col.openSessions(), 1, 'idle session counted and dropped from memory');
    col.flushAll(); assert.equal(col.openSessions(), 0);
    const legacy = [{ v: 1, at: '2026-11-24T03:00:00.000Z', kind: 'enter', account: 'demo.coach', session: 'L1', browser: B1, section: 'overview' }, { v: 1, at: '2026-11-24T03:01:00.000Z', kind: 'active', account: 'demo.coach', session: 'L1', browser: B1, section: 'overview', seconds: 60, geo: { countryCode: 'US', country: 'United States', region: 'Virginia', city: 'Ashburn' } }];
    const rep = buildDemoStatsReport({ storageRoot: root, days: 7, now: t, legacyRecords: legacy });
    assert.equal(rep.classes.human_likely.sessions, 2);
    assert.equal(rep.classes.unclassified.sessions, 1); assert.equal(rep.classes.unclassified.legacySessions, 1);
    assert.equal(rep.classes.unclassified.geography[0].country, 'United States', 'US location alone does not make a session automated or human');
    assert.equal(JSON.stringify(rep).includes(B1), false);
    assert.equal(testMarkerValid('x'.repeat(40), 'x'.repeat(40)), true); assert.equal(testMarkerValid('x'.repeat(40), 'short'), false); assert.equal(testMarkerValid('', 'x'.repeat(40)), false);
    assert.equal(classifySession({ testVerified: false, automation: false, activeSeconds: 1 }), 'human_likely');
    // Retention: aggregate files older than 90 days are deleted.
    fs.writeFileSync(path.join(root, 'demo-stats', 'day-2026-07-01.json'), '{}'); fs.writeFileSync(path.join(root, 'demo-stats', 'week-2026-06-29.json'), '{}');
    assert.equal(pruneDemoStats(root, { now: t }), 2);
    assert.ok(fs.readdirSync(path.join(root, 'demo-stats')).every((f) => f.includes('2026-11')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('server: by default no audit archive or backup is deleted for its age (expiry is opt-in)', async () => {
  const server = await startServer({ AUTH_AUDIT_RETENTION_DAYS: '' });
  try {
    const { baseUrl, paths } = server;
    const auditDir = path.join(paths.storageRoot, 'auth-audit');
    fs.mkdirSync(path.join(auditDir, 'backups'), { recursive: true });
    const oldArchive = path.join(auditDir, 'events-2024-01-01T00-00-00-000Z.jsonl'); fs.writeFileSync(oldArchive, '{"action":"historical"}\n');
    const oldBackup = path.join(auditDir, 'backups', 'auth-audit-backup-2024-01-01T00-00-00-000Z.jsonl'); fs.writeFileSync(oldBackup, '{"action":"historical"}\n');
    const oldTime = new Date(Date.now() - 900 * 86400000); fs.utimesSync(oldArchive, oldTime, oldTime); fs.utimesSync(oldBackup, oldTime, oldTime);
    for (let i = 0; i < 2; i += 1) await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'coachA', password: 'CoachA!Pass1234' }) });
    assert.ok(fs.readdirSync(path.join(auditDir, 'backups')).length >= 2, 'a new backup was written (the code path that would prune ran)');
    assert.equal(fs.existsSync(oldArchive), true, '900-day-old archive kept');
    assert.equal(fs.existsSync(oldBackup), true, '900-day-old backup kept');
    assert.match(server.output(), /time-based expiry of audit archives and backups: off/);
  } finally { await server.stop(); }
});

test('server: audit never records a browser-supplied forwarded address as the client address; old archives expire when AUTH_AUDIT_RETENTION_DAYS is set', async () => {
  const server = await startServer({ AUTH_AUDIT_RETENTION_DAYS: '30' });
  try {
    const { baseUrl, paths } = server;
    const auditDir = path.join(paths.storageRoot, 'auth-audit');
    fs.mkdirSync(path.join(auditDir, 'backups'), { recursive: true });
    const oldArchive = path.join(auditDir, 'events-2025-01-01T00-00-00-000Z.jsonl'); fs.writeFileSync(oldArchive, '{"action":"old"}\n');
    const oldTime = new Date(Date.now() - 400 * 86400000); fs.utimesSync(oldArchive, oldTime, oldTime);
    const recentArchive = path.join(auditDir, 'events-2026-11-20T00-00-00-000Z.jsonl'); fs.writeFileSync(recentArchive, '{"action":"recent"}\n');
    await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '6.6.6.6, 81.2.69.160, 10.0.0.9' }, body: JSON.stringify({ username: 'coachA', password: 'CoachA!Pass1234' }) });
    const events = fs.readFileSync(path.join(auditDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const login = events.filter((e) => e.action === 'login_success').at(-1);
    assert.equal(login.ip, '10.0.0.9', 'right-most entry (added by our proxy)');
    assert.equal(login.clientNetworkUnverified, '81.2.69.0/24', 'reported client kept only as a network, unverified');
    assert.equal(JSON.stringify(events).includes('6.6.6.6'), false, 'the browser-written part is never stored');
    // Backup creation (due immediately in a fresh store) applies the time-based retention.
    await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'coachA', password: 'CoachA!Pass1234' }) });
    assert.equal(fs.existsSync(oldArchive), false, 'archive older than the retention deleted');
    assert.equal(fs.existsSync(recentArchive), true, 'recent archive kept');
  } finally { await server.stop(); }
});
