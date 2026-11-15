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
  const tempRoot = reuse?.tempRoot || mkTempDir('athlyrax-owner-refresh-');
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
const loginAs = async (base, username, password) => { const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }); return { cookie: cookieHeader(r) }; };
const getAs = async (base, route, who) => { const r = await fetch(`${base}${route}`, { headers: who ? { Cookie: who.cookie } : {} }); return { status: r.status, j: await r.json().catch(() => ({})) }; };


// Register item 25: the owner re-reads one subscription from Stripe (not an event replay) and the
// account record is corrected through the normal subscription handler; audited; owner only.
import http from 'node:http';
const PERIOD_END = 1796518703; // 2026-12-06T00:58:23Z
function fakeStripe() {
  const calls = [];
  const subs = {
    sub_DEMO1234567: { id: 'sub_DEMO1234567', object: 'subscription', customer: 'cus_DEMO1', status: 'active', cancel_at_period_end: false, cancel_at: PERIOD_END, canceled_at: null, metadata: { planKey: 'tier-2', username: 'coachA' }, items: { object: 'list', data: [{ id: 'si_1', price: { id: 'price_tier_2_test', recurring: { interval: 'month' } }, quantity: 1, current_period_end: PERIOD_END }] } },
    sub_ORPHAN12345: { id: 'sub_ORPHAN12345', object: 'subscription', customer: 'cus_NOBODY', status: 'active', cancel_at_period_end: false, metadata: {}, items: { object: 'list', data: [] } },
  };
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const m = req.url.match(/^\/v1\/subscriptions\/([^/?]+)/);
    const sub = m && req.method === 'GET' ? subs[m[1]] : null;
    res.writeHead(sub ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sub || { error: { type: 'invalid_request_error', message: 'No such subscription', code: 'resource_missing' } }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) })));
}

test('owner refreshes one subscription from Stripe: scheduled cancellation recorded; others refused; audited; nothing written to Stripe', async () => {
  const stripe = await fakeStripe();
  const seed = (paths) => {
    const users = JSON.parse(fs.readFileSync(paths.authUsersPath, 'utf8'));
    const coach = users.find((u) => u.username === 'coachA');
    coach.billing = { customerId: 'cus_DEMO1', subscriptionId: 'sub_DEMO1234567', status: 'active', planKey: 'tier-2', cancelAtPeriodEnd: false, currentPeriodEnd: '' };
    writeJson(paths.authUsersPath, users); writeJson(paths.authUsersBackupPath, users);
  };
  const server = await startServer({ STRIPE_SECRET_KEY: 'sk_test_owner_refresh_dummy', STRIPE_PRICE_TIER_2: 'price_tier_2_test', ATHLYRAX_TEST_STRIPE_API_URL: stripe.url, BILLING_ENFORCED: 'false' }, seed);
  const base = server.baseUrl;
  const as = async (u, pw) => { const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) }); return { cookie: cookieHeader(r), csrf: (await r.json()).csrfToken }; };
  const refresh = (who, subscriptionId) => fetch(`${base}/owner/console/billing/refresh-from-stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: who.cookie, 'x-csrf-token': who.csrf } : {}) }, body: JSON.stringify({ subscriptionId }) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));
  try {
    const owner = await as('softwareowner', 'Owner!Pass1234'); const coach = await as('coachA', 'CoachA!Pass1234');
    assert.equal((await refresh(null, 'sub_DEMO1234567')).status, 401, 'anonymous refused');
    assert.equal((await refresh(coach, 'sub_DEMO1234567')).status, 403, 'club coach refused');
    assert.equal((await refresh(owner, 'not-a-sub')).status, 400);
    assert.equal((await refresh(owner, 'sub_MISSING1234')).status, 404);
    const orphan = await refresh(owner, 'sub_ORPHAN12345');
    assert.equal(orphan.status, 409, 'no linked account: nothing changed');
    const ok = await refresh(owner, 'sub_DEMO1234567');
    assert.equal(ok.status, 200, JSON.stringify(ok.j));
    assert.deepEqual(ok.j.before, { status: 'active', planKey: 'tier-2', cancelAtPeriodEnd: false, currentPeriodEnd: null });
    assert.equal(ok.j.after.cancelAtPeriodEnd, true, 'scheduled cancellation now recorded');
    assert.equal(ok.j.after.planKey, 'tier-2'); assert.equal(ok.j.after.status, 'active');
    assert.ok(String(ok.j.after.currentPeriodEnd).startsWith('2026-12-06'), ok.j.after.currentPeriodEnd);
    assert.equal(ok.j.changed, true);
    // The coach's own billing view now shows the scheduled cancellation, and it survives a restart.
    const restarted = await server.restart({ STRIPE_SECRET_KEY: 'sk_test_owner_refresh_dummy', STRIPE_PRICE_TIER_2: 'price_tier_2_test', ATHLYRAX_TEST_STRIPE_API_URL: stripe.url, BILLING_ENFORCED: 'false' });
    const coach2 = await (async () => { const r = await fetch(`${restarted.baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'coachA', password: 'CoachA!Pass1234' }) }); return cookieHeader(r); })();
    const bs = await (await fetch(`${restarted.baseUrl}/billing/subscription`, { headers: { Cookie: coach2 } })).json();
    const b = bs?.user?.billing?.billing || bs?.user?.billing || {};
    assert.equal(b.cancelAtPeriodEnd, true, JSON.stringify(bs).slice(0, 400));
    // Only reads were sent to Stripe.
    assert.ok(stripe.calls.length >= 3 && stripe.calls.every((c) => c.startsWith('GET /v1/subscriptions/')), stripe.calls.join(','));
    // Audited with before/after, without personal data beyond the account name.
    const audit = fs.readFileSync(path.join(server.paths.storageRoot, 'auth-audit', 'events.jsonl'), 'utf8');
    assert.match(audit, /owner_billing_refreshed_from_stripe/);
    await restarted.stop();
  } finally {
    await server.stop().catch(() => {}); await stripe.close();
  }
});
