import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveStorageConfiguration } from './storage-safety-lib.mjs';
import { canonicalStoragePaths } from './storage-path-contract.mjs';

const APPROVAL = 'MIGRATE_CANONICAL_STORAGE_ONCE';
const __filename = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(__filename), '..');
const approval = String(process.env.ATHLYRAX_STORAGE_MIGRATION_APPROVAL || '').trim();

function migrationAlreadyCompleted(markerPath) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return marker && marker.version === 1 && marker.completed === true;
  } catch {
    return false;
  }
}

if (approval && approval !== APPROVAL) {
  throw new Error(`ATHLYRAX_STORAGE_MIGRATION_APPROVAL has an invalid value. Expected ${APPROVAL} or leave it unset.`);
}

if (approval === APPROVAL) {
  const configuration = resolveStorageConfiguration(process.env, sourceRoot);
  if (configuration.failures.length > 0) {
    throw new Error(configuration.failures.join('\n'));
  }
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot: configuration.storageRoot });
  if (!migrationAlreadyCompleted(paths.legacyMigrationMarker)) {
    console.log('[storage] Explicit one-time migration approval detected. Running canonical storage migration before normal startup.');
    const result = spawnSync(
      process.execPath,
      [path.join(sourceRoot, 'scripts', 'migrate-storage-once.mjs'), '--approve', APPROVAL],
      { cwd: sourceRoot, env: process.env, stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Approved one-time storage migration failed with exit code ${result.status}.`);
  } else {
    console.log('[storage] One-time storage migration is already finalized. No migration or recovery mutation will run.');
  }
}

await import(pathToFileURL(path.join(sourceRoot, 'scripts', 'safe-start.mjs')).href);
