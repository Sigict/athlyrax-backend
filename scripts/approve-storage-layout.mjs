import fs from 'node:fs';
import path from 'node:path';
import {
  sha256File,
  writeStorageReadyMarker,
} from './storage-safety-lib.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    result[argv[index]] = argv[index + 1];
  }
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args['--approve'] !== 'CREATE_READY_MARKER') {
    throw new Error('Explicit approval is required: --approve CREATE_READY_MARKER');
  }
  const storageRoot = path.resolve(String(args['--storage-root'] || ''));
  if (!storageRoot || storageRoot === path.parse(storageRoot).root) {
    throw new Error('A valid --storage-root is required.');
  }

  const globalDb = path.join(storageRoot, 'db.json');
  const authUsers = path.join(storageRoot, 'auth', 'auth-users.json');
  if (!fs.existsSync(globalDb)) throw new Error(`Missing ${globalDb}`);
  if (!fs.existsSync(authUsers)) throw new Error(`Missing ${authUsers}`);

  const requiredTenants = String(args['--required-tenants'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const verified = [
    { path: globalDb, sha256: sha256File(globalDb), bytes: fs.statSync(globalDb).size },
    { path: authUsers, sha256: sha256File(authUsers), bytes: fs.statSync(authUsers).size },
  ];

  for (const tenantId of requiredTenants) {
    if (!/^[a-zA-Z0-9._-]+$/.test(tenantId)) throw new Error(`Unsafe tenant ID: ${tenantId}`);
    const dbPath = path.join(storageRoot, 'tenants', tenantId, 'db.json');
    if (!fs.existsSync(dbPath)) throw new Error(`Missing ${dbPath}`);
    verified.push({ path: dbPath, sha256: sha256File(dbPath), bytes: fs.statSync(dbPath).size });
  }

  const markerPath = writeStorageReadyMarker(storageRoot, {
    requiredTenants,
    verifiedFiles: verified,
  });

  console.log('ATHLYRAX_STORAGE_READY_MARKER_CREATED');
  console.log(`Marker: ${markerPath}`);
  console.log(`Verified files: ${verified.length}`);
} catch (error) {
  console.error('ATHLYRAX_STORAGE_READY_MARKER_FAILED');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
