import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupDemoPlanningStorage } from '../scripts/cleanup-demo-planning-storage.mjs';

function tempLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-demo-cleanup-'));
  const storageRoot = path.join(root, 'storage');
  const backupRoot = path.join(root, 'backups');
  const tenantDir = path.join(storageRoot, 'tenants', 'demo-company');
  fs.mkdirSync(tenantDir, { recursive: true });
  return { root, storageRoot, backupRoot, dbPath: path.join(tenantDir, 'db.json') };
}

function writeDb(dbPath, payload) {
  fs.writeFileSync(dbPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

test('clears only exact trainingSchedules mirror and verified v5 timetable legacy rows', () => {
  const layout = tempLayout();
  const schedule = [
    { id: 'a', date: '2026-08-01', squadIds: ['s1'] },
    { id: 'b', date: '2026-08-02', squadIds: ['s2'] },
  ];
  writeDb(layout.dbPath, {
    __meta: { tenantId: 'demo-company', storageRevision: 7, timetableSlotsLegacyMigrationVersion: 5 },
    schedule,
    trainingSchedules: [schedule[1], schedule[0]],
    timetableSlots: [{ id: 'slot-1', dayLabel: 'Monday', startTime: '18:00', endTime: '19:00', squadIds: ['s1'] }],
    timetable: [{ id: 'legacy-1', dayLabel: 'Monday', startTime: '18:00', endTime: '19:00', squadIds: ['s1'] }],
    timetables: [
      { id: 'main', name: 'Main' },
      { id: 'legacy-embedded', dayLabel: 'Tuesday', startTime: '18:00', endTime: '19:00', squadIds: ['s2'] },
    ],
  });

  const result = cleanupDemoPlanningStorage(layout);
  assert.equal(result.changed, true);
  assert.equal(result.clearedTrainingSchedules, 2);
  assert.equal(result.clearedLegacyTimetableRows, 1);
  assert.equal(result.clearedEmbeddedTimetableRows, 1);
  assert.ok(fs.existsSync(result.backupPath));

  const written = JSON.parse(fs.readFileSync(layout.dbPath, 'utf8'));
  assert.deepEqual(written.schedule, schedule);
  assert.deepEqual(written.trainingSchedules, []);
  assert.deepEqual(written.timetable, []);
  assert.deepEqual(written.timetables, [{ id: 'main', name: 'Main' }]);
  assert.equal(written.__meta.storageRevision, 8);
  assert.equal(written.__meta.demoTrainingSchedulesMirrorCleanupVersion, 1);
  assert.equal(written.__meta.demoTimetableLegacyCleanupVersion, 1);

  const rerun = cleanupDemoPlanningStorage(layout);
  assert.equal(rerun.changed, false);
});

test('refuses non-identical trainingSchedules and pre-v5 timetable cleanup', () => {
  const layout = tempLayout();
  writeDb(layout.dbPath, {
    __meta: { tenantId: 'demo-company', storageRevision: 3 },
    schedule: [{ id: 'a', date: '2026-08-01' }],
    trainingSchedules: [{ id: 'a', date: '2026-08-99' }],
    timetable: [{ id: 'legacy-1', dayLabel: 'Monday', startTime: '18:00', endTime: '19:00', squadIds: ['s1'] }],
    timetables: [{ id: 'legacy-embedded', dayLabel: 'Tuesday', startTime: '18:00', endTime: '19:00', squadIds: ['s2'] }],
  });

  const before = fs.readFileSync(layout.dbPath, 'utf8');
  const result = cleanupDemoPlanningStorage({ ...layout, logger: { warn() {} } });
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(layout.dbPath, 'utf8'), before);
  assert.equal(fs.existsSync(layout.backupRoot), false);
});

test('refuses wrong tenant identity', () => {
  const layout = tempLayout();
  writeDb(layout.dbPath, {
    __meta: { tenantId: 'real-customer', storageRevision: 1 },
    schedule: [{ id: 'a' }],
    trainingSchedules: [{ id: 'a' }],
  });
  assert.throws(() => cleanupDemoPlanningStorage(layout), /Refusing demo cleanup/);
});
