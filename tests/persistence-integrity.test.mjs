import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(process.cwd());

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('installed backend contains all persistence fail-closed guards', () => {
  const source = read('index.js');
  for (const token of [
    '// ATHLYRAX_SNAPSHOT_SUBMISSIONS_FAIL_CLOSED',
    '// ATHLYRAX_SNAPSHOT_HISTORY_NO_SILENT_TRUNCATION',
    '// ATHLYRAX_BILLING_CATALOG_FAIL_CLOSED',
    '// ATHLYRAX_PRODUCTION_PASSWORD_RESET_NO_CONSOLE',
    '// ATHLYRAX_STRIPE_WEBHOOK_SIGNATURE_REQUIRED',
    '// ATHLYRAX_DURABLE_ATOMIC_JSON_WRITES',
    'Snapshot submissions store is unreadable or invalid. Refusing to replace it with an empty file.',
    'Snapshot submissions in-memory state is invalid. Refusing destructive persistence.',
    'loadLatestBillingCatalogBackupStrict(',
    'Refusing startup-time recovery, normalization or default bootstrap.',
    'Password reset email delivery is not configured. Refusing to expose reset code through server logs.',
    'Stripe webhook signature is required.',
  ]) {
    assert.ok(source.includes(token), `missing installed persistence guard: ${token}`);
  }
});

test('installed backend does not retain destructive snapshot fallback or global history truncation', () => {
  const source = read('index.js');
  assert.ok(!source.includes('writeAtomicJsonFile(SNAPSHOT_SUBMISSIONS_PATH, Array.isArray(snapshotSubmissions) ? snapshotSubmissions : [])'));
  assert.ok(!source.includes('snapshotSubmissions.length = 5000;'));
});

test('data safety layer blocks missing production db recreation and corrupt replacement', () => {
  const source = read('scripts/data-safety-preload.mjs');
  for (const token of [
    'ATHLYRAX_MISSING_DB_CREATE_BLOCKED',
    'ATHLYRAX_CURRENT_DB_INVALID',
    'ATHLYRAX_INCOMING_DB_INVALID',
    'ATHLYRAX_BACKUP_VERIFICATION_FAILED',
  ]) assert.ok(source.includes(token), `missing data safety guard: ${token}`);
});

test('database write concurrency has one authority: exact storage revision', () => {
  const indexSource = read('index.js');
  const safetySource = read('scripts/data-safety-preload.mjs');

  for (const forbidden of [
    'const isStaleWrite =',
    'staleWriteIgnored: true',
    'getRevisionTime(payload)',
    'ATHLYRAX_STALE_WRITE_TOLERANCE_MS',
    "error.code = 'ATHLYRAX_STALE_DB_WRITE'",
  ]) {
    assert.ok(!indexSource.includes(forbidden), `index retains duplicate timestamp write authority: ${forbidden}`);
    assert.ok(!safetySource.includes(forbidden), `data-safety retains duplicate timestamp write authority: ${forbidden}`);
  }

  for (const required of [
    'const currentRevisionValue = getStorageRevision(current);',
    'const exactRevisionMatch = currentRevisionValue !== null && incomingRevision === currentRevisionValue;',
    "error.code = 'ATHLYRAX_DB_REVISION_CONFLICT'",
    'writeRevisionToIncoming(source, incoming, currentRevision + 1, expectedTenantId, fsModule);',
  ]) {
    assert.ok(safetySource.includes(required), `missing exact revision concurrency guard: ${required}`);
  }
});

test('persistence and durable-write patches are owned by the single verified build orchestrator', () => {
  const pkg = JSON.parse(read('package.json'));
  const postinstall = String(pkg?.scripts?.postinstall || '');
  assert.equal(postinstall, 'node scripts/build-production-backend.mjs');

  const build = read('scripts/build-production-backend.mjs');
  assert.match(build, /scripts\/patch-persistence-integrity\.mjs/);
  assert.match(build, /scripts\/patch-durable-storage-writes\.mjs/);
  assert.match(build, /audit-storage-paths\.mjs/);
  assert.match(build, /audit-production-transform-chain\.mjs/);
  assert.match(build, /ATHLYRAX_PRODUCTION_BACKEND_BUILD_OK/);
});
