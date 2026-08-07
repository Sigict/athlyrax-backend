import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('temporary backup and restore recovers both canonical tenant datasets without cross-tenant leakage', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-backup-restore-'));
  const storageRoot = path.join(tempRoot, 'storage');
  const backupRoot = path.join(tempRoot, 'backup');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });

  const tenantAPath = path.join(storageRoot, 'tenants', 'tenant-a', 'db.json');
  const tenantBPath = path.join(storageRoot, 'tenants', 'tenant-b', 'db.json');

  const tenantAData = {
    swimmers: [{ id: 'swimmerA', name: 'Swimmer A' }],
    squads: [{ id: 'squadA', name: 'Squad A' }],
    trainingSessions: [{ id: 'sessionA' }],
    tests: [{ id: 'testA' }],
    attendance: [{ id: 'attendanceA', swimmerId: 'swimmerA' }],
  };
  const tenantBData = {
    swimmers: [{ id: 'swimmerB', name: 'Swimmer B' }],
    squads: [{ id: 'squadB', name: 'Squad B' }],
    trainingSessions: [{ id: 'sessionB' }],
    tests: [{ id: 'testB' }],
    attendance: [{ id: 'attendanceB', swimmerId: 'swimmerB' }],
  };

  writeJson(tenantAPath, tenantAData);
  writeJson(tenantBPath, tenantBData);

  const backupAPath = path.join(backupRoot, 'tenant-a-backup.json');
  const backupBPath = path.join(backupRoot, 'tenant-b-backup.json');
  fs.copyFileSync(tenantAPath, backupAPath);
  fs.copyFileSync(tenantBPath, backupBPath);

  writeJson(tenantAPath, { swimmers: [{ id: 'corruptedA' }] });
  writeJson(tenantBPath, { swimmers: [{ id: 'corruptedB' }] });
  fs.copyFileSync(backupAPath, tenantAPath);
  fs.copyFileSync(backupBPath, tenantBPath);

  const restoredA = readJson(tenantAPath);
  const restoredB = readJson(tenantBPath);
  assert.deepEqual(restoredA, tenantAData);
  assert.deepEqual(restoredB, tenantBData);
  assert.ok((restoredA.swimmers || []).some((row) => row.id === 'swimmerA'));
  assert.ok(!(restoredA.swimmers || []).some((row) => row.id === 'swimmerB'));
  assert.ok((restoredB.swimmers || []).some((row) => row.id === 'swimmerB'));
  assert.ok(!(restoredB.swimmers || []).some((row) => row.id === 'swimmerA'));

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
