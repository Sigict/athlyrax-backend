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
  const tempRoot = mkTempDir('athlyrax-results-inbox-');
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


const result = (name, rep, seconds, extra = {}) => ({
  format: 'athlyrax-swim-result', v: 1, id: `r-${name}-${rep}`, source: 'console', sessionId: 'sessionA', setId: 'set-1', setTitle: '4x50',
  swimmer: { id: '', name }, rep, distance: 50, time: { seconds, text: String(seconds) }, splits: [], review: { status: 'measured' },
  capturedAt: '2026-11-05T10:00:00.000Z', ...extra,
});
const resultsFile = (rows) => ({ format: 'athlyrax-results-file', v: 1, exportedAt: '2026-11-05T10:30:00.000Z', session: { id: 'sessionA', title: 'A Session', date: '2026-11-05' }, results: rows });

test('results inbox: coaches send, duplicates are detected, clubs are isolated, others are refused', async () => {
  const server = await startServer({ AUTH_PASSWORD_RESET_DELIVERY: 'console' });
  const base = server.baseUrl;
  try {
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    const file = resultsFile([result('Swimmer A', 1, 31.2), result('Swimmer A', 2, 31.0)]);

    const sent = await request(base, '/results-inbox', { ...coach, method: 'POST', body: { app: 'stopwatch', file } });
    assert.equal(sent.response.status, 201, JSON.stringify(sent.payload));
    assert.equal(sent.payload.duplicate, false);
    assert.equal(sent.payload.item.resultCount, 2);
    assert.equal(sent.payload.item.swimmerCount, 1);
    assert.equal(sent.payload.item.sessionDate, '2026-11-05');
    const id = sent.payload.item.id;

    // Same measurements again (even re-exported later): no second inbox item.
    const again = await request(base, '/results-inbox', { ...coach, method: 'POST', body: { app: 'stopwatch', file: { ...file, exportedAt: '2026-11-05T11:00:00.000Z' } } });
    assert.equal(again.response.status, 200);
    assert.equal(again.payload.duplicate, true);
    assert.equal(again.payload.item.id, id);
    assert.equal((await request(base, '/results-inbox', coach)).payload.items.length, 1);

    // The assistant coach of the same club sees and opens it.
    const assistant = await login(base, 'assistA', 'AssistA!Pass1234');
    const opened = await request(base, `/results-inbox/${id}`, assistant);
    assert.equal(opened.response.status, 200);
    assert.equal(opened.payload.file.results.length, 2);

    // Another club sees nothing and cannot open it.
    const other = await login(base, 'coachB', 'CoachB!Pass1234');
    assert.deepEqual((await request(base, '/results-inbox', other)).payload.items, []);
    assert.equal((await request(base, `/results-inbox/${id}`, other)).response.status, 404);
    assert.equal((await request(base, `/results-inbox/${id}/status`, { ...other, method: 'POST', body: { status: 'dismissed' } })).response.status, 404);

    // Viewers, anonymous callers and missing CSRF are refused.
    const viewer = await login(base, 'viewerA', 'ViewerA!Pass1234');
    assert.equal((await request(base, '/results-inbox', { ...viewer, method: 'POST', body: { file } })).response.status, 403);
    assert.equal((await fetch(`${base}/results-inbox`)).status, 401);
    assert.equal((await request(base, '/results-inbox', { ...coach, csrfToken: '', method: 'POST', body: { file } })).response.status, 403);

    // Invalid and oversized files.
    assert.equal((await request(base, '/results-inbox', { ...coach, method: 'POST', body: { file: { format: 'other' } } })).response.status, 400);
    assert.equal((await request(base, '/results-inbox', { ...coach, method: 'POST', body: { file: resultsFile([result('', 1, 30)]) } })).response.status, 400);
    assert.equal((await request(base, '/results-inbox', { ...coach, method: 'POST', body: { file: resultsFile([result('Swimmer A', 1, 0)]) } })).response.status, 400);
    const big = resultsFile([result('Swimmer A', 1, 30, { note: 'x'.repeat(2.1 * 1024 * 1024) })]);
    assert.equal((await request(base, '/results-inbox', { ...coach, method: 'POST', body: { file: big } })).response.status, 413);

    // Mark imported; status persists and records who and which session.
    const marked = await request(base, `/results-inbox/${id}/status`, { ...coach, method: 'POST', body: { status: 'imported', sessionId: 'sessionA' } });
    assert.equal(marked.response.status, 200);
    assert.equal(marked.payload.item.status, 'imported');
    assert.equal(marked.payload.item.importedBy, 'coachA');
    assert.deepEqual((await request(base, '/results-inbox?status=new', coach)).payload.items, []);
    assert.equal((await request(base, `/results-inbox/${id}/status`, { ...coach, method: 'POST', body: { status: 'new' } })).response.status, 400);

    // Inbox items never change the club database.
    const db = await request(base, '/db', coach);
    assert.equal(JSON.stringify(db.payload).includes('31.2'), false);
  } finally { await server.stop(); }
});
