import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertNoSymlinkStorageLayout } from '../scripts/storage-path-integrity.mjs';
import {
  activeMigrationTransactionPath,
  assertNoActiveMigrationTransaction,
  readActiveMigrationTransaction,
} from '../scripts/migration-transaction-state.mjs';

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function makeConfiguration(root) {
  const storageRoot = path.join(root, 'storage');
  const backupRoot = path.join(root, 'safety');
  fs.mkdirSync(path.join(storageRoot, 'tenants', 'demo-company'), { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'tenants', 'demo-company', 'db.json'), '{}\n');
  return { storageRoot, backupRoot };
}

test('plain production storage and backup trees pass symlink validation', () => {
  const root = tempDir('athlyrax-path-integrity-ok-');
  const configuration = makeConfiguration(root);
  assert.doesNotThrow(() => assertNoSymlinkStorageLayout(configuration));
  fs.rmSync(root, { recursive: true, force: true });
});

test('symlinked tenant content is rejected before production storage is trusted', (t) => {
  const root = tempDir('athlyrax-path-integrity-link-');
  const configuration = makeConfiguration(root);
  const outside = path.join(root, 'outside.json');
  const link = path.join(configuration.storageRoot, 'tenants', 'demo-company', 'linked.json');
  fs.writeFileSync(outside, '{}\n');
  try { fs.symlinkSync(outside, link, 'file'); }
  catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      fs.rmSync(root, { recursive: true, force: true });
      t.skip('Filesystem does not permit symlink creation for this test.');
      return;
    }
    throw error;
  }
  assert.throws(() => assertNoSymlinkStorageLayout(configuration), (error) => error?.code === 'ATHLYRAX_STORAGE_SYMLINK_BLOCKED');
  fs.rmSync(root, { recursive: true, force: true });
});

test('valid active migration journal blocks normal startup helper', () => {
  const root = tempDir('athlyrax-migration-journal-');
  const backupRoot = path.join(root, 'safety');
  fs.mkdirSync(backupRoot, { recursive: true });
  const journalPath = activeMigrationTransactionPath(backupRoot);
  fs.writeFileSync(journalPath, `${JSON.stringify({ version: 1, active: true, storageRoot: path.join(root, 'storage'), snapshotRoot: path.join(backupRoot, 'migration-transaction-snapshots', 'x') })}\n`);
  const active = readActiveMigrationTransaction(backupRoot);
  assert.equal(active.journalPath, journalPath);
  assert.throws(() => assertNoActiveMigrationTransaction(backupRoot), (error) => error?.code === 'ATHLYRAX_MIGRATION_TRANSACTION_INCOMPLETE');
  fs.rmSync(root, { recursive: true, force: true });
});

test('malformed active migration journal fails closed', () => {
  const root = tempDir('athlyrax-migration-journal-invalid-');
  const backupRoot = path.join(root, 'safety');
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(activeMigrationTransactionPath(backupRoot), '{broken', 'utf8');
  assert.throws(() => readActiveMigrationTransaction(backupRoot), (error) => error?.code === 'ATHLYRAX_MIGRATION_TRANSACTION_JOURNAL_INVALID');
  fs.rmSync(root, { recursive: true, force: true });
});
