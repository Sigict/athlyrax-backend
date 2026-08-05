import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

const REPO_DIR = path.resolve(process.cwd());

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function hashPassword(plainPassword) {
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(String(plainPassword || ''), salt, 64);
  return `scrypt$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

async function runVerifierWithUsers(users) {
  const root = mkTempDir('athlyrax-verifier-');
  const storageRoot = path.join(root, 'storage');
  const backupRoot = path.join(root, 'backup');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });
  writeJson(path.join(storageRoot, 'auth-users.json'), users);

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    AUTH_REQUIRED: 'true',
    AUTH_SECRET: 'this-is-a-very-strong-test-secret-value-1234',
    AUTH_ALLOW_COACH_SIGNUP: 'false',
    AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE: 'false',
    FRONTEND_PUBLIC_ORIGIN: 'https://athlyrax.com',
    ALLOWED_ORIGINS: 'https://athlyrax.com',
    AUTH_ALLOW_BEARER_COMPAT: 'false',
    ATHLYRAX_SAFE_START_ENFORCED: 'true',
    ATHLYRAX_STORAGE_ROOT: storageRoot,
    ATHLYRAX_SAFETY_BACKUP_ROOT: backupRoot,
  };

  const result = await new Promise((resolve) => {
    const child = spawn('node', ['verify-closed-pilot-security.mjs'], {
      cwd: REPO_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => {
      stdout += String(buf || '');
    });
    child.stderr.on('data', (buf) => {
      stderr += String(buf || '');
    });
    child.on('exit', (code) => {
      resolve({ code: Number(code), stdout, stderr });
    });
  });

  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

test('softwareowner with changed password passes', async () => {
  const users = [
    {
      username: 'softwareowner',
      passwordHash: hashPassword('Owner!Pass1234'),
      role: 'software-owner',
      createdVia: 'seed',
      isApproved: true,
    },
  ];

  const result = await runVerifierWithUsers(users);
  assert.equal(result.code, 0, `Verifier should pass. stderr=${result.stderr}`);
  assert.match(result.stdout, /ATHLYRAX_CLOSED_PILOT_SECURITY_OK/);
});

test('softwareowner with softwareowner123 fails', async () => {
  const users = [
    {
      username: 'softwareowner',
      passwordHash: hashPassword('softwareowner123'),
      role: 'software-owner',
      createdVia: 'admin',
      isApproved: true,
    },
  ];

  const result = await runVerifierWithUsers(users);
  assert.equal(result.code, 1, `Verifier should fail. stderr=${result.stderr}`);
  assert.match(result.stderr, /Known default password is still active for account: softwareowner/);
});

test('demo seed accounts fail', async () => {
  const users = [
    {
      username: 'softwareowner',
      passwordHash: hashPassword('Owner!Pass1234'),
      role: 'software-owner',
      createdVia: 'admin',
      isApproved: true,
    },
    {
      username: 'headcoach',
      passwordHash: hashPassword('NotDefault!1234'),
      role: 'head-coach',
      createdVia: 'seed',
      isApproved: true,
    },
  ];

  const result = await runVerifierWithUsers(users);
  assert.equal(result.code, 1, `Verifier should fail. stderr=${result.stderr}`);
  assert.match(result.stderr, /Demo\/default account is present: headcoach/);
});
