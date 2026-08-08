import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  installDataSafetyGuards,
  runWithDatabaseRollbackAuthorization,
} from '../scripts/data-safety-preload.mjs';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

test('ordinary rollback remains blocked but exact process-local rollback restores previous logical state with a new revision', { concurrency: false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-db-rollback-'));
  const storageRoot = path.join(root, 'storage');
  const backupRoot = path.join(root, 'safety');
  const destination = path.join(storageRoot, 'tenants', 'club-a', 'db.json');
  const firstWrite = path.join(storageRoot, 'tenants', 'club-a', 'first.tmp');
  const ordinaryRollback = path.join(storageRoot, 'tenants', 'club-a', 'ordinary-rollback.tmp');
  const authorizedRollback = path.join(storageRoot, 'tenants', 'club-a', 'authorized-rollback.tmp');
  const previous = { swimmers: [], __meta: { tenantId: 'club-a', storageRevision: 4, storageUpdatedAt: '2026-01-01T00:00:00.000Z' } };
  const next = { swimmers: [{ id: 'first-swimmer' }], __meta: { tenantId: 'club-a', storageRevision: 4, storageUpdatedAt: '2026-01-02T00:00:00.000Z' } };

  writeJson(destination, previous);
  writeJson(firstWrite, next);
  const installation = installDataSafetyGuards({
    fsModule: fs,
    env: { NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: storageRoot, ATHLYRAX_SAFETY_BACKUP_ROOT: backupRoot },
    logger: { info() {}, error() {} },
  });
  try {
    fs.renameSync(firstWrite, destination);
    assert.equal(JSON.parse(fs.readFileSync(destination, 'utf8')).__meta.storageRevision, 5);

    writeJson(ordinaryRollback, previous);
    assert.throws(
      () => fs.renameSync(ordinaryRollback, destination),
      (error) => error?.code === 'ATHLYRAX_DB_TOTAL_DATA_WIPE_BLOCKED' || error?.code === 'ATHLYRAX_DB_REVISION_CONFLICT',
    );

    writeJson(authorizedRollback, previous);
    runWithDatabaseRollbackAuthorization(destination, previous, () => fs.renameSync(authorizedRollback, destination));
    const restored = JSON.parse(fs.readFileSync(destination, 'utf8'));
    assert.deepEqual(restored.swimmers, []);
    assert.equal(restored.__meta.tenantId, 'club-a');
    assert.equal(restored.__meta.storageRevision, 6);
    assert.ok(Date.parse(restored.__meta.storageUpdatedAt) > 0);
    assert.equal(fs.existsSync(path.join(backupRoot, 'pre-authorized-rollback')), true);
  } finally {
    installation.uninstall();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rollback authorization cannot be reused for a different logical payload', { concurrency: false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-db-rollback-mismatch-'));
  const storageRoot = path.join(root, 'storage');
  const destination = path.join(storageRoot, 'tenants', 'club-a', 'db.json');
  const source = path.join(storageRoot, 'tenants', 'club-a', 'mismatch.tmp');
  const previous = { swimmers: [{ id: 'old' }], __meta: { tenantId: 'club-a', storageRevision: 1 } };
  const forged = { swimmers: [{ id: 'different' }], __meta: { tenantId: 'club-a', storageRevision: 1 } };
  writeJson(destination, { swimmers: [{ id: 'live' }], __meta: { tenantId: 'club-a', storageRevision: 2 } });
  writeJson(source, forged);
  const installation = installDataSafetyGuards({
    fsModule: fs,
    env: { NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: storageRoot, ATHLYRAX_SAFETY_BACKUP_ROOT: path.join(root, 'safety') },
    logger: { info() {}, error() {} },
  });
  try {
    assert.throws(
      () => runWithDatabaseRollbackAuthorization(destination, previous, () => fs.renameSync(source, destination)),
      (error) => error?.code === 'ATHLYRAX_DB_ROLLBACK_AUTHORIZATION_MISMATCH',
    );
    assert.equal(JSON.parse(fs.readFileSync(destination, 'utf8')).swimmers[0].id, 'live');
  } finally {
    installation.uninstall();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
