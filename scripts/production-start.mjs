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

// Production password recovery must never silently fall back to console delivery.
// If Render (or another production host) loses the explicit delivery-mode variable,
// keep reset codes on the real SMTP/email path. Local/dev entrypoints are untouched.
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

// ATHLYRAX_PRODUCTION_START_APPLIES_RUNTIME_BUILD
// Do not depend on a hosting provider rerunning npm postinstall. Cached installs,
// prebuilt deploys and provider-specific build commands can all legitimately skip
// that lifecycle hook. The production entrypoint therefore applies the verified,
// idempotent source-hardening chain itself before safe-start inspects index.js.
// This mutates only the ephemeral application checkout; persistent customer
// storage is not touched by the transformation chain.
runChecked(
  'Production runtime hardening build',
  [path.join(sourceRoot, 'scripts', 'build-production-backend.mjs')],
);

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
  // approval environment variable is an operator configuration error: refuse
  // startup until the one-time approval is removed. This prevents a lost marker
  // in a later incident from silently turning a stale environment variable into
  // authorization to run migration again.
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

// The demo-company tenant is synthetic product-demo data, not customer data.
// Recover it from the verified bundled seed when its persistent database is
// missing or contains no meaningful demo records. The recovery helper preserves
// the existing live file in the independent safety backup root before replacing
// it. Ordinary customer tenants remain fail-closed and are never auto-seeded.
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

// The only automatic planning-storage cleanup is restricted to demo-company,
// which is synthetic product-demo data. It refuses to touch a mirrored schedule
// unless schedule/trainingSchedules are exact id-for-id content mirrors, and it
// only removes legacy timetable copies after canonical timetable migration v5 is
// already confirmed. Every mutation takes and verifies an independent backup.
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

// Older live instances created a storage-ready marker with the previous marker
// schema. The Render shell attaches to the currently live instance, so an old
// shell cannot create a marker understood by the new release. If the marker is
// absent or not bound to the configured canonical root, regenerate it using the
// current approval script. That script validates the global DB, auth primary and
// backup parity, billing/invite/snapshot stores, and every auth-bound tenant DB
// before atomically replacing the marker. It never seeds ordinary customer data.
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
