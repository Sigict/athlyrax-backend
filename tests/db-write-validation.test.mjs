import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyUndatedCleanup,
  planUndatedCleanup,
  validateDbWritePayload,
} from '../scripts/db-write-validation.mjs';

function baseDb() {
  return {
    schedules: [
      { id: 'sch-dated', date: '2026-08-03' },
      { id: 'sch-empty', date: '' },
    ],
    trainingSessions: [
      { id: 'session-group1', date: '2026-08-03', group: 'Group 1', volume: 1200 },
      { id: 'session-schedule-dated', date: '', scheduleId: 'sch-dated' },
      { id: 'session-undated', date: '', scheduleId: 'sch-empty' },
    ],
    trainingSessionSets: [
      { id: 'set-group1', trainingSessionId: 'session-group1', distance: 100, reps: 12 },
      { id: 'set-undated', trainingSessionId: 'session-undated', distance: 50, reps: 8 },
    ],
  };
}

test('valid session with direct date is accepted', () => {
  const existing = { schedules: [], trainingSessions: [], trainingSessionSets: [] };
  const incoming = {
    schedules: [],
    trainingSessions: [{ id: 's1', date: '2026-08-03' }],
    trainingSessionSets: [],
  };
  const result = validateDbWritePayload({ existingDb: existing, incomingDb: incoming });
  assert.equal(result.ok, true);
});

test('valid session linked to dated schedule is accepted', () => {
  const existing = { schedules: [], trainingSessions: [], trainingSessionSets: [] };
  const incoming = {
    schedules: [{ id: 'sch-1', date: '2026-08-03' }],
    trainingSessions: [{ id: 's1', date: '', scheduleId: 'sch-1' }],
    trainingSessionSets: [],
  };
  const result = validateDbWritePayload({ existingDb: existing, incomingDb: incoming });
  assert.equal(result.ok, true);
});

test('session without date or dated schedule is rejected', () => {
  const existing = { schedules: [], trainingSessions: [], trainingSessionSets: [] };
  const incoming = {
    schedules: [{ id: 'sch-1', date: '' }],
    trainingSessions: [{ id: 's1', date: '', scheduleId: 'sch-1' }],
    trainingSessionSets: [],
  };
  const result = validateDbWritePayload({ existingDb: existing, incomingDb: incoming });
  assert.equal(result.ok, false);
  assert.deepEqual(result.invalidUndatedSessionIds, ['s1']);
});

test('set linked to missing session is rejected', () => {
  const existing = { schedules: [], trainingSessions: [], trainingSessionSets: [] };
  const incoming = {
    schedules: [],
    trainingSessions: [{ id: 's1', date: '2026-08-03' }],
    trainingSessionSets: [{ id: 'set-orphan', trainingSessionId: 'missing-session' }],
  };
  const result = validateDbWritePayload({ existingDb: existing, incomingDb: incoming });
  assert.equal(result.ok, false);
  assert.deepEqual(result.invalidTrainingSessionSetIds, ['set-orphan']);
});

test('existing valid Group 1 sessions and volumes remain unchanged after cleanup', () => {
  const db = baseDb();
  const { cleanedDb, report } = applyUndatedCleanup(db);
  const group1Session = cleanedDb.trainingSessions.find((row) => row.id === 'session-group1');
  const group1Set = cleanedDb.trainingSessionSets.find((row) => row.id === 'set-group1');
  assert.ok(group1Session);
  assert.ok(group1Set);
  assert.equal(group1Session.volume, 1200);
  assert.equal(group1Set.reps, 12);
  assert.equal(report.deletedSessionCount, 1);
  assert.equal(report.deletedChildSetCount, 1);
});

test('no orphan child sets remain after cleanup', () => {
  const db = baseDb();
  const { cleanedDb } = applyUndatedCleanup(db);
  const sessionIds = new Set(cleanedDb.trainingSessions.map((row) => row.id));
  const orphans = cleanedDb.trainingSessionSets.filter((row) => !sessionIds.has(row.trainingSessionId || row.sessionId));
  assert.equal(orphans.length, 0);
  const postPlan = planUndatedCleanup(cleanedDb);
  assert.equal(postPlan.remainingOrphanSetCountAfterDelete, 0);
});
