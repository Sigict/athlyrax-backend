import fs from 'node:fs';
import path from 'node:path';
import { sha256File, writeStorageReadyMarker } from './storage-safety-lib.mjs';
import { canonicalStoragePaths } from './storage-path-contract.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]] = argv[index + 1];
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args['--approve'] !== 'CREATE_READY_MARKER') {
    throw new Error('Explicit approval is required: --approve CREATE_READY_MARKER');
  }
  const storageRoot = path.resolve(String(args['--storage-root'] || ''));
  if (!storageRoot || storageRoot === path.parse(storageRoot).root) throw new Error('A valid --storage-root is required.');

  const paths = canonicalStoragePaths({ sourceRoot: process.cwd(), storageRoot });
  if (!fs.existsSync(paths.globalDb)) throw new Error(`Missing ${paths.globalDb}`);
  if (!fs.existsSync(paths.authUsers)) throw new Error(`Missing ${paths.authUsers}`);

  const requiredTenants = String(args['--required-tenants'] || '').split(',').map((value) => value.trim()).filter(Boolean);
  const verified = [
    { path: paths.globalDb, sha256: sha256File(paths.globalDb), bytes: fs.statSync(paths.globalDb).size },
    { path: paths.authUsers, sha256: sha256File(paths.authUsers), bytes: fs.statSync(paths.authUsers).size },
  ];

  for (const tenantId of requiredTenants) {
    const dbPath = paths.tenantDb(tenantId);
    if (!fs.existsSync(dbPath)) throw new Error(`Missing ${dbPath}`);
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
