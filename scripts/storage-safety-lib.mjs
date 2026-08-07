import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STORAGE_READY_MARKER = '.athlyrax-storage-ready.json';
export const STORAGE_LAYOUT_VERSION = 2;

function clean(value) {
  return String(value ?? '').trim();
}

function isInside(candidate, parent) {
  if (!candidate || !parent || candidate === parent) return false;
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isRenderDeployPath(value) {
  const raw = clean(value);
  if (!raw) return false;
  const normalizedRaw = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (normalizedRaw === '/opt/render/project' || normalizedRaw.startsWith('/opt/render/project/')) return true;
  const resolved = path.resolve(raw);
  const normalizedResolved = path.posix.normalize(resolved.replace(/\\/g, '/'));
  return normalizedResolved === '/opt/render/project' || normalizedResolved.startsWith('/opt/render/project/');
}

function resolveConfiguredPath(raw, fallback) {
  return path.resolve(clean(raw) || fallback);
}

export function resolveStorageConfiguration(env = process.env, repoRoot = process.cwd()) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const production = clean(env.NODE_ENV).toLowerCase() === 'production';
  const configuredStorageRoot = clean(env.ATHLYRAX_STORAGE_ROOT);
  const configuredBackupRoot = clean(env.ATHLYRAX_SAFETY_BACKUP_ROOT);
  const storageRoot = resolveConfiguredPath(configuredStorageRoot, path.join(resolvedRepoRoot, 'storage'));
  const backupRoot = resolveConfiguredPath(configuredBackupRoot, path.join(resolvedRepoRoot, '.athlyrax-safety-backups'));
  const authUsersPath = path.join(storageRoot, 'auth', 'auth-users.json');
  const authUsersBackupPath = path.join(storageRoot, 'auth', 'auth-users.backup.json');
  const failures = [];
  const warnings = [];

  if (production && !configuredStorageRoot) failures.push('ATHLYRAX_STORAGE_ROOT is required in production.');
  if (production && !configuredBackupRoot) failures.push('ATHLYRAX_SAFETY_BACKUP_ROOT is required in production.');
  if (production && isRenderDeployPath(storageRoot)) failures.push('Primary storage cannot be inside the Render deploy filesystem.');
  if (production && isRenderDeployPath(backupRoot)) failures.push('Safety backups cannot be inside the Render deploy filesystem.');
  if (storageRoot === backupRoot) failures.push('Primary storage and safety backup roots must be different directories.');
  if (isInside(storageRoot, backupRoot) || isInside(backupRoot, storageRoot)) {
    failures.push('Primary storage and safety backup roots must not be nested.');
  }

  const configuredAuthUsers = clean(env.AUTH_USERS_PATH);
  const configuredAuthBackup = clean(env.AUTH_USERS_BACKUP_PATH);
  if (configuredAuthUsers && path.resolve(configuredAuthUsers) !== authUsersPath) {
    failures.push(`AUTH_USERS_PATH must equal the canonical path: ${authUsersPath}`);
  }
  if (configuredAuthBackup && path.resolve(configuredAuthBackup) !== authUsersBackupPath) {
    failures.push(`AUTH_USERS_BACKUP_PATH must equal the canonical path: ${authUsersBackupPath}`);
  }

  if (!production && !configuredStorageRoot) warnings.push(`Using development storage root ${storageRoot}.`);
  if (!production && !configuredBackupRoot) warnings.push(`Using development safety backup root ${backupRoot}.`);

  return Object.freeze({
    production,
    repoRoot: resolvedRepoRoot,
    storageRoot,
    backupRoot,
    globalDbPath: path.join(storageRoot, 'db.json'),
    tenantRootPath: path.join(storageRoot, 'tenants'),
    authRootPath: path.join(storageRoot, 'auth'),
    authUsersPath,
    authUsersBackupPath,
    readyMarkerPath: path.join(storageRoot, STORAGE_READY_MARKER),
    failures,
    warnings,
  });
}

export function ensureWritableDirectory(directory, label = 'Directory', fsModule = fs) {
  fsModule.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.athlyrax-write-probe-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  try {
    fsModule.writeFileSync(probe, 'ok\n', 'utf8');
  } finally {
    try { fsModule.unlinkSync(probe); } catch {}
  }
  return `${label} is writable.`;
}

