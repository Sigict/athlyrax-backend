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
import { assertCanonicalPathContract } from './storage-path-contract.mjs';

const __filename = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(__filename), '..');
const repoRoot = sourceRoot;
const entryPath = path.join(sourceRoot, 'index.js');
const indexSource = fs.readFileSync(entryPath, 'utf8');

if (String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production') {
  throw new Error('Safe production start requires NODE_ENV=production. Refusing development/default mode.');
}

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

// Production startup is validation-only. It must never migrate, restore, seed,
// repair, or otherwise rewrite customer data. Any one-time canonical migration
// must be run explicitly through scripts/migrate-storage-once.mjs.
runStorageSafetyCheck({
  repoRoot,
  requireFiles: true,
  createDirectories: false,
});

process.env.ATHLYRAX_SAFE_START_ENFORCED = 'true';

installDataSafetyGuards();
installExpressDbRevisionResponseGuard(express);
installDbRevisionPutResponse(express);
installSignupLegalAcceptanceGuard(express);

await import(pathToFileURL(entryPath).href);
