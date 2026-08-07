import fs from 'node:fs';
import path from 'node:path';
import { sha256File, writeStorageReadyMarker } from './storage-safety-lib.mjs';
import { canonicalStoragePaths } from './storage-path-contract.mjs';

function parseArgs(argv) {
  if (argv.length % 2 !== 0) throw new Error(`Incomplete argument: ${argv[argv.length - 1]}`);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = String(argv[index] || '').trim();
    if (!key.startsWith('--')) throw new Error(`Invalid argument: ${key}`);
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`Duplicate argument: ${key}`);
    result[key] = argv[index + 1];
  }
  return result;
}
function clean(value) { return String(value ?? '').trim(); }
function normalizeTenantId(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}
function isCanonicalTenantId(value) {
  const raw = clean(value);
  return Boolean(raw) && raw === normalizeTenantId(raw) && /^[a-z0-9_-]+$/.test(raw);
}
function slugTenantPart(value, fallback = 'default') {
  const normalized = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}
function readJson(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { throw new Error(`${label} is not valid JSON: ${filePath}`); }
}
function assertDbObject(filePath, label, expectedTenantId = '') {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  const parsed = readJson(filePath, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error(`${label} must contain a non-empty JSON object: ${filePath}`);
  }
  if (expectedTenantId) {
    const declaredRaw = clean(parsed?.__meta?.tenantId);
    if (declaredRaw) {
      if (!isCanonicalTenantId(declaredRaw)) throw new Error(`${label} declares noncanonical tenant ${declaredRaw}.`);
      if (declaredRaw !== expectedTenantId) throw new Error(`${label} declares tenant ${declaredRaw} but approval is for ${expectedTenantId}.`);
    }
  }
  return parsed;
}
function assertJsonArray(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  const parsed = readJson(filePath, label);
  if (!Array.isArray(parsed)) throw new Error(`${label} must contain a JSON array: ${filePath}`);
  return parsed;
}
function assertBillingCatalog(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  const parsed = readJson(filePath, 'Billing catalog');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.plans) || parsed.plans.length < 1) {
    throw new Error(`Billing catalog must contain at least one plan: ${filePath}`);
  }
  if (parsed.plans.some((plan) => !plan || typeof plan !== 'object' || !clean(plan.key))) {
    throw new Error(`Billing catalog contains an invalid plan row: ${filePath}`);
  }
  return parsed;
}
function assertAuthStore(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  const parsed = readJson(filePath, label);
  const users = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.users) ? parsed.users : null);
  if (!users || users.length === 0) throw new Error(`${label} must contain at least one user: ${filePath}`);
  return users;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}
function resolveTenantFromUser(user) {
  const username = clean(user?.username).toLowerCase();
  const role = clean(user?.role).toLowerCase();
  const createdVia = clean(user?.createdVia).toLowerCase();
  const primaryOwner = clean(process.env.AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME || 'softwareowner').toLowerCase();
  if (username === 'demo.coach') return 'demo-company';
  if (role === 'software-owner' && username === primaryOwner) return '';
  const explicit = normalizeTenantId(user?.tenantId);
  if (role === 'swimmer' && explicit === 'snapshot-public' && createdVia === 'snapshot-self-signup') return '';
  if (explicit) return explicit;
  const swimClub = clean(user?.swimClub);
  const teamName = clean(user?.teamName);
  if (swimClub && teamName) return `${slugTenantPart(swimClub, 'club')}__${slugTenantPart(teamName, 'team')}`;
  return username ? `user-${slugTenantPart(username, 'unknown-user')}` : '';
}
function verifiedFile(filePath, extra = {}) {
  return { path: filePath, sha256: sha256File(filePath), bytes: fs.statSync(filePath).size, ...extra };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args['--approve'] !== 'CREATE_READY_MARKER') throw new Error('Explicit approval is required: --approve CREATE_READY_MARKER');
  const rawStorageRoot = clean(args['--storage-root']);
  if (!rawStorageRoot) throw new Error('A valid --storage-root is required.');
  const storageRoot = path.resolve(rawStorageRoot);
  if (storageRoot === path.parse(storageRoot).root) throw new Error('A filesystem root cannot be used as --storage-root.');

  const paths = canonicalStoragePaths({ sourceRoot: process.cwd(), storageRoot });
  assertDbObject(paths.globalDb, 'Global database');
  const primaryUsers = assertAuthStore(paths.authUsers, 'Authentication user store');
  const backupUsers = assertAuthStore(paths.authUsersBackup, 'Authentication user backup');
  if (JSON.stringify(canonicalJson(primaryUsers)) !== JSON.stringify(canonicalJson(backupUsers))) {
    throw new Error('Authentication user store and backup differ. Refusing storage approval.');
  }
  assertJsonArray(paths.authInvites, 'Authentication invite store');
  assertJsonArray(paths.snapshotSubmissions, 'Snapshot submissions store');
  assertBillingCatalog(paths.billingCatalog);

  const requestedTenants = clean(args['--required-tenants']).split(',').map((value) => value.trim()).filter(Boolean);
  for (const tenantId of requestedTenants) if (!isCanonicalTenantId(tenantId)) throw new Error(`Noncanonical tenant ID in --required-tenants: ${tenantId}`);
  const authBoundTenants = primaryUsers.map(resolveTenantFromUser).filter(Boolean);
  for (const tenantId of authBoundTenants) if (!isCanonicalTenantId(tenantId)) throw new Error(`Noncanonical auth-bound tenant ID: ${tenantId}`);
  const requiredTenants = [...new Set([...requestedTenants, ...authBoundTenants])].sort();

  const verified = [
    verifiedFile(paths.globalDb),
    verifiedFile(paths.authUsers),
    verifiedFile(paths.authUsersBackup),
    verifiedFile(paths.authInvites),
    verifiedFile(paths.snapshotSubmissions),
    verifiedFile(paths.billingCatalog),
  ];
  for (const tenantId of requiredTenants) {
    const dbPath = paths.tenantDb(tenantId);
    assertDbObject(dbPath, `Tenant database ${tenantId}`, tenantId);
    verified.push(verifiedFile(dbPath, { tenantId }));
  }

  const markerPath = writeStorageReadyMarker(storageRoot, { requiredTenants, verifiedFiles: verified });
  console.log('ATHLYRAX_STORAGE_READY_MARKER_CREATED');
  console.log(`Marker: ${markerPath}`);
  console.log(`Verified files: ${verified.length}`);
} catch (error) {
  console.error('ATHLYRAX_STORAGE_READY_MARKER_FAILED');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
