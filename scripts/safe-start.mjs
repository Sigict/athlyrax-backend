import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import express from 'express';
import {
  installDataSafetyGuards,
  installExpressDbRevisionResponseGuard,
} from './data-safety-preload.mjs';
import { installDbRevisionPutResponse } from './db-revision-put-response.mjs';
import { installDbDeletePersistenceGuard } from './db-delete-persistence-preload.mjs';
import {
  applyCanonicalAuthPaths,
  resolveStorageConfiguration,
  validateRequiredStorageFiles,
} from './storage-safety-lib.mjs';
import { validateAuthStoreSemanticIntegrity } from './auth-store-integrity.mjs';
import { validateInviteStoreSemanticIntegrity } from './invite-store-integrity.mjs';
import { validateTenantDatabaseSemanticIntegrity } from './tenant-db-integrity.mjs';
import { validateBillingCatalogSemanticIntegrity } from './billing-catalog-store-integrity.mjs';
import { assertCanonicalPathContract } from './storage-path-contract.mjs';
import { assertNoSymlinkStorageLayout } from './storage-path-integrity.mjs';
import { assertNoActiveMigrationTransaction } from './migration-transaction-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(__filename), '..');
const repoRoot = sourceRoot;
const entryPath = path.join(sourceRoot, 'index.js');
const indexSource = fs.readFileSync(entryPath, 'utf8');

function assertPermanentDeletionRuntimeContract(source) {
  const failures = [];
  if (!source.includes('const TOMBSTONE_MAX_ENTRIES = Number.POSITIVE_INFINITY;')) {
    failures.push('permanent tombstone retention is missing');
  }
  if (!source.includes('Tombstoned physical ids are permanent.')) {
    failures.push('same-id timestamp resurrection block is missing');
  }
  if (source.includes('tombstonesForCollection.delete(rowId)')) {
    failures.push('timestamp-based tombstone retirement is still present');
  }
  if (source.includes('if (rowMs > tombstoneMs)')) {
    failures.push('row timestamps can still override deletion tombstones');
  }
  if (!source.includes("app.post('/db/schedule-delete'")) {
    failures.push('server-authoritative Scheduled Session delete route is missing');
  }
  if (!source.includes('ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_V1')) {
    failures.push('server-authoritative Scheduled Session delete marker is missing');
  }
  if (!source.includes('Server-authoritative schedule deletion verification failed after persistence reread.')) {
    failures.push('post-write physical deletion reread verification is missing');
  }
  if (!source.includes('ATHLYRAX_SCHEDULE_DELETE_BLOCK_INTEGRITY_V1')) {
    failures.push('Scheduled Session linked-block integrity guard is missing');
  }
  if (!source.includes('const nextBlocks = blockRows.flatMap((row) => {')) {
    failures.push('Scheduled Session delete cannot preserve unrelated training-set block data');
  }
  if (source.includes('trainingSetBlocks: blockRows.filter((row) => !linkedBlockIds.has(textId(row?.id)))')) {
    failures.push('unsafe whole-block deletion is still present');
  }
  if (!source.includes('staleBlockSetReferences')) {
    failures.push('persisted linked-block set-reference verification is missing');
  }
  if (!source.includes('staleBlockOwnerReferences')) {
    failures.push('persisted linked-block owner-reference verification is missing');
  }
  if (!source.includes('trainingSchedules: []')) {
    failures.push('legacy trainingSchedules persistence retirement is missing');
  }
  if (failures.length > 0) {
    const error = new Error(`Unsafe production deletion runtime:\n- ${failures.join('\n- ')}`);
    error.code = 'ATHLYRAX_PERMANENT_DELETE_GUARD_MISSING';
    throw error;
  }
}

if (String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production') {
  throw new Error('Safe production start requires NODE_ENV=production. Refusing development/default mode.');
}

// Build/install transforms harden index.js before Render starts it. Production
// startup independently verifies the exact transformed runtime source and fails
// closed if any resurrection escape hatch, collateral block-delete path, or
// legacy Schedule store reappears.
assertPermanentDeletionRuntimeContract(indexSource);

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
  ...validateInviteStoreSemanticIntegrity(configuration, process.env, fs),
  ...validateTenantDatabaseSemanticIntegrity(configuration, process.env, fs),
  ...validateBillingCatalogSemanticIntegrity(configuration, process.env, fs),
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
installDbDeletePersistenceGuard(express);

await import(pathToFileURL(entryPath).href);
