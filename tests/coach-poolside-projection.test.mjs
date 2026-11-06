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

test('poolside projection shows the real session name (Planner "Session name" is mainFocus)', () => {
  const date = '2026-11-20';
  const result = buildCoachPoolsideProjection({
    schedule: [
      { id: 'sch-a', scheduleDate: date, trainingSessionId: 'ts-a', mainFocus: 'CONSOLE TEST - not real training', startTime: '06:00' },
      { id: 'sch-b', scheduleDate: date, trainingSessionId: 'ts-b', mainFocus: 'Evening threshold', startTime: '18:00' },
      { id: 'sch-c', scheduleDate: date, trainingSessionId: 'ts-c', startTime: '12:00' },
    ],
    trainingSessions: [
      { id: 'ts-a', scheduleId: 'sch-a', mainFocus: '' },
      { id: 'ts-b', scheduleId: 'sch-b', title: 'Threshold 10x100' },
      { id: 'ts-c', scheduleId: 'sch-c' },
    ],
  }, { date });
  const byId = Object.fromEntries(result.sessions.map((s) => [s.id, s]));
  // The session row's empty name does not hide the schedule's name.
  assert.equal(byId['ts-a'].title, 'CONSOLE TEST - not real training');
  assert.equal(byId['ts-a'].titleIsPlaceholder, false);
  assert.equal(byId['ts-a'].scheduleId, 'sch-a');
  // An explicit session title wins over the schedule's name.
  assert.equal(byId['ts-b'].title, 'Threshold 10x100');
  // Only a session with no name anywhere gets the placeholder, and it is marked as one.
  assert.equal(byId['ts-c'].title, 'Training session');
  assert.equal(byId['ts-c'].titleIsPlaceholder, true);
  assert.equal(new Set(result.sessions.map((s) => s.id)).size, 3, 'three sessions on one date stay distinct');
});
