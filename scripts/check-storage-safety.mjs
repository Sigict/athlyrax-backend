import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  applyCanonicalAuthPaths,
  resolveStorageConfiguration,
  runStorageSafetyCheck,
  validateRequiredStorageFiles,
} from './storage-safety-lib.mjs';
import { assertNoSymlinkStorageLayout } from './storage-path-integrity.mjs';
import { assertNoActiveMigrationTransaction } from './migration-transaction-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const production = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

try {
  if (!production) {
    runStorageSafetyCheck({
      repoRoot,
      requireFiles: String(process.env.ATHLYRAX_CHECK_REQUIRE_FILES ?? 'false').toLowerCase() !== 'false',
      createDirectories: true,
    });
  } else {
    const configuration = resolveStorageConfiguration(process.env, repoRoot);
    if (configuration.failures.length > 0) throw new Error(configuration.failures.join('\n'));
    for (const directory of [configuration.storageRoot, configuration.backupRoot]) {
      if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error(`Required storage directory is missing: ${directory}`);
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    }
    assertNoSymlinkStorageLayout(configuration, fs);
    assertNoActiveMigrationTransaction(configuration.backupRoot, fs);
    process.env.ATHLYRAX_STORAGE_ROOT = configuration.storageRoot;
    process.env.ATHLYRAX_SAFETY_BACKUP_ROOT = configuration.backupRoot;
    applyCanonicalAuthPaths(configuration, process.env);
    const failures = validateRequiredStorageFiles(configuration, process.env, fs);
    if (failures.length > 0) {
      const error = new Error(failures.join('\n'));
      error.code = 'ATHLYRAX_STORAGE_NOT_READY';
      throw error;
    }
    console.log('[storage-safety] ATHLYRAX_STORAGE_SAFETY_OK');
  }
} catch (error) {
  console.error('ATHLYRAX_STORAGE_SAFETY_CHECK_FAILED');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
