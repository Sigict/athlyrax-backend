import fs from 'node:fs';
import path from 'node:path';
import { sha256File, writeStorageReadyMarker } from './storage-safety-lib.mjs';
import { canonicalStoragePaths } from './storage-path-contract.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]] = argv[index + 1];
  return result;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON: ${filePath}`);
  }
}

function assertDbObject(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  const parsed = readJson(filePath, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object: ${filePath}`);
  }
}

function assertAuthStore(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  const parsed = readJson(filePath, label);
  const users = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.users) ? parsed.users : null);
  if (!users) throw new Error(`${label} must contain a users array: ${filePath}`);
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
  assertAuthStore(paths.authUsers, 'Authentication user store');
  assertAuthStore(paths.authUsersBackup, 'Authentication user backup');

  const requiredTenants = String(args['--required-tenants'] || '').split(',').map((value) => value.trim()).filter(Boolean);
  const verified = [
    { path: paths.globalDb, sha256: sha256File(paths.globalDb), bytes: fs.statSync(paths.globalDb).size },
    { path: paths.authUsers, sha256: sha256File(paths.authUsers), bytes: fs.statSync(paths.authUsers).size },
    { path: paths.authUsersBackup, sha256: sha256File(paths.authUsersBackup), bytes: fs.statSync(paths.authUsersBackup).size },
  ];

  for (const tenantId of requiredTenants) {
    const dbPath = paths.tenantDb(tenantId);
    assertDbObject(dbPath, `Tenant database ${tenantId}`);
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
