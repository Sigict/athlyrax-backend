import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveStorageConfiguration,
  runStorageSafetyCheck,
  sha256File,
  writeStorageReadyMarker,
} from './storage-safety-lib.mjs';
import {
  assertCanonicalPathContract,
  canonicalStoragePaths,
  finalizeLegacyStorageMigration,
  migrateLegacyStorageIfNeeded,
  restoreBundledDemoTenantIfNeeded,
} from './storage-path-contract.mjs';

const APPROVAL = 'MIGRATE_CANONICAL_STORAGE_ONCE';

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
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function slugTenantPart(value, fallback = 'default') {
  const normalized = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}
function isCanonicalTenantId(value) {
  const raw = clean(value);
  return Boolean(raw) && /^[a-z0-9_-]+$/.test(raw) && normalizeTenantId(raw) === raw;
}
function readJson(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { throw new Error(`${label} is not valid JSON: ${filePath}`); }
}
function authUsersFrom(value) {
  return Array.isArray(value) ? value : (value && Array.isArray(value.users) ? value.users : null);
}
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}
function resolveTenantFromUser(user, env) {
  const role = clean(user?.role).toLowerCase();
  const username = clean(user?.username).toLowerCase();
  const primaryOwner = clean(env.AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME || 'softwareowner').toLowerCase();
  if (username === 'demo.coach') return 'demo-company';
  if (role === 'software-owner' && username === primaryOwner) return '';
  if (role === 'swimmer' && normalizeTenantId(user?.tenantId) === 'snapshot-public' && clean(user?.createdVia) === 'snapshot-self-signup') return '';
  const explicit = normalizeTenantId(user?.tenantId);
  if (explicit) return explicit;
  const swimClub = clean(user?.swimClub);
  const teamName = clean(user?.teamName);
  if (swimClub && teamName) return `${slugTenantPart(swimClub, 'club')}__${slugTenantPart(teamName, 'team')}`;
  return username ? `user-${slugTenantPart(username, 'unknown-user')}` : '';
}
function assertMeaningfulDb(filePath, label, expectedTenantId = '') {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
  const parsed = readJson(filePath, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error(`${label} must contain a non-empty JSON object: ${filePath}`);
  }
  if (expectedTenantId) {
    const declared = normalizeTenantId(parsed?.__meta?.tenantId);
    if (declared && declared !== expectedTenantId) {
      throw new Error(`${label} declares tenant ${declared} but belongs to ${expectedTenantId}. Refusing cross-tenant activation.`);
    }
  }
  return parsed;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args['--approve'] !== APPROVAL) {
    throw new Error(`Explicit approval is required: --approve ${APPROVAL}`);
  }
  if (clean(process.env.NODE_ENV).toLowerCase() !== 'production') {
    throw new Error('One-time storage migration requires NODE_ENV=production.');
  }

  const __filename = fileURLToPath(import.meta.url);
  const sourceRoot = path.resolve(path.dirname(__filename), '..');
  const repoRoot = sourceRoot;
  const entryPath = path.join(sourceRoot, 'index.js');
  const indexSource = fs.readFileSync(entryPath, 'utf8');
  const configuration = resolveStorageConfiguration(process.env, repoRoot);
  if (configuration.failures.length > 0) {
    const error = new Error(configuration.failures.join('\n'));
    error.code = 'ATHLYRAX_STORAGE_CONFIGURATION_INVALID';
    throw error;
  }

  assertCanonicalPathContract({ sourceRoot, storageRoot: configuration.storageRoot, indexSource });
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot: configuration.storageRoot });

  // The explicit migration is the only production path allowed to mutate layout.
  // Existing legacy bytes are preserved to the independent safety backup root by
  // migrateLegacyStorageIfNeeded before canonical copies are activated.
  const migration = migrateLegacyStorageIfNeeded({
    sourceRoot,
    storageRoot: configuration.storageRoot,
    backupRoot: configuration.backupRoot,
  });
  const demoRecovery = restoreBundledDemoTenantIfNeeded({
    sourceRoot,
    storageRoot: configuration.storageRoot,
    backupRoot: configuration.backupRoot,
  });

  assertMeaningfulDb(paths.globalDb, 'Global database');
  const primaryUsers = authUsersFrom(readJson(paths.authUsers, 'Authentication user store'));
  const backupUsers = authUsersFrom(readJson(paths.authUsersBackup, 'Authentication user backup'));
  if (!primaryUsers || primaryUsers.length === 0) throw new Error('Authentication user store must contain at least one user.');
  if (!backupUsers || backupUsers.length === 0) throw new Error('Authentication user backup must contain at least one user.');
  if (JSON.stringify(canonicalJson(primaryUsers)) !== JSON.stringify(canonicalJson(backupUsers))) {
    throw new Error('Authentication primary and backup stores differ after migration. Refusing activation.');
  }

  const requiredTenants = [...new Set(primaryUsers.map((user) => resolveTenantFromUser(user, process.env)).filter(Boolean))].sort();
  for (const tenantId of requiredTenants) {
    if (!isCanonicalTenantId(tenantId)) throw new Error(`Noncanonical tenant ID after migration: ${tenantId}`);
    assertMeaningfulDb(paths.tenantDb(tenantId), `Tenant database ${tenantId}`, tenantId);
  }

  const verifiedFiles = [
    { path: paths.globalDb, sha256: sha256File(paths.globalDb), bytes: fs.statSync(paths.globalDb).size },
    { path: paths.authUsers, sha256: sha256File(paths.authUsers), bytes: fs.statSync(paths.authUsers).size },
    { path: paths.authUsersBackup, sha256: sha256File(paths.authUsersBackup), bytes: fs.statSync(paths.authUsersBackup).size },
    ...requiredTenants.map((tenantId) => {
      const filePath = paths.tenantDb(tenantId);
      return { path: filePath, sha256: sha256File(filePath), bytes: fs.statSync(filePath).size, tenantId };
    }),
  ];

  writeStorageReadyMarker(configuration.storageRoot, {
    migrationApproval: APPROVAL,
    requiredTenants,
    verifiedFiles,
  });

  // Full production validation must pass after all copies and before the migration
  // is finalized. If it fails, the process exits and the one-time marker is not finalized.
  runStorageSafetyCheck({
    repoRoot,
    requireFiles: true,
    createDirectories: false,
  });

  finalizeLegacyStorageMigration({ storageRoot: configuration.storageRoot, migrationResult: migration });

  console.log('ATHLYRAX_STORAGE_MIGRATION_OK');
  console.log(`Canonical storage: ${configuration.storageRoot}`);
  console.log(`Required tenants: ${requiredTenants.join(', ') || '(none)'}`);
  console.log(`Migrated items: ${migration.count || 0}`);
  console.log(`Demo recovery: ${demoRecovery.restored ? demoRecovery.source : demoRecovery.reason}`);
} catch (error) {
  console.error('ATHLYRAX_STORAGE_MIGRATION_FAILED');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
