import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STORAGE_READY_MARKER = '.athlyrax-storage-ready.json';
export const STORAGE_LAYOUT_VERSION = 1;

function clean(value) { return String(value ?? '').trim(); }
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
function resolveConfiguredPath(raw, fallback) { return path.resolve(clean(raw) || fallback); }
function envFalse(value) { return clean(value).toLowerCase() === 'false'; }
function envTrue(value) { return clean(value).toLowerCase() === 'true'; }
function slugTenantPart(value, fallback = 'default') {
  const normalized = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}
function normalizeTenantId(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}
function isCanonicalTenantId(value) {
  const raw = clean(value);
  return Boolean(raw) && raw === normalizeTenantId(raw) && /^[a-z0-9_-]+$/.test(raw);
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
  const legalAcceptancePath = path.join(storageRoot, 'legal-acceptances.jsonl');
  const authInvitesPath = path.join(storageRoot, 'auth-invites.json');
  const snapshotSubmissionsPath = path.join(storageRoot, 'snapshot-submissions.json');
  const billingCatalogPath = path.join(storageRoot, 'billing-catalog.json');
  const failures = [];
  const warnings = [];

  if (production && !configuredStorageRoot) failures.push('ATHLYRAX_STORAGE_ROOT is required in production.');
  if (production && !configuredBackupRoot) failures.push('ATHLYRAX_SAFETY_BACKUP_ROOT is required in production.');
  if (production && isRenderDeployPath(storageRoot)) failures.push('Primary storage cannot be inside the Render deploy filesystem.');
  if (production && isRenderDeployPath(backupRoot)) failures.push('Safety backups cannot be inside the Render deploy filesystem.');
  if (storageRoot === backupRoot) failures.push('Primary storage and safety backup roots must be different directories.');
  if (isInside(storageRoot, backupRoot) || isInside(backupRoot, storageRoot)) failures.push('Primary storage and safety backup roots must not be nested.');

  if (production) {
    if (envFalse(env.AUTH_REQUIRED)) failures.push('AUTH_REQUIRED must not be false in production.');
    if (envFalse(env.PHASE1_TENANT_ISOLATION)) failures.push('PHASE1_TENANT_ISOLATION must not be false in production.');
    if (envFalse(env.AUTH_ENFORCE_CANONICAL_STORE)) failures.push('AUTH_ENFORCE_CANONICAL_STORE must not be false in production.');
    if (envTrue(env.AUTH_ALLOW_BEARER_COMPAT)) failures.push('AUTH_ALLOW_BEARER_COMPAT must be false in production.');
    if (envTrue(env.AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE)) failures.push('AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE must be false in production.');

    const authSecret = clean(env.AUTH_SECRET);
    if (!authSecret || authSecret === 'athlyrax-dev-secret-change-me' || authSecret.length < 32) {
      failures.push('AUTH_SECRET must be explicitly configured with at least 32 characters in production.');
    }

    const stripeSecret = clean(env.STRIPE_SECRET_KEY);
    const stripeWebhookSecret = clean(env.STRIPE_WEBHOOK_SECRET);
    if (stripeSecret && !stripeWebhookSecret) failures.push('STRIPE_WEBHOOK_SECRET is required in production whenever STRIPE_SECRET_KEY is configured.');
  }

  for (const [name, canonical] of [
    ['AUTH_USERS_PATH', authUsersPath],
    ['AUTH_USERS_BACKUP_PATH', authUsersBackupPath],
    ['AUTH_LEGAL_ACCEPTANCE_PATH', legalAcceptancePath],
  ]) {
    const configured = clean(env[name]);
    if (configured && path.resolve(configured) !== canonical) failures.push(`${name} must equal the canonical path: ${canonical}`);
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
    legalAcceptancePath,
    authInvitesPath,
    snapshotSubmissionsPath,
    billingCatalogPath,
    readyMarkerPath: path.join(storageRoot, STORAGE_READY_MARKER),
    failures,
    warnings,
  });
}

