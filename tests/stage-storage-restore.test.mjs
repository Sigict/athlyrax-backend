import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

test('restore staging validates all inputs before writing any staged database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-stage-preflight-'));
  try {
    const destination = path.join(root, 'stage');
    const globalDb = path.join(root, 'global.json');
    const badTenant = path.join(root, 'tenant-bad.json');
    writeJson(globalDb, { swimmers: [{ id: 'global-row' }] });
    fs.writeFileSync(badTenant, '{invalid json', 'utf8');

    const result = spawnSync(process.execPath, [
      path.resolve('scripts/stage-storage-restore.mjs'),
      '--destination', destination,
      '--global-db', globalDb,
      '--tenant', `tenant-a=${badTenant}`,
      '--approve', 'STAGE_ONLY',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /ATHLYRAX_STORAGE_RESTORE_STAGE_FAILED/);
    assert.equal(fs.existsSync(path.join(destination, 'db.json')), false);
    assert.equal(fs.existsSync(path.join(destination, 'tenants', 'tenant-a', 'db.json')), false);
    assert.equal(fs.existsSync(path.join(destination, 'staged-restore-manifest.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
