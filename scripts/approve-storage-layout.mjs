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

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON: ${filePath}`);
  }
}

function normalizeTenantId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function assertDbObject(filePath, label, expectedTenantId = '') {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  const parsed = readJson(filePath, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object: ${filePath}`);
  }
  if (Object.keys(parsed).length === 0) throw new Error(`${label} must not be empty: ${filePath}`);
  if (expectedTenantId) {
    const declared = normalizeTenantId(parsed?.__meta?.tenantId);
    const expected = normalizeTenantId(expectedTenantId);
    if (declared && declared !== expected) {
      throw new Error(`${label} declares tenant ${declared} but approval is for ${expected}.`);
    }
  }
  return parsed;
}

function assertAuthStore(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  const parsed = readJson(filePath, label);
  const users = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.users) ? parsed.users : null);
  if (!users) throw new Error(`${label} must contain a users array: ${filePath}`);
  if (users.length === 0) throw new Error(`${label} must contain at least one user: ${filePath}`);
  return users;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args['--approve'] !== 'CREATE_READY_MARKER') {
    throw new Error('Explicit approval is required: --approve CREATE_READY_MARKER');
  }

  const rawStorageRoot = String(args['--storage-root'] || '').trim();
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

  const requiredTenants = String(args['--required-tenants'] || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (new Set(requiredTenants).size !== requiredTenants.length) throw new Error('Duplicate tenant IDs are not allowed in --required-tenants.');
  const verified = [
    { path: paths.globalDb, sha256: sha256File(paths.globalDb), bytes: fs.statSync(paths.globalDb).size },
    { path: paths.authUsers, sha256: sha256File(paths.authUsers), bytes: fs.statSync(paths.authUsers).size },
    { path: paths.authUsersBackup, sha256: sha256File(paths.authUsersBackup), bytes: fs.statSync(paths.authUsersBackup).size },
  ];

  for (const tenantId of requiredTenants) {
    const dbPath = paths.tenantDb(tenantId);
    assertDbObject(dbPath, `Tenant database ${tenantId}`, tenantId);
    verified.push({ path: dbPath, sha256: sha256File(dbPath), bytes: fs.statSync(dbPath).size });
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
