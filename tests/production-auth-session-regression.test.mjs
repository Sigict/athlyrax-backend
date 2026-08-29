import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, child, stderrBuffer) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`backend exited early: ${child.exitCode}\n${stderrBuffer.join('')}`);
    }
    try {
      const response = await fetch(`${url}/auth/config`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`backend did not become ready\n${stderrBuffer.join('')}`);
}

function cookieHeaderFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  const session = raw.match(/athlyrax_session=([^;,]+)/)?.[1] || '';
  const csrf = raw.match(/athlyrax_csrf=([^;,]+)/)?.[1] || '';
  assert.ok(session, 'login must set session cookie');
  assert.ok(csrf, 'login must set csrf cookie');
  return `athlyrax_session=${session}; athlyrax_csrf=${csrf}`;
}

test('demo coach authority survives verification and logout cannot trap the browser', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-auth-session-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const stderrBuffer = [];
  const child = spawn(process.execPath, ['index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      ATHLYRAX_STORAGE_ROOT: storageRoot,
      AUTH_SECRET: 'production-auth-session-regression-secret',
      AUTH_ENABLE_DEMO_SEED_USERS: 'false',
      BILLING_STRICT_RECOVERY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => stderrBuffer.push(String(chunk)));
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  await waitForServer(baseUrl, child, stderrBuffer);

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'demo.coach', password: 'DemoCoach123!' }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody?.user?.role, 'head-coach');
  const cookie = cookieHeaderFrom(login);

  const me = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody?.user?.role, 'head-coach', 'verified session must not collapse demo.coach back to viewer');

  const logout = await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(logout.status, 200, 'logout must work without CSRF state');
  const logoutSetCookie = logout.headers.get('set-cookie') || '';
  assert.match(logoutSetCookie, /athlyrax_session=.*Max-Age=0/i);
  assert.match(logoutSetCookie, /athlyrax_csrf=.*Max-Age=0/i);

  const staleSession = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } });
  assert.equal(staleSession.status, 401, 'old session must be revoked after logout');
});
