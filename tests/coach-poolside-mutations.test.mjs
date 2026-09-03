import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCoachPoolsideAttendance, applyCoachPoolsideSetChange } from '../coach-poolside-mutations.mjs';

const db = {
  schedule: [{ id: 'sch-1', trainingSessionId: 'sess-1' }],
  trainingSessions: [{ id: 'sess-1', scheduleId: 'sch-1' }],
  trainingSessionSets: [{ id: 'set-1', trainingSessionId: 'sess-1', reps: 8, sendoff: 60 }],
  attendance: [{ id: 'att-1', sessionId: 'sess-1', scheduleId: 'sch-1', swimmerId: 'sw-1', status: 'absent', present: false }],
};

test('Poolside attendance updates the canonical session record and present boolean together', () => {
  const result = applyCoachPoolsideAttendance(db, { sessionId: 'sess-1', rows: [{ swimmerId: 'sw-1', status: 'present' }], updatedBy: 'coach', now: '2026-09-03T10:00:00Z' });
  assert.equal(result.ok, true);
  assert.equal(result.db.attendance[0].status, 'present');
  assert.equal(result.db.attendance[0].present, true);
  assert.equal(result.db.attendance[0].trainingSessionId, 'sess-1');
});

test('Poolside attendance can add a missing swimmer row without replacing other records', () => {
  const result = applyCoachPoolsideAttendance(db, { sessionId: 'sess-1', rows: [{ swimmerId: 'sw-2', status: 'late' }] });
  assert.equal(result.ok, true);
  assert.equal(result.db.attendance.length, 2);
  assert.equal(result.db.attendance[1].present, true);
});

test('Poolside set change mutates only the canonical linked set', () => {
  const result = applyCoachPoolsideSetChange(db, { sessionId: 'sess-1', setId: 'set-1', reps: 10, sendoffSeconds: 65, updatedBy: 'coach' });
  assert.equal(result.ok, true);
  assert.equal(result.db.trainingSessionSets[0].reps, 10);
  assert.equal(result.db.trainingSessionSets[0].sendoff, 65);
});

test('Poolside refuses an unrelated set', () => {
  const result = applyCoachPoolsideSetChange(db, { sessionId: 'other', setId: 'set-1', reps: 10, sendoffSeconds: 65 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});
