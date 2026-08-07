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
import { runStorageSafetyCheck } from './storage-safety-lib.mjs';
import {
  assertCanonicalPathContract,
  restoreBundledDemoTenantIfNeeded,
} from './storage-path-contract.mjs';

const __filename = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(__filename), '..');
const repoRoot = sourceRoot;
const entryPath = path.join(sourceRoot, 'index.js');
const indexSource = fs.readFileSync(entryPath, 'utf8');
const configuredStorageRoot = path.resolve(
  String(process.env.ATHLYRAX_STORAGE_ROOT || '').trim() || path.join(sourceRoot, 'storage'),
);
const configuredBackupRoot = path.resolve(
  String(process.env.ATHLYRAX_SAFETY_BACKUP_ROOT || '').trim() || path.join(sourceRoot, '.athlyrax-safety-backups'),
);

assertCanonicalPathContract({ sourceRoot, storageRoot: configuredStorageRoot, indexSource });

restoreBundledDemoTenantIfNeeded({
  sourceRoot,
  storageRoot: configuredStorageRoot,
  backupRoot: configuredBackupRoot,
});

runStorageSafetyCheck({
  repoRoot,
  requireFiles: String(
    process.env.ATHLYRAX_CHECK_REQUIRE_FILES
      ?? (String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? 'true' : 'false'),
  ).toLowerCase() !== 'false',
  createDirectories: true,
});

process.env.ATHLYRAX_SAFE_START_ENFORCED = 'true';

installDataSafetyGuards();
installExpressDbRevisionResponseGuard(express);
installDbRevisionPutResponse(express);
installSignupLegalAcceptanceGuard(express);

await import(pathToFileURL(entryPath).href);
