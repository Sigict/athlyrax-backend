import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
const SAFE_START_ENFORCED = String(process.env.ATHLYRAX_SAFE_START_ENFORCED || '').trim() === 'true';
const STORAGE_ROOT = String(process.env.ATHLYRAX_STORAGE_ROOT || '').trim();
const SAFETY_BACKUP_ROOT = String(process.env.ATHLYRAX_SAFETY_BACKUP_ROOT || '').trim();

function checkWritableDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probePath = path.join(dirPath, `.athlyrax-write-probe-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probePath, 'ok', 'utf8');
    fs.unlinkSync(probePath);
    return true;
  } catch {
    return false;
  }
}

function hasSeededUsers(storageRootPath) {
  try {
    const authUsersPath = path.join(storageRootPath, 'auth-users.json');
    if (!fs.existsSync(authUsersPath)) return false;
    const rows = JSON.parse(fs.readFileSync(authUsersPath, 'utf8'));
    if (!Array.isArray(rows)) return false;
    const forbiddenUsernames = new Set(['softwareowner', 'headcoach', 'assistant', 'viewer']);
    return rows.some((row) => {
      const username = String(row?.username || '').trim().toLowerCase();
      const createdVia = String(row?.createdVia || '').trim().toLowerCase();
      return forbiddenUsernames.has(username) || createdVia === 'seed';
    });
  } catch {
    return true;
  }
}

const failures = [];

if (!IS_PRODUCTION) failures.push('NODE_ENV must be production');
if (!SAFE_START_ENFORCED) failures.push('Safe-start enforcement flag missing');
if (!AUTH_REQUIRED) failures.push('AUTH_REQUIRED must be true');
if (!AUTH_SECRET || AUTH_SECRET.length < 32 || AUTH_SECRET === 'athlyrax-dev-secret-change-me') {
  failures.push('AUTH_SECRET must be strong and non-default');
}
if (AUTH_ALLOW_COACH_SIGNUP) failures.push('Public signup must be disabled');
if (AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE) failures.push('Reset dev-code response mode must be disabled');
if (!FRONTEND_PUBLIC_ORIGIN || FRONTEND_PUBLIC_ORIGIN.includes('*')) failures.push('FRONTEND_PUBLIC_ORIGIN must be explicitly set');
if (!ALLOWED_ORIGINS || ALLOWED_ORIGINS.includes('*')) failures.push('ALLOWED_ORIGINS cannot be empty or wildcard');
if (ALLOWED_ORIGINS && FRONTEND_PUBLIC_ORIGIN) {
  const parsed = ALLOWED_ORIGINS.split(',').map((v) => String(v || '').trim()).filter(Boolean);
  if (!parsed.includes(FRONTEND_PUBLIC_ORIGIN)) failures.push('ALLOWED_ORIGINS must include FRONTEND_PUBLIC_ORIGIN');
}
if (AUTH_ALLOW_BEARER_COMPAT) failures.push('Bearer compatibility must be disabled');
if (!STORAGE_ROOT) failures.push('ATHLYRAX_STORAGE_ROOT must be set');
if (!SAFETY_BACKUP_ROOT) failures.push('ATHLYRAX_SAFETY_BACKUP_ROOT must be set');

const resolvedStorageRoot = STORAGE_ROOT ? path.resolve(STORAGE_ROOT) : path.join(__dirname, 'storage');
const resolvedBackupRoot = SAFETY_BACKUP_ROOT ? path.resolve(SAFETY_BACKUP_ROOT) : '';
if (!checkWritableDir(resolvedStorageRoot)) failures.push('Storage root is not writable');
if (!resolvedBackupRoot || !checkWritableDir(resolvedBackupRoot)) failures.push('Backup root is not writable');
if (resolvedBackupRoot && resolvedStorageRoot && resolvedBackupRoot === resolvedStorageRoot) {
  failures.push('Backup root must be separate from storage root');
}
if (hasSeededUsers(resolvedStorageRoot)) failures.push('Seeded/default users are present');

if (failures.length > 0) {
  console.error('ATHLYRAX_CLOSED_PILOT_SECURITY_FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('ATHLYRAX_CLOSED_PILOT_SECURITY_OK');
