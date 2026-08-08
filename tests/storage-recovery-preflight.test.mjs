import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateLegacyStorageIfNeeded } from '../scripts/storage-path-contract.mjs';

test('auth recovery refuses before canonical mutation when no independent backup exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-auth-recovery-preflight-'));
  try {
    const storageRoot = path.join(root, 'storage');
    const backupRoot = path.join(root, 'backup');
    fs.mkdirSync(storageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(storageRoot, 'auth-users.json'),
      `${JSON.stringify([{ username: 'coach-a', role: 'head-coach' }])}\n`,
      'utf8',
    );

    assert.throws(
      () => migrateLegacyStorageIfNeeded({ sourceRoot: root, storageRoot, backupRoot, logger: { info() {}, warn() {} } }),
      /no independent authentication backup is available/i,
    );

    assert.equal(fs.existsSync(path.join(storageRoot, 'auth', 'auth-users.json')), false);
    assert.equal(fs.existsSync(path.join(storageRoot, 'auth', 'auth-users.backup.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
