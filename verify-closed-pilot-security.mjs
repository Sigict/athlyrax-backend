import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { canonicalStoragePaths } from './scripts/storage-path-contract.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NODE_ENV = String(process.env.NODE_ENV || '').trim().toLowerCase();
const IS_PRODUCTION = NODE_ENV === 'production';
const AUTH_REQUIRED = String(process.env.AUTH_REQUIRED || 'true').toLowerCase() === 'true';
const AUTH_SECRET = String(process.env.AUTH_SECRET || '').trim();
const AUTH_ALLOW_COACH_SIGNUP = String(process.env.AUTH_ALLOW_COACH_SIGNUP || 'false').toLowerCase() === 'true';
const AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE = String(process.env.AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE || 'false').toLowerCase() === 'true';
const FRONTEND_PUBLIC_ORIGIN = String(process.env.FRONTEND_PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').trim();
const AUTH_ALLOW_BEARER_COMPAT = String(process.env.AUTH_ALLOW_BEARER_COMPAT || 'false').toLowerCase() === 'true';
const STORAGE_ROOT = String(process.env.ATHLYRAX_STORAGE_ROOT || '').trim();
const SAFETY_BACKUP_ROOT = String(process.env.ATHLYRAX_SAFETY_BACKUP_ROOT || '').trim();

function exactHttpOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '*') return false;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.origin === raw
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function checkExistingWritableDir(dirPath) {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) return false;
    if (!fs.statSync(dirPath).isDirectory()) return false;
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function verifyGuardedStartupContract() {
  const failures = [];
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    const start = String(packageJson?.scripts?.start || '').trim();
    if (!start.includes('node scripts/production-start.mjs')) failures.push('Package start command must launch scripts/production-start.mjs');
  } catch {
    failures.push('package.json could not be read while verifying guarded startup');
  }
  try {
    const productionStart = fs.readFileSync(path.join(__dirname, 'scripts', 'production-start.mjs'), 'utf8');
    if (!productionStart.includes("scripts', 'safe-start.mjs")) failures.push('production-start.mjs must delegate to safe-start.mjs');
  } catch {
    failures.push('production-start.mjs could not be read while verifying guarded startup');
  }
  try {
    const safeStart = fs.readFileSync(path.join(__dirname, 'scripts', 'safe-start.mjs'), 'utf8');
    if (!safeStart.includes("globalThis[Symbol.for('athlyrax.safeStartEnforced')] = true")) failures.push('safe-start.mjs must establish the in-process safe-start proof');
  } catch {
    failures.push('safe-start.mjs could not be read while verifying guarded startup');
  }
  return failures;
}

const REJECTED_DEMO_USERNAMES = new Set(['headcoach', 'assistant', 'viewer']);
const KNOWN_DEFAULT_PASSWORDS = new Map([
  ['softwareowner', 'softwareowner123'],
  ['demo.coach', 'DemoCoach123!'],
  ['headcoach', 'headcoach123'],
  ['assistant', 'assistant123'],
  ['viewer', 'viewer123'],
]);

function verifyPassword(plainPassword, storedHash) {
  const value = String(storedHash || '').trim();
  if (!value.startsWith('scrypt$')) return false;
  const parts = value.split('$');
  if (parts.length !== 3) return false;
  try {
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const candidate = crypto.scryptSync(String(plainPassword || ''), salt, expected.length);
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function loadAuthUsers(authUsersPath) {
  try {
    if (!fs.existsSync(authUsersPath)) return [];
    const rows = JSON.parse(fs.readFileSync(authUsersPath, 'utf8'));
    if (Array.isArray(rows)) return rows;
    if (rows && Array.isArray(rows.users)) return rows.users;
    return [];
  } catch {
    return null;
  }
}

function getDefaultCredentialFailures(users) {
  const failures = [];
  for (const row of users) {
    const username = String(row?.username || '').trim().toLowerCase();
    if (!username) continue;
    if (REJECTED_DEMO_USERNAMES.has(username)) {
      failures.push(`Demo/default account is present: ${username}`);
      continue;
    }
    const defaultPassword = KNOWN_DEFAULT_PASSWORDS.get(username);
    if (defaultPassword && verifyPassword(defaultPassword, row?.passwordHash)) failures.push(`Known default password is still active for account: ${username}`);
  }
  return failures;
}

const failures = [];
if (!IS_PRODUCTION) failures.push('NODE_ENV must be production');
failures.push(...verifyGuardedStartupContract());
if (!AUTH_REQUIRED) failures.push('AUTH_REQUIRED must be true');
if (!AUTH_SECRET || AUTH_SECRET.length < 32 || AUTH_SECRET === 'athlyrax-dev-secret-change-me') failures.push('AUTH_SECRET must be strong and non-default');
if (AUTH_ALLOW_COACH_SIGNUP) failures.push('Public signup must be disabled');
if (AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE) failures.push('Reset dev-code response mode must be disabled');
if (!exactHttpOrigin(FRONTEND_PUBLIC_ORIGIN)) failures.push('FRONTEND_PUBLIC_ORIGIN must be an exact http/https origin');
const parsedOrigins = ALLOWED_ORIGINS.split(',').map((v) => String(v || '').trim()).filter(Boolean);
if (parsedOrigins.length < 1) failures.push('ALLOWED_ORIGINS must contain at least one explicit origin for the closed-pilot verification');
if (parsedOrigins.some((origin) => !exactHttpOrigin(origin))) failures.push('ALLOWED_ORIGINS contains an invalid, wildcard, path, query, fragment, or credential-bearing origin');
if (parsedOrigins.length > 0 && FRONTEND_PUBLIC_ORIGIN && !parsedOrigins.includes(FRONTEND_PUBLIC_ORIGIN)) failures.push('ALLOWED_ORIGINS must include FRONTEND_PUBLIC_ORIGIN');
if (AUTH_ALLOW_BEARER_COMPAT) failures.push('Bearer compatibility must be disabled');
if (!STORAGE_ROOT) failures.push('ATHLYRAX_STORAGE_ROOT must be set');
if (!SAFETY_BACKUP_ROOT) failures.push('ATHLYRAX_SAFETY_BACKUP_ROOT must be set');

const resolvedStorageRoot = STORAGE_ROOT ? path.resolve(STORAGE_ROOT) : path.join(__dirname, 'storage');
const resolvedBackupRoot = SAFETY_BACKUP_ROOT ? path.resolve(SAFETY_BACKUP_ROOT) : '';
const canonical = canonicalStoragePaths({ sourceRoot: __dirname, storageRoot: resolvedStorageRoot });
const configuredAuthPath = String(process.env.AUTH_USERS_PATH || '').trim();
if (configuredAuthPath && path.resolve(configuredAuthPath) !== canonical.authUsers) failures.push(`AUTH_USERS_PATH must equal canonical path: ${canonical.authUsers}`);
if (!checkExistingWritableDir(resolvedStorageRoot)) failures.push('Storage root must already exist and be readable/writable');
if (!resolvedBackupRoot || !checkExistingWritableDir(resolvedBackupRoot)) failures.push('Backup root must already exist and be readable/writable');
if (resolvedBackupRoot && resolvedStorageRoot && resolvedBackupRoot === resolvedStorageRoot) failures.push('Backup root must be separate from storage root');

const authUsers = loadAuthUsers(canonical.authUsers);
if (authUsers === null) failures.push('Auth users file could not be parsed');
else failures.push(...getDefaultCredentialFailures(authUsers));

if (failures.length > 0) {
  console.error('ATHLYRAX_CLOSED_PILOT_SECURITY_FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('ATHLYRAX_CLOSED_PILOT_SECURITY_OK');