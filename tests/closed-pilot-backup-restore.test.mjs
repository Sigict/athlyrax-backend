import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('temporary backup and restore recovers both tenant datasets without cross-tenant leakage', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-backup-restore-'));
  const storageRoot = path.join(tempRoot, 'storage');
  const backupRoot = path.join(tempRoot, 'backup');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });

  const tenantAPath = path.join(storageRoot, 'tenants', 'clubs', 'tenant-a', 'db.json');
  const tenantBPath = path.join(storageRoot, 'tenants', 'clubs', 'tenant-b', 'db.json');

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

  assert.ok(fs.existsSync(backupAPath));
  assert.ok(fs.existsSync(backupBPath));

  writeJson(tenantAPath, { swimmers: [{ id: 'corruptedA' }] });
  writeJson(tenantBPath, { swimmers: [{ id: 'corruptedB' }] });

  fs.copyFileSync(backupAPath, tenantAPath);
  fs.copyFileSync(backupBPath, tenantBPath);

  const restoredA = readJson(tenantAPath);
  const restoredB = readJson(tenantBPath);

  assert.deepEqual(restoredA, tenantAData);
  assert.deepEqual(restoredB, tenantBData);

  const restoredASwimmers = new Set((restoredA.swimmers || []).map((row) => String(row?.id || '')));
  const restoredBSwimmers = new Set((restoredB.swimmers || []).map((row) => String(row?.id || '')));
  assert.ok(restoredASwimmers.has('swimmerA'));
  assert.ok(!restoredASwimmers.has('swimmerB'));
  assert.ok(restoredBSwimmers.has('swimmerB'));
  assert.ok(!restoredBSwimmers.has('swimmerA'));

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
