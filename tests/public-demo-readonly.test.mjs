import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BACKEND_DIR = path.resolve(process.cwd());

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function startServer() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-public-demo-'));
  const storageRoot = path.join(tempRoot, 'storage');
  const backupRoot = path.join(tempRoot, 'backup');
  const authUsersPath = path.join(storageRoot, 'auth', 'auth-users.json');
  const authUsersBackupPath = path.join(storageRoot, 'auth', 'auth-users.backup.json');
  fs.mkdirSync(backupRoot, { recursive: true });

  const users = [{
    username: 'demo.coach',
    password: 'DemoCoach123!',
    role: 'head-coach',
    tenantId: 'demo-company',
    clubId: 'demo-company',
    swimClub: 'Demo Company',
    teamName: 'Demo Team',
    isApproved: true,
    onboardingCompletedAt: new Date().toISOString(),
  }];
  writeJson(authUsersPath, users);
  writeJson(authUsersBackupPath, users);
  writeJson(path.join(storageRoot, 'auth-invites.json'), []);
  writeJson(path.join(storageRoot, 'db.json'), { __meta: { tenantId: 'global-owner' }, swimmers: [{ id: 'owner-only' }] });
  writeJson(path.join(storageRoot, 'tenants', 'demo-company', 'db.json'), {
    __meta: { tenantId: 'demo-company' },
    swimmers: [{ id: 'demo-swimmer', name: 'Synthetic Demo Swimmer' }],
    squads: [{ id: 'demo-squad', name: 'Synthetic Demo Squad' }],
  });
  writeJson(path.join(storageRoot, 'tenants', 'other-company', 'db.json'), {
    __meta: { tenantId: 'other-company' },
    swimmers: [{ id: 'other-swimmer', name: 'Other Swimmer' }],
  });

  const port = String(3700 + Math.floor(Math.random() * 200));
  const child = spawn('node', ['index.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: port,
      AUTH_REQUIRED: 'true',
      AUTH_SECRET: 'public-demo-readonly-test-secret-at-least-32-characters',
      AUTH_ALLOW_COACH_SIGNUP: 'false',
      AUTH_ALLOW_BEARER_COMPAT: 'false',
      FRONTEND_PUBLIC_ORIGIN: 'http://localhost:5173',
      ALLOWED_ORIGINS: 'http://localhost:5173',
      ATHLYRAX_STORAGE_ROOT: storageRoot,
      ATHLYRAX_SAFETY_BACKUP_ROOT: backupRoot,
      AUTH_USERS_PATH: authUsersPath,
      AUTH_USERS_BACKUP_PATH: authUsersBackupPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => { stdout += String(buf || ''); });
  child.stderr.on('data', (buf) => { stderr += String(buf || ''); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start. stdout=${stdout} stderr=${stderr}`)), 10000);
    const onData = () => {
      if (!stdout.includes('Server running at')) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before ready. stdout=${stdout} stderr=${stderr}`));
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
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

test('public demo credential is server-forced to viewer and cannot write or escape demo-company', async () => {
  const server = await startServer();
  try {
    const loginResponse = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'demo.coach', password: 'DemoCoach123!' }),
    });
    const login = await loginResponse.json();
    assert.equal(loginResponse.status, 200, JSON.stringify(login));
    assert.equal(login?.user?.role, 'viewer');
    assert.equal(login?.user?.tenantId, 'demo-company');
    const cookie = cookieHeader(loginResponse);
    assert.ok(cookie.includes('athlyrax_session='));

    const meResponse = await fetch(`${server.baseUrl}/auth/me`, { headers: { Cookie: cookie } });
    const me = await meResponse.json();
    assert.equal(meResponse.status, 200);
    assert.equal(me?.user?.role, 'viewer');
    assert.equal(me?.user?.tenantId, 'demo-company');

    const dbResponse = await fetch(`${server.baseUrl}/db`, { headers: { Cookie: cookie } });
    const db = await dbResponse.json();
    assert.equal(dbResponse.status, 200);
    assert.ok((db?.swimmers || []).some((row) => row.id === 'demo-swimmer'));
    assert.ok(!(db?.swimmers || []).some((row) => row.id === 'other-swimmer'));

    const foreignResponse = await fetch(`${server.baseUrl}/db`, {
      headers: { Cookie: cookie, 'x-athlyrax-tenant': 'other-company' },
    });
    assert.equal(foreignResponse.status, 403);

    const writeResponse = await fetch(`${server.baseUrl}/db`, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        [String(login?.csrfHeaderName || 'x-csrf-token').toLowerCase()]: String(login?.csrfToken || ''),
      },
      body: JSON.stringify({ swimmers: [{ id: 'forbidden-write' }] }),
    });
    assert.equal(writeResponse.status, 403);
  } finally {
    await server.stop();
  }
});