export function ensureStorageDirectories(configuration, fsModule = fs) {
  for (const directory of [
    configuration.storageRoot,
    configuration.backupRoot,
    configuration.authRootPath,
    configuration.tenantRootPath,
    path.join(configuration.storageRoot, 'db-snapshots'),
    path.join(configuration.storageRoot, 'billing-catalog-backups'),
    path.join(configuration.storageRoot, 'auth-audit'),
    path.join(configuration.storageRoot, 'auth-audit', 'backups'),
  ]) {
    fsModule.mkdirSync(directory, { recursive: true });
  }
}

export function applyCanonicalAuthPaths(configuration, env = process.env) {
  env.AUTH_USERS_PATH = configuration.authUsersPath;
  env.AUTH_USERS_BACKUP_PATH = configuration.authUsersBackupPath;
  return {
    authUsersPath: configuration.authUsersPath,
    authUsersBackupPath: configuration.authUsersBackupPath,
  };
}

function readReadyMarker(markerPath, fsModule = fs) {
  try {
    const parsed = JSON.parse(fsModule.readFileSync(markerPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function validateRequiredStorageFiles(configuration, env = process.env, fsModule = fs) {
  const failures = [];
  const required = [configuration.globalDbPath, configuration.authUsersPath];
  const tenants = clean(env.ATHLYRAX_REQUIRED_TENANTS).split(',').map((value) => value.trim()).filter(Boolean);

  for (const tenantId of tenants) {
    if (!/^[a-zA-Z0-9._-]+$/.test(tenantId)) {
      failures.push(`Invalid tenant key in ATHLYRAX_REQUIRED_TENANTS: ${tenantId}`);
      continue;
    }
    required.push(path.join(configuration.tenantRootPath, tenantId, 'db.json'));
  }

  for (const requiredPath of required) {
    if (!fsModule.existsSync(requiredPath)) failures.push(`Required storage file is missing: ${requiredPath}`);
  }

  if (configuration.production) {
    const marker = readReadyMarker(configuration.readyMarkerPath, fsModule);
    if (!marker || marker.version !== STORAGE_LAYOUT_VERSION || marker.approved !== true) {
      failures.push(`Storage approval marker is missing or invalid: ${configuration.readyMarkerPath}`);
    }
  }
  return failures;
}

export function runStorageSafetyCheck({
  env = process.env,
  repoRoot = process.cwd(),
  fsModule = fs,
  requireFiles = true,
  createDirectories = true,
  logger = console,
} = {}) {
  const configuration = resolveStorageConfiguration(env, repoRoot);
  const failures = [...configuration.failures];

  for (const warning of configuration.warnings) logger.warn(`[storage-safety] ${warning}`);
  if (failures.length) {
    const error = new Error(failures.join('\n'));
    error.code = 'ATHLYRAX_STORAGE_CONFIGURATION_INVALID';
    throw error;
  }

  if (createDirectories) ensureStorageDirectories(configuration, fsModule);
  ensureWritableDirectory(configuration.storageRoot, 'Primary storage root', fsModule);
  ensureWritableDirectory(configuration.backupRoot, 'Safety backup root', fsModule);
  env.ATHLYRAX_STORAGE_ROOT = configuration.storageRoot;
  env.ATHLYRAX_SAFETY_BACKUP_ROOT = configuration.backupRoot;
  applyCanonicalAuthPaths(configuration, env);

  if (requireFiles) failures.push(...validateRequiredStorageFiles(configuration, env, fsModule));
  if (failures.length) {
    const error = new Error(failures.join('\n'));
    error.code = 'ATHLYRAX_STORAGE_NOT_READY';
    throw error;
  }

  logger.info(`[storage-safety] Primary storage root: ${configuration.storageRoot}`);
  logger.info(`[storage-safety] Safety backup root: ${configuration.backupRoot}`);
  logger.info('[storage-safety] ATHLYRAX_STORAGE_SAFETY_OK');
  return { configuration };
}

export function sha256File(filePath, fsModule = fs) {
  const hash = crypto.createHash('sha256');
  hash.update(fsModule.readFileSync(filePath));
  return hash.digest('hex');
}

export function writeStorageReadyMarker(storageRoot, details = {}, fsModule = fs) {
  const markerPath = path.join(storageRoot, STORAGE_READY_MARKER);
  const payload = {
    version: STORAGE_LAYOUT_VERSION,
    approved: true,
    createdAt: new Date().toISOString(),
    ...details,
  };
  fsModule.writeFileSync(markerPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return markerPath;
}
