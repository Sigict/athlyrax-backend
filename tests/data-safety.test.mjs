import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installDataSafetyGuards } from '../scripts/data-safety-preload.mjs';

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function withGuard(root, run) {
  const installation = installDataSafetyGuards({
    fsModule: fs,
    env: { ATHLYRAX_SAFETY_BACKUP_ROOT: path.join(root, 'safety') },
    logger: { info() {}, error() {} },
  });
  try { return run(); }
  finally { installation.uninstall(); }
}

test('corrupt current database is never overwritten and its bytes are backed up', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-current-');
  const destination = path.join(root, 'tenant', 'db.json');
  const source = path.join(root, 'tenant', 'db.json.tmp');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const corrupt = '{not valid json';
  fs.writeFileSync(destination, corrupt, 'utf8');
  writeJson(source, { swimmers: [], __meta: { storageRevision: 0 } });

  withGuard(root, () => {
    assert.throws(() => fs.renameSync(source, destination), (error) => error?.code === 'ATHLYRAX_CURRENT_DB_INVALID');
  });

  assert.equal(fs.readFileSync(destination, 'utf8'), corrupt);
  const backupRoot = path.join(root, 'safety', 'invalid-current-blocked');
  assert.equal(fs.existsSync(backupRoot), true);
  const scope = fs.readdirSync(backupRoot)[0];
  const backup = path.join(backupRoot, scope, fs.readdirSync(path.join(backupRoot, scope))[0]);
  assert.equal(fs.readFileSync(backup, 'utf8'), corrupt);
  fs.rmSync(root, { recursive: true, force: true });
});

test('invalid incoming database is rejected before replacement', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-incoming-');
  const destination = path.join(root, 'tenant', 'db.json');
  const source = path.join(root, 'tenant', 'db.json.tmp');
  writeJson(destination, { swimmers: [{ id: 'keep' }], __meta: { storageRevision: 3 } });
  fs.writeFileSync(source, '{invalid', 'utf8');

  withGuard(root, () => {
    assert.throws(() => fs.renameSync(source, destination), (error) => error?.code === 'ATHLYRAX_INCOMING_DB_INVALID');
  });

  assert.equal(JSON.parse(fs.readFileSync(destination, 'utf8')).swimmers[0].id, 'keep');
  fs.rmSync(root, { recursive: true, force: true });
});

test('valid matching-revision database replacement increments revision and preserves pre-write backup', { concurrency: false }, () => {
  const root = tempDir('athlyrax-data-safety-valid-');
  const destination = path.join(root, 'tenant', 'db.json');
  const source = path.join(root, 'tenant', 'db.json.tmp');
  writeJson(destination, { swimmers: [{ id: 'old' }], __meta: { storageRevision: 4 } });
  writeJson(source, { swimmers: [{ id: 'new' }], __meta: { storageRevision: 4 } });

  withGuard(root, () => fs.renameSync(source, destination));

  const next = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.equal(next.swimmers[0].id, 'new');
  assert.equal(next.__meta.storageRevision, 5);
  const backupRoot = path.join(root, 'safety', 'pre-write');
  assert.equal(fs.existsSync(backupRoot), true);
  fs.rmSync(root, { recursive: true, force: true });
});