export function ensureWritableDirectory(directory, label = 'Directory', fsModule = fs) {
  fsModule.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.athlyrax-write-probe-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  try { fsModule.writeFileSync(probe, 'ok\n', 'utf8'); }
  finally { try { fsModule.unlinkSync(probe); } catch {} }
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
  ]) fsModule.mkdirSync(directory, { recursive: true });
}

export function applyCanonicalAuthPaths(configuration, env = process.env) {
  env.AUTH_USERS_PATH = configuration.authUsersPath;
  env.AUTH_USERS_BACKUP_PATH = configuration.authUsersBackupPath;
  env.AUTH_LEGAL_ACCEPTANCE_PATH = configuration.legalAcceptancePath;
  return {
    authUsersPath: configuration.authUsersPath,
    authUsersBackupPath: configuration.authUsersBackupPath,
    legalAcceptancePath: configuration.legalAcceptancePath,
  };
}

function readReadyMarker(markerPath, fsModule = fs) {
  try {
    const parsed = JSON.parse(fsModule.readFileSync(markerPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
function readJsonForValidation(filePath, fsModule = fs) {
  try { return { ok: true, value: JSON.parse(fsModule.readFileSync(filePath, 'utf8')) }; }
  catch (error) { return { ok: false, error }; }
}
function authUsersArrayFromParsed(value) {
  return Array.isArray(value) ? value : (value && Array.isArray(value.users) ? value.users : null);
}
function validateDatabaseObject(filePath, label, fsModule = fs, requireNonEmpty = false) {
  if (!fsModule.existsSync(filePath)) return [`Required storage file is missing: ${filePath}`];
  const parsed = readJsonForValidation(filePath, fsModule);
  if (!parsed.ok) return [`${label} is not valid JSON: ${filePath}`];
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return [`${label} must contain a JSON object: ${filePath}`];
  if (requireNonEmpty && Object.keys(parsed.value).length === 0) return [`${label} must not be empty in production: ${filePath}`];
  return [];
}
function validateJsonArray(filePath, label, fsModule = fs) {
  if (!fsModule.existsSync(filePath)) return [`Required storage file is missing: ${filePath}`];
  const parsed = readJsonForValidation(filePath, fsModule);
  if (!parsed.ok) return [`${label} is not valid JSON: ${filePath}`];
  if (!Array.isArray(parsed.value)) return [`${label} must contain a JSON array: ${filePath}`];
  return [];
}
function validateBillingCatalog(filePath, fsModule = fs) {
  if (!fsModule.existsSync(filePath)) return [`Required storage file is missing: ${filePath}`];
  const parsed = readJsonForValidation(filePath, fsModule);
  if (!parsed.ok) return [`Billing catalog is not valid JSON: ${filePath}`];
  const value = parsed.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.plans) || value.plans.length < 1) {
    return [`Billing catalog must contain at least one plan: ${filePath}`];
  }
  if (value.plans.some((plan) => !plan || typeof plan !== 'object' || !clean(plan.key))) {
    return [`Billing catalog contains an invalid plan row: ${filePath}`];
  }
  return [];
}
function validateTenantDatabaseIdentity(filePath, expectedTenantId, label, fsModule = fs) {
  const parsed = readJsonForValidation(filePath, fsModule);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return [];
  const declaredRaw = clean(parsed.value?.__meta?.tenantId);
  if (!declaredRaw) return [];
  if (!isCanonicalTenantId(declaredRaw)) return [`${label} declares a noncanonical tenant ID: ${declaredRaw}. Refusing ambiguous routing: ${filePath}`];
  const expected = clean(expectedTenantId);
  if (!isCanonicalTenantId(expected)) return [`${label} expected tenant ID is noncanonical: ${expected}`];
  if (declaredRaw !== expected) return [`${label} declares tenant ${declaredRaw} but is stored at tenant ${expected}. Refusing cross-tenant data routing: ${filePath}`];
  return [];
}
function validateAuthStore(filePath, label = 'Authentication user store', fsModule = fs, requireNonEmpty = false) {
  if (!fsModule.existsSync(filePath)) return [`Required storage file is missing: ${filePath}`];
  const parsed = readJsonForValidation(filePath, fsModule);
  if (!parsed.ok) return [`${label} is not valid JSON: ${filePath}`];
  const users = authUsersArrayFromParsed(parsed.value);
  if (!users) return [`${label} must contain a users array: ${filePath}`];
  if (requireNonEmpty && users.length === 0) return [`${label} must contain at least one user in production: ${filePath}`];
  return [];
}
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}
function validateAuthPrimaryBackupParity(configuration, fsModule = fs) {
  const primaryParsed = readJsonForValidation(configuration.authUsersPath, fsModule);
  const backupParsed = readJsonForValidation(configuration.authUsersBackupPath, fsModule);
  if (!primaryParsed.ok || !backupParsed.ok) return [];
  const primaryUsers = authUsersArrayFromParsed(primaryParsed.value);
  const backupUsers = authUsersArrayFromParsed(backupParsed.value);
  if (!primaryUsers || !backupUsers) return [];
  if (JSON.stringify(canonicalJson(primaryUsers)) !== JSON.stringify(canonicalJson(backupUsers))) {
    return ['Authentication primary and backup stores differ. Refusing automatic overwrite or fallback.'];
  }
  return [];
}
function resolveTenantIdFromStoredUser(user, env = process.env) {
  const role = clean(user?.role).toLowerCase();
  const username = clean(user?.username).toLowerCase();
  const createdVia = clean(user?.createdVia).toLowerCase();
  const explicit = normalizeTenantId(user?.tenantId);
  const primaryOwnerUsername = clean(env.AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME || 'softwareowner').toLowerCase();
  if (username === 'demo.coach') return 'demo-company';
  if (role === 'software-owner' && username === primaryOwnerUsername) return '';
  if (role === 'swimmer' && explicit === 'snapshot-public' && createdVia === 'snapshot-self-signup') return '';
  if (explicit) return explicit;
  const swimClub = clean(user?.swimClub);
  const teamName = clean(user?.teamName);
  if (swimClub && teamName) return `${slugTenantPart(swimClub, 'club')}__${slugTenantPart(teamName, 'team')}`;
  return username ? `user-${slugTenantPart(username, 'unknown-user')}` : '';
}
function validateAuthBoundTenantDatabases(configuration, env = process.env, fsModule = fs) {
  const parsed = readJsonForValidation(configuration.authUsersPath, fsModule);
  if (!parsed.ok) return [];
  const users = authUsersArrayFromParsed(parsed.value);
  if (!users) return [];
  const failures = [];
  const tenantIds = new Set();
  for (const user of users) {
    const tenantId = resolveTenantIdFromStoredUser(user, env);
    if (tenantId) tenantIds.add(tenantId);
  }
  for (const tenantId of tenantIds) {
    if (!isCanonicalTenantId(tenantId)) {
      failures.push(`Auth-bound tenant ID is noncanonical: ${tenantId}`);
      continue;
    }
    const tenantPath = path.join(configuration.tenantRootPath, tenantId, 'db.json');
    const label = `Auth-bound tenant database ${tenantId}`;
    failures.push(...validateDatabaseObject(tenantPath, label, fsModule, configuration.production));
    failures.push(...validateTenantDatabaseIdentity(tenantPath, tenantId, label, fsModule));
  }
  return failures;
}

export function validateRequiredStorageFiles(configuration, env = process.env, fsModule = fs) {
  const failures = [];
  const strict = configuration.production;
  failures.push(...validateDatabaseObject(configuration.globalDbPath, 'Global database', fsModule, strict));
  failures.push(...validateAuthStore(configuration.authUsersPath, 'Authentication user store', fsModule, strict));
  failures.push(...validateAuthStore(configuration.authUsersBackupPath, 'Authentication user backup', fsModule, strict));
  if (strict) {
    failures.push(...validateJsonArray(configuration.authInvitesPath, 'Authentication invite store', fsModule));
    failures.push(...validateJsonArray(configuration.snapshotSubmissionsPath, 'Snapshot submissions store', fsModule));
    failures.push(...validateBillingCatalog(configuration.billingCatalogPath, fsModule));
    failures.push(...validateAuthPrimaryBackupParity(configuration, fsModule));
    failures.push(...validateAuthBoundTenantDatabases(configuration, env, fsModule));
  }

  const tenants = clean(env.ATHLYRAX_REQUIRED_TENANTS).split(',').map((value) => value.trim()).filter(Boolean);
  for (const tenantId of tenants) {
    if (!isCanonicalTenantId(tenantId)) {
      failures.push(`Invalid or noncanonical tenant key in ATHLYRAX_REQUIRED_TENANTS: ${tenantId}`);
      continue;
    }
    const tenantPath = path.join(configuration.tenantRootPath, tenantId, 'db.json');
    const label = `Tenant database ${tenantId}`;
    failures.push(...validateDatabaseObject(tenantPath, label, fsModule, strict));
    failures.push(...validateTenantDatabaseIdentity(tenantPath, tenantId, label, fsModule));
  }

  if (configuration.production) {
    const marker = readReadyMarker(configuration.readyMarkerPath, fsModule);
    if (!marker || marker.version !== STORAGE_LAYOUT_VERSION || marker.approved !== true) {
      failures.push(`Storage approval marker is missing or invalid: ${configuration.readyMarkerPath}`);
    } else if (!marker.storageRoot || path.resolve(marker.storageRoot) !== configuration.storageRoot) {
      failures.push(`Storage approval marker is not bound to this storage root: ${configuration.readyMarkerPath}`);
    }
  }
  return failures;
}

export function runStorageSafetyCheck({ env = process.env, repoRoot = process.cwd(), fsModule = fs, requireFiles = true, createDirectories = true, logger = console } = {}) {
  const configuration = resolveStorageConfiguration(env, repoRoot);
  const failures = [...configuration.failures];
  for (const warning of configuration.warnings) logger.warn(`[storage-safety] ${warning}`);
  if (failures.length) { const error = new Error(failures.join('\n')); error.code = 'ATHLYRAX_STORAGE_CONFIGURATION_INVALID'; throw error; }
  if (createDirectories) ensureStorageDirectories(configuration, fsModule);
  ensureWritableDirectory(configuration.storageRoot, 'Primary storage root', fsModule);
  ensureWritableDirectory(configuration.backupRoot, 'Safety backup root', fsModule);
  env.ATHLYRAX_STORAGE_ROOT = configuration.storageRoot;
  env.ATHLYRAX_SAFETY_BACKUP_ROOT = configuration.backupRoot;
  applyCanonicalAuthPaths(configuration, env);
  if (requireFiles) failures.push(...validateRequiredStorageFiles(configuration, env, fsModule));
  if (failures.length) { const error = new Error(failures.join('\n')); error.code = 'ATHLYRAX_STORAGE_NOT_READY'; throw error; }
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
  const resolvedStorageRoot = path.resolve(storageRoot);
  fsModule.mkdirSync(resolvedStorageRoot, { recursive: true });
  const markerPath = path.join(resolvedStorageRoot, STORAGE_READY_MARKER);
  const tempPath = path.join(resolvedStorageRoot, `${STORAGE_READY_MARKER}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const payload = { ...details, version: STORAGE_LAYOUT_VERSION, approved: true, storageRoot: resolvedStorageRoot, createdAt: new Date().toISOString() };
  let fileHandle = null;
  try {
    fileHandle = fsModule.openSync(tempPath, 'wx', 0o600);
    fsModule.writeFileSync(fileHandle, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fsModule.fsyncSync(fileHandle);
  } finally {
    if (fileHandle !== null) fsModule.closeSync(fileHandle);
  }
  try { fsModule.renameSync(tempPath, markerPath); }
  catch (error) { try { fsModule.unlinkSync(tempPath); } catch {} throw error; }
  try {
    const directoryHandle = fsModule.openSync(resolvedStorageRoot, 'r');
    try { fsModule.fsyncSync(directoryHandle); } finally { fsModule.closeSync(directoryHandle); }
  } catch {}
  return markerPath;
}
