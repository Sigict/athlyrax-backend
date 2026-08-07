import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import express from 'express';
import {
  installDataSafetyGuards,
  installExpressDbRevisionResponseGuard,
} from './data-safety-preload.mjs';
import { installDbRevisionPutResponse } from './db-revision-put-response.mjs';
import { installSignupLegalAcceptanceGuard } from './signup-legal-acceptance-preload.mjs';
import {
  resolveStorageConfiguration,
  runStorageSafetyCheck,
} from './storage-safety-lib.mjs';
import {
  assertCanonicalPathContract,
  finalizeLegacyStorageMigration,
  migrateLegacyStorageIfNeeded,
  restoreBundledDemoTenantIfNeeded,
} from './storage-path-contract.mjs';

const __filename = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(__filename), '..');
const repoRoot = sourceRoot;
const entryPath = path.join(sourceRoot, 'index.js');
const indexSource = fs.readFileSync(entryPath, 'utf8');

const initialStorageConfiguration = resolveStorageConfiguration(process.env, repoRoot);
if (initialStorageConfiguration.failures.length > 0) {
  const error = new Error(initialStorageConfiguration.failures.join('\n'));
  error.code = 'ATHLYRAX_STORAGE_CONFIGURATION_INVALID';
  throw error;
}

assertCanonicalPathContract({
  sourceRoot,
  storageRoot: initialStorageConfiguration.storageRoot,
  indexSource,
});

const legacyMigration = migrateLegacyStorageIfNeeded({
  sourceRoot,
  storageRoot: initialStorageConfiguration.storageRoot,
  backupRoot: initialStorageConfiguration.backupRoot,
});

restoreBundledDemoTenantIfNeeded({
  sourceRoot,
  storageRoot: initialStorageConfiguration.storageRoot,
  backupRoot: initialStorageConfiguration.backupRoot,
});

runStorageSafetyCheck({
  repoRoot,
  requireFiles: String(
    process.env.ATHLYRAX_CHECK_REQUIRE_FILES
      ?? (String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? 'true' : 'false'),
  ).toLowerCase() !== 'false',
  createDirectories: true,
});

finalizeLegacyStorageMigration({
  storageRoot: initialStorageConfiguration.storageRoot,
  migrationResult: legacyMigration,
});

process.env.ATHLYRAX_SAFE_START_ENFORCED = 'true';

installDataSafetyGuards();
installExpressDbRevisionResponseGuard(express);
installDbRevisionPutResponse(express);
installSignupLegalAcceptanceGuard(express);

await import(pathToFileURL(entryPath).href);
