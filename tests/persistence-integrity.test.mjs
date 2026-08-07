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
    '// ATHLYRAX_BILLING_CATALOG_FAIL_CLOSED',
    '// ATHLYRAX_PRODUCTION_PASSWORD_RESET_NO_CONSOLE',
    '// ATHLYRAX_STRIPE_WEBHOOK_SIGNATURE_REQUIRED',
    'Snapshot submissions store is unreadable or invalid. Refusing to replace it with an empty file.',
    'Snapshot submissions in-memory state is invalid. Refusing destructive persistence.',
    'loadLatestBillingCatalogBackupStrict(',
    'no structurally valid backup is available. Refusing default bootstrap.',
    'Password reset email delivery is not configured. Refusing to expose reset code through server logs.',
    'Stripe webhook signature is required.',
  ]) {
    assert.ok(source.includes(token), `missing installed persistence guard: ${token}`);
  }
});

test('installed backend does not retain destructive snapshot fallback', () => {
  const source = read('index.js');
  assert.ok(!source.includes('writeAtomicJsonFile(SNAPSHOT_SUBMISSIONS_PATH, Array.isArray(snapshotSubmissions) ? snapshotSubmissions : [])'));
});

test('data safety layer blocks missing production db recreation and corrupt replacement', () => {
  const source = read('scripts/data-safety-preload.mjs');
  for (const token of [
    'ATHLYRAX_MISSING_DB_CREATE_BLOCKED',
    'ATHLYRAX_CURRENT_DB_INVALID',
    'ATHLYRAX_INCOMING_DB_INVALID',
    'ATHLYRAX_DB_BACKUP_VERIFICATION_FAILED',
  ]) assert.ok(source.includes(token), `missing data safety guard: ${token}`);
});

test('persistence patch is wired into postinstall', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(String(pkg?.scripts?.postinstall || ''), /patch-persistence-integrity\.mjs/);
});
