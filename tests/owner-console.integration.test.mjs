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
const loginAs = async (base, username, password) => { const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }); return { cookie: cookieHeader(r) }; };
const getAs = async (base, route, who) => { const r = await fetch(`${base}${route}`, { headers: who ? { Cookie: who.cookie } : {} }); return { status: r.status, j: await r.json().catch(() => ({})) }; };

test('Owner Console: owner only; reports from stored records; health checks run; Resend webhook off until configured, then signed events update the matching invitation email', async () => {
  const secret = 'whsec_' + crypto.randomBytes(24).toString('base64');
  const seed = (paths) => writeJson(path.join(paths.storageRoot, 'tenants', 'tenant-a', 'db.json'), { swimmers: [{ id: 'ad1', firstName: 'Ada', lastName: 'Long', dob: '1990-01-01' }] });
  const off = await startServer({}, seed);
  try { assert.equal((await fetch(`${off.baseUrl}/webhooks/resend/athlete-invites`, { method: 'POST', body: '{}' })).status, 404, 'webhook off without a secret'); } finally { await off.stop(); }
  const server = await startServer({ RESEND_WEBHOOK_SECRET: secret }, seed);
  const base = server.baseUrl;
  try {
    const owner = await loginAs(base, 'softwareowner', 'Owner!Pass1234'); const coach = await loginAs(base, 'coachA', 'CoachA!Pass1234');
    for (const route of ['/owner/console/summary', '/owner/console/health', '/owner/console/sales']) {
      assert.equal((await getAs(base, route)).status, 401, route + ' anonymous');
      assert.equal((await getAs(base, route, coach)).status, 403, route + ' coach');
    }
    // A coach sends an invitation email (development outbox); the owner sees it as accepted, not delivered.
    const csrf = (await (await fetch(`${base}/auth/me`, { headers: { Cookie: coach.cookie } })).json()).csrfToken;
    const coachLogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'coachA', password: 'CoachA!Pass1234' }) });
    const cj = await coachLogin.json(); const cc = cookieHeader(coachLogin);
    const bulk = await fetch(`${base}/coach/athlete-invites/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cc, 'x-csrf-token': cj.csrfToken }, body: JSON.stringify({ requestId: 'req-owner-console-1', items: [{ swimmerId: 'ad1', athleteEmail: 'ada@example.com' }] }) });
    assert.equal(bulk.status, 200, String(csrf));
    let sum = await getAs(base, '/owner/console/summary?days=7', owner);
    assert.equal(sum.status, 200); assert.equal(sum.j.days, 7);
    assert.equal(sum.j.accounts.available, true); assert.ok(sum.j.accounts.total >= 6);
    assert.equal(sum.j.invitations.deliveries.sent, 1); assert.equal(sum.j.invitations.deliveries.delivered, 0);
    assert.ok(!JSON.stringify(sum.j).includes('ada@example.com'), 'emails masked');
    assert.ok(!/passwordHash|tokenHash|AXA1\./.test(JSON.stringify(sum.j)), 'no secrets');
    // A signed Resend "delivered" event for that recipient updates that email; a bad signature is refused.
    const body = JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(), data: { to: ['ada@example.com'], email_id: 'x' } });
    const id = 'msg_' + crypto.randomBytes(6).toString('hex'); const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
    assert.equal((await fetch(`${base}/webhooks/resend/athlete-invites`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,' + sig.replace(/.$/, 'A') }, body })).status, 401);
    const ok = await fetch(`${base}/webhooks/resend/athlete-invites`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,' + sig }, body });
    assert.equal(ok.status, 200); assert.equal((await ok.json()).matched, true);
    sum = await getAs(base, '/owner/console/summary?days=7', owner);
    assert.equal(sum.j.invitations.deliveries.delivered, 1); assert.equal(sum.j.webhooks.resend.received, 2);
    const health = await getAs(base, '/owner/console/health', owner);
    assert.equal(health.status, 200);
    const check = (name) => health.j.checks.find((c) => c.system.startsWith(name));
    assert.equal(check('Database storage').status, 'ok'); assert.equal(check('Club data').status, 'ok'); assert.equal(check('Email delivery confirmation').status, 'ok');
    const sales = await getAs(base, '/owner/console/sales?days=30', owner);
    assert.equal(sales.status, 200); assert.equal(sales.j.coaching.available, false, 'no Stripe in tests: unavailable, not zero');
  } finally { await server.stop(); }
});
