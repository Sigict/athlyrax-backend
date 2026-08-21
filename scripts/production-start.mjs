import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveStorageConfiguration } from './storage-safety-lib.mjs';
import { canonicalStoragePaths, restoreBundledDemoTenantIfNeeded } from './storage-path-contract.mjs';
import { readActiveMigrationTransaction } from './migration-transaction-state.mjs';
import { cleanupDemoPlanningStorage } from './cleanup-demo-planning-storage.mjs';

const APPROVAL = 'MIGRATE_CANONICAL_STORAGE_ONCE';
const READY_MARKER_APPROVAL = 'CREATE_READY_MARKER';
const __filename = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(__filename), '..');
const approval = String(process.env.ATHLYRAX_STORAGE_MIGRATION_APPROVAL || '').trim();

if (!String(process.env.AUTH_PASSWORD_RESET_DELIVERY || '').trim()) {
  process.env.AUTH_PASSWORD_RESET_DELIVERY = 'smtp';
}

function migrationAlreadyCompleted(markerPath) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return marker && marker.version === 1 && marker.completed === true;
  } catch {
    return false;
  }
}

function readyMarkerMatchesStorageRoot(markerPath, storageRoot) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return Boolean(
      marker
      && marker.version === 1
      && marker.approved === true
      && marker.storageRoot
      && path.resolve(marker.storageRoot) === path.resolve(storageRoot)
    );
  } catch {
    return false;
  }
}

function runChecked(label, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: sourceRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

function runtimeAlreadyHardened() {
  const entryPath = path.join(sourceRoot, 'index.js');
  const source = fs.readFileSync(entryPath, 'utf8');
  return [
    'installSignupLegalAcceptanceGuard(express);',
    'ATHLYRAX_CANONICAL_STORAGE_RUNTIME_GUARD',
    'const TOMBSTONE_MAX_ENTRIES = Number.POSITIVE_INFINITY;',
    'Tombstoned physical ids are permanent.',
    'ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_V1',
    'ATHLYRAX_SCHEDULE_DELETE_BLOCK_INTEGRITY_V1',
    'ATHLYRAX_SCHEDULE_SUPPRESSION_BLOCK_OWNER_INTEGRITY_V1',
    'ATHLYRAX_LEGACY_TRAINING_SCHEDULES_RETIRED_V1',
  ].every((token) => source.includes(token));
}

// ATHLYRAX_PRODUCTION_START_APPLIES_RUNTIME_BUILD
// postinstall normally prepares index.js. Some hosts can legitimately skip
// lifecycle hooks, so production start verifies the installed runtime and only
// runs the one-shot transform chain when the hardened markers are absent.
// Never re-run the chain over an already transformed backend: several historic
// source transforms are intentionally one-shot and a second pass can fail before
// the new instance becomes healthy, leaving the previous Render deploy serving.
if (!runtimeAlreadyHardened()) {
  runChecked(
    'Production runtime hardening build',
    [path.join(sourceRoot, 'scripts', 'build-production-backend.mjs')],
  );
}

if (approval && approval !== APPROVAL) {
  throw new Error(`ATHLYRAX_STORAGE_MIGRATION_APPROVAL has an invalid value. Expected ${APPROVAL} or leave it unset.`);
}

if (approval === APPROVAL) {
  const configuration = resolveStorageConfiguration(process.env, sourceRoot);
  if (configuration.failures.length > 0) throw new Error(configuration.failures.join('\n'));
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot: configuration.storageRoot });
  const interrupted = readActiveMigrationTransaction(configuration.backupRoot, fs);
  const completed = migrationAlreadyCompleted(paths.legacyMigrationMarker);

  // ATHLYRAX_ONE_TIME_MIGRATION_APPROVAL_MUST_BE_REMOVED
  // Crash recovery takes priority. Otherwise a completed migration plus the
  // approval environment variable is an operator configuration error.
  if (interrupted) {
    console.log('[storage] Interrupted migration transaction detected. Running approved recovery before normal startup.');
    runChecked(
      'Approved one-time storage migration/recovery',
      [path.join(sourceRoot, 'scripts', 'migrate-storage-once.mjs'), '--approve', APPROVAL],
    );
  } else if (completed) {
    throw new Error('Canonical storage migration is already complete. Remove ATHLYRAX_STORAGE_MIGRATION_APPROVAL before normal production startup.');
  } else {
    console.log('[storage] Explicit one-time migration approval detected. Running canonical storage migration before normal startup.');
    runChecked(
      'Approved one-time storage migration/recovery',
      [path.join(sourceRoot, 'scripts', 'migrate-storage-once.mjs'), '--approve', APPROVAL],
    );
  }
}

const runtimeConfiguration = resolveStorageConfiguration(process.env, sourceRoot);
if (runtimeConfiguration.failures.length > 0) throw new Error(runtimeConfiguration.failures.join('\n'));
const demoRecovery = restoreBundledDemoTenantIfNeeded({
  sourceRoot,
  storageRoot: runtimeConfiguration.storageRoot,
  backupRoot: runtimeConfiguration.backupRoot,
  logger: console,
});
if (demoRecovery.restored) {
  console.log(`[storage] Verified synthetic demo tenant recovery completed (${demoRecovery.bytes} bytes).`);
}

const demoPlanningCleanup = cleanupDemoPlanningStorage({
  storageRoot: runtimeConfiguration.storageRoot,
  backupRoot: runtimeConfiguration.backupRoot,
  logger: console,
});
if (demoPlanningCleanup.changed) {
  console.log(
    `[planning-cleanup] demo-company cleaned: trainingSchedules=${demoPlanningCleanup.clearedTrainingSchedules}, `
    + `timetable=${demoPlanningCleanup.clearedLegacyTimetableRows}, embeddedTimetable=${demoPlanningCleanup.clearedEmbeddedTimetableRows}, `
    + `revision=${demoPlanningCleanup.storageRevision}`,
  );
}

if (!readyMarkerMatchesStorageRoot(runtimeConfiguration.readyMarkerPath, runtimeConfiguration.storageRoot)) {
  console.log('[storage] Storage-ready marker is absent or uses a legacy binding. Re-validating canonical storage before startup.');
  runChecked(
    'Canonical storage-ready marker approval',
    [
      path.join(sourceRoot, 'scripts', 'approve-storage-layout.mjs'),
      '--approve', READY_MARKER_APPROVAL,
      '--storage-root', runtimeConfiguration.storageRoot,
      '--required-tenants', 'demo-company',
    ],
  );
}

await import(pathToFileURL(path.join(sourceRoot, 'scripts', 'safe-start.mjs')).href);
