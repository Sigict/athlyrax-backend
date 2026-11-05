import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { resolveStorageConfiguration } from '../scripts/storage-safety-lib.mjs';
import Stripe from 'stripe';

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

async function startServer(envOverrides = {}) {
  const tempRoot = mkTempDir('athlyrax-coaching-billing-');
  const paths = createFixtureStorage(tempRoot);
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

const WEBHOOK_SECRET = 'whsec_test_coaching_billing';
const PRICES = { t1: 'price_test_tier_1', t3: 'price_test_tier_3', a25: 'price_test_add_25', a50: 'price_test_add_50' };
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_coaching_billing_dummy', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_TIER_1: PRICES.t1, STRIPE_PRICE_TIER_3: PRICES.t3,
  STRIPE_PRICE_ADDON_25_SWIMMERS: PRICES.a25, STRIPE_PRICE_ADDON_50_SWIMMERS: PRICES.a50,
  BILLING_ENFORCED: 'true', AUTH_PASSWORD_RESET_DELIVERY: 'console',
};
const stripe = new Stripe('sk_test_coaching_billing_dummy');
let eventSeq = 0;

async function sendEvent(baseUrl, type, object) {
  eventSeq += 1;
  const payload = JSON.stringify({ id: `evt_cb_${eventSeq}`, type, created: 1000 + eventSeq, data: { object } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const response = await fetch(`${baseUrl}/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': header }, body: payload });
  assert.equal(response.status, 200, `webhook ${type}: ${await response.text()}`);
}

const subscription = (status, items) => ({
  id: 'sub_cb', customer: 'cus_cb', status, metadata: { username: 'coachA' },
  items: { data: items.map(([price, quantity]) => ({ price: { id: price }, quantity })) },
  current_period_end: 2000000000, cancel_at_period_end: false,
});
const swimmers = (n) => Array.from({ length: n }, (_, i) => ({ id: `cb-swimmer-${i}`, name: `Swimmer ${i}`, tenantId: 'tenant-a' }));

async function saveSwimmers(baseUrl, session, count) {
  const current = await request(baseUrl, '/db', session);
  assert.equal(current.response.status, 200, JSON.stringify(current.payload));
  return request(baseUrl, '/db', { ...session, method: 'PUT', body: { ...current.payload, swimmers: swimmers(count) } });
}

test('coaching subscription with capacity blocks: capacity, Stopwatch entitlement and swimmer limit', async () => {
  const server = await startServer(STRIPE_ENV);
  try {
    // Tier 1 with one +25 block, add-on item listed first.
    await sendEvent(server.baseUrl, 'customer.subscription.created', subscription('active', [[PRICES.a25, 1], [PRICES.t1, 1]]));
    const coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const me = await request(server.baseUrl, '/auth/me', coach);
    const access = me.payload?.user?.access || {};
    assert.equal(access.billing?.planKey, 'tier-1', JSON.stringify(access.billing));
    assert.deepEqual(access.billing?.addons, { 'extra-25-swimmers': 1 });
    assert.equal(access.swimmerCapacity, 49);
    assert.equal(access.stopwatch?.lanes, 3);
    assert.equal(access.stopwatch?.assistants, 0);

    const stopwatch = await request(server.baseUrl, '/entitlements/stopwatch', coach);
    assert.equal(stopwatch.response.status, 200);
    assert.equal(stopwatch.payload.stopwatch.lanes, 3);
    assert.equal(stopwatch.payload.stopwatch.source, 'coaching-subscription');

    const atCapacity = await saveSwimmers(server.baseUrl, coach, 49);
    assert.equal(atCapacity.response.status, 200, JSON.stringify(atCapacity.payload));
    const overCapacity = await saveSwimmers(server.baseUrl, coach, 50);
    assert.equal(overCapacity.response.status, 402);
    assert.equal(overCapacity.payload.code, 'swimmer_capacity_reached');
    const afterRefusal = await request(server.baseUrl, '/db', coach);
    assert.equal(afterRefusal.payload.swimmers.length, 49, 'refused save must not change stored swimmers');

    // Upgrade to Tier 3 with 2 x 50: 300 swimmers, 10 lanes and assistants, no separate Stopwatch charge.
    await sendEvent(server.baseUrl, 'customer.subscription.updated', subscription('active', [[PRICES.t3, 1], [PRICES.a50, 2]]));
    const upgraded = (await request(server.baseUrl, '/auth/me', coach)).payload?.user?.access || {};
    assert.equal(upgraded.swimmerCapacity, 300);
    assert.equal(upgraded.stopwatch?.lanes, 10);
    assert.ok(upgraded.stopwatch?.assistants > 0);
    assert.equal((await saveSwimmers(server.baseUrl, coach, 300)).response.status, 200);

    // Assistant coach of the same club inherits the club's Stopwatch entitlement.
    const assistant = await login(server.baseUrl, 'assistA', 'AssistA!Pass1234');
    assert.equal((await request(server.baseUrl, '/entitlements/stopwatch', assistant)).payload.stopwatch.lanes, 10);

    // Cancellation: entitlement returns to free; add-ons cleared.
    await sendEvent(server.baseUrl, 'customer.subscription.deleted', subscription('canceled', [[PRICES.t3, 1], [PRICES.a50, 2]]));
    const cancelled = (await request(server.baseUrl, '/auth/me', coach)).payload?.user?.access || {};
    assert.equal(cancelled.stopwatch?.source, 'free');
    assert.equal(cancelled.stopwatch?.lanes, 1);
    assert.deepEqual(cancelled.billing?.addons, {});

    // Anonymous callers get nothing.
    const anon = await fetch(`${server.baseUrl}/entitlements/stopwatch`);
    assert.equal(anon.status, 401);
  } finally { await server.stop(); }
});

test('without billing enforcement, connected clubs keep current Stopwatch access and no swimmer limit', async () => {
  const server = await startServer({ ...STRIPE_ENV, BILLING_ENFORCED: 'false' });
  try {
    const coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    const stopwatch = await request(server.baseUrl, '/entitlements/stopwatch', coach);
    assert.equal(stopwatch.payload.stopwatch.lanes, 10);
    assert.equal(stopwatch.payload.stopwatch.source, 'billing-not-enforced');
    assert.equal((await saveSwimmers(server.baseUrl, coach, 60)).response.status, 200);
  } finally { await server.stop(); }
});
