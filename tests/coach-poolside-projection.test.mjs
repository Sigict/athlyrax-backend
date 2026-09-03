import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCoachPoolsideProjection } from '../coach-poolside-projection.mjs';

test('coach Poolside projection returns only one day and linked club records', () => {
  const result = buildCoachPoolsideProjection({
    schedule: [
      { id: 'sch-1', scheduleDate: '2026-09-03', trainingSessionId: 'sess-1', squadIds: ['sq-1'] },
      { id: 'sch-2', scheduleDate: '2026-09-04', trainingSessionId: 'sess-2', squadIds: ['sq-2'] },
    ],
    trainingSessions: [
      { id: 'sess-1', scheduleId: 'sch-1', title: 'Threshold', startTime: '06:30', squadIds: ['sq-1'] },
      { id: 'sess-2', scheduleId: 'sch-2', title: 'Tomorrow', squadIds: ['sq-2'] },
    ],
    trainingSessionSets: [
      { id: 'set-1', trainingSessionId: 'sess-1', order: 1, reps: 8, distance: 100 },
      { id: 'set-2', trainingSessionId: 'sess-2', order: 1, reps: 4, distance: 50 },
    ],
    swimmers: [
      { id: 'sw-1', firstName: 'A', lastName: 'One', squadId: 'sq-1' },
      { id: 'sw-2', firstName: 'B', lastName: 'Two', squadId: 'sq-2' },
    ],
    attendance: [
      { id: 'att-1', scheduleId: 'sch-1', swimmerId: 'sw-1', status: 'present' },
      { id: 'att-2', scheduleId: 'sch-2', swimmerId: 'sw-2', status: 'present' },
    ],
  }, { date: '2026-09-03' });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, 'sess-1');
  assert.deepEqual(result.sessions[0].sets.map((row) => row.id), ['set-1']);
  assert.deepEqual(result.swimmers.map((row) => row.id), ['sw-1']);
  assert.deepEqual(result.attendance.map((row) => row.id), ['att-1']);
  assert.equal(Object.hasOwn(result, 'db'), false);
});
