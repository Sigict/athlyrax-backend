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
  applyCanonicalAuthPaths,
  resolveStorageConfiguration,
  validateRequiredStorageFiles,
} from './storage-safety-lib.mjs';
import { validateAuthStoreSemanticIntegrity } from './auth-store-integrity.mjs';
import { assertCanonicalPathContract } from './storage-path-contract.mjs';
import { assertNoSymlinkStorageLayout } from './storage-path-integrity.mjs';
import { assertNoActiveMigrationTransaction } from './migration-transaction-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(__filename), '..');
const repoRoot = sourceRoot;
const entryPath = path.join(sourceRoot, 'index.js');
const indexSource = fs.readFileSync(entryPath, 'utf8');

if (String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production') {
  throw new Error('Safe production start requires NODE_ENV=production. Refusing development/default mode.');
}

const configuration = resolveStorageConfiguration(process.env, repoRoot);
if (configuration.failures.length > 0) {
  const error = new Error(configuration.failures.join('\n'));
  error.code = 'ATHLYRAX_STORAGE_CONFIGURATION_INVALID';
  throw error;
}

assertCanonicalPathContract({
  sourceRoot,
  storageRoot: configuration.storageRoot,
  indexSource,
});

// Normal production startup is strictly read-only with respect to persistent
// storage. It does not mkdir, probe-write, seed, restore, migrate or repair.
for (const [directory, label] of [
  [configuration.storageRoot, 'Primary storage root'],
  [configuration.backupRoot, 'Safety backup root'],
]) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    const error = new Error(`${label} is missing or is not a directory: ${directory}`);
    error.code = 'ATHLYRAX_STORAGE_ROOT_MISSING';
    throw error;
  }
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
}

assertNoSymlinkStorageLayout(configuration, fs);
assertNoActiveMigrationTransaction(configuration.backupRoot, fs);

process.env.ATHLYRAX_STORAGE_ROOT = configuration.storageRoot;
process.env.ATHLYRAX_SAFETY_BACKUP_ROOT = configuration.backupRoot;
applyCanonicalAuthPaths(configuration, process.env);

const storageFailures = [
  ...validateRequiredStorageFiles(configuration, process.env, fs),
  ...validateAuthStoreSemanticIntegrity(configuration, process.env, fs),
];
if (storageFailures.length > 0) {
  const error = new Error(storageFailures.join('\n'));
  error.code = 'ATHLYRAX_STORAGE_NOT_READY';
  throw error;
}

console.info(`[storage-safety] Primary storage root: ${configuration.storageRoot}`);
console.info(`[storage-safety] Safety backup root: ${configuration.backupRoot}`);
console.info('[storage-safety] ATHLYRAX_STORAGE_SAFETY_OK');

globalThis[Symbol.for('athlyrax.safeStartEnforced')] = true;

installDataSafetyGuards();
installExpressDbRevisionResponseGuard(express);
installDbRevisionPutResponse(express);
installSignupLegalAcceptanceGuard(express);

await import(pathToFileURL(entryPath).href);
