import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  sanitizeAttendanceState,
  sanitizeTrainingSessionSetState,
} from '../canonical-data-cleanup.mjs';

test('training set cleanup removes template-library rows and exact logical duplicates without collapsing intentional order differences', () => {
  const db = {
    trainingSessionSets: [
      { id: 'set-a-old', sessionId: 'ts-1', scheduleId: 'sch-1', order: 1, rounds: 1, reps: 8, distance: 50, stroke: 'free', energy: 'SP', updatedAt: '2026-09-20T10:00:00.000Z' },
      { id: 'set-a-new', sessionId: 'ts-1', scheduleId: 'sch-1', order: 1, rounds: 1, reps: 8, distance: 50, stroke: 'free', energy: 'SP', updatedAt: '2026-09-22T10:00:00.000Z' },
      { id: 'set-order-2', sessionId: 'ts-1', scheduleId: 'sch-1', order: 2, rounds: 1, reps: 8, distance: 50, stroke: 'free', energy: 'SP', updatedAt: '2026-09-22T10:00:00.000Z' },
      { id: 'template-a', sessionId: 'template-library', scheduleId: 'template-library', templateId: 'tmpl-1', templateKind: 'set', setName: 'Sprint', order: 1, rounds: 1, reps: 4, distance: 50, stroke: 'free', energy: 'SP' },
      { id: 'template-b', sessionId: 'template-library', scheduleId: 'template-library', templateId: 'tmpl-1', templateKind: 'set', setName: 'Sprint', order: 1, rounds: 1, reps: 4, distance: 50, stroke: 'free', energy: 'SP' },
    ],
    templateSets: [{ id: 'tmpl-1', name: 'Sprint' }],
    trainingSetBlocks: [{ id: 'block-1', setIds: ['set-a-old', 'set-order-2'] }],
    tests: [{ id: 'test-1', linkedSetId: 'set-a-old' }],
    testRepResults: [{ id: 'rep-1', setId: 'set-a-old' }],
  };

  const cleaned = sanitizeTrainingSessionSetState(db, { nowIso: '2026-09-22T20:00:00.000Z' });
  assert.equal(cleaned.changed, true);
  assert.equal(cleaned.stats.rawCount, 5);
  assert.equal(cleaned.stats.templateRowsMigrated, 2);
  assert.equal(cleaned.stats.logicalDuplicatesRemoved, 1);
  assert.equal(cleaned.stats.canonicalCount, 2);
  assert.deepEqual(cleaned.db.trainingSessionSets.map((row) => row.id), ['set-a-new', 'set-order-2']);
  assert.deepEqual(cleaned.db.trainingSetBlocks[0].setIds, ['set-a-new', 'set-order-2']);
  assert.equal(cleaned.db.tests[0].linkedSetId, 'set-a-new');
  assert.equal(cleaned.db.testRepResults[0].setId, 'set-a-new');
  assert.equal(cleaned.db.templateSets[0].rows.length, 1);
});

test('attendance cleanup uses latest mutation first and only uses marked status as a timestamp tie-break', () => {
  const db = {
    attendance: [
      { id: 'blank-old', swimmerId: 'sw-a', scheduleId: 'sch-1', status: '', updatedAt: '2026-09-20T10:00:00.000Z' },
      { id: 'marked-new', swimmerId: 'sw-a', scheduleId: 'sch-1', status: 'Present', updatedAt: '2026-09-22T10:00:00.000Z' },
      { id: 'marked-old', swimmerId: 'sw-b', scheduleId: 'sch-1', status: 'Present', updatedAt: '2026-09-20T10:00:00.000Z' },
      { id: 'blank-new', swimmerId: 'sw-b', scheduleId: 'sch-1', status: '', updatedAt: '2026-09-22T10:00:00.000Z' },
      { id: 'blank-tie', swimmerId: 'sw-c', scheduleId: 'sch-1', status: '', updatedAt: '2026-09-22T10:00:00.000Z' },
      { id: 'marked-tie', swimmerId: 'sw-c', scheduleId: 'sch-1', status: 'Absent', updatedAt: '2026-09-22T10:00:00.000Z' },
    ],
  };

  const cleaned = sanitizeAttendanceState(db, { nowIso: '2026-09-22T20:00:00.000Z' });
  assert.equal(cleaned.db.attendance.find((row) => row.swimmerId === 'sw-a')?.status, 'Present');
  assert.equal(cleaned.db.attendance.find((row) => row.swimmerId === 'sw-b')?.status, '');
  assert.equal(cleaned.db.attendance.find((row) => row.swimmerId === 'sw-c')?.status, 'Absent');
  assert.equal(cleaned.stats.canonicalCount, 3);
});

test('production transform chain carries the cleanup into the live runtime after existing hardening patches', () => {
  const build = fs.readFileSync('scripts/build-production-backend.mjs', 'utf8');
  const patch = fs.readFileSync('scripts/patch-canonical-data-cleanup.mjs', 'utf8');
  assert.match(build, /final canonical data cleanup/);
  assert.match(build, /scripts\/patch-canonical-data-cleanup\.mjs/);
  assert.match(patch, /ATHLYRAX_CANONICAL_DATA_CLEANUP_V1/);
  assert.match(patch, /sanitizeTrainingSessionSetState\(parsedDatabase\)/);
  assert.match(patch, /sanitizeAttendanceState\(setCleanup\.db\)/);
  assert.match(patch, /sanitizeTrainingSessionSetState\(safeBody\)/);
  assert.match(patch, /writeDbSnapshotIfPossible\(storagePaths\.dbPath, storagePaths\.snapshotDir\)/);
});
