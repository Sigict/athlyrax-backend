import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginWearableDelivery,
  buildCanonicalWearableWorkout,
  finishWearableDelivery,
  mergeWearableExecutionIntoDb,
} from '../athlete-wearable-sync.mjs';

function fixture() {
  return {
    trainingSessions: [{
      id: 'session-1',
      title: 'Threshold swim',
      disciplineId: 'swimming',
      date: '2026-08-29',
      approvalStatus: 'approved',
    }],
    trainingSessionSets: [
      { id: 'set-1', trainingSessionId: 'session-1', order: 1, reps: 8, distance: 100, distanceUnit: 'm', wearableEligible: true },
      { id: 'set-private', trainingSessionId: 'session-1', order: 2, reps: 4, distance: 50, coachPrivate: true },
    ],
  };
}

test('wearable workout reuses canonical session and set ids and excludes private sets', () => {
  const result = buildCanonicalWearableWorkout(fixture(), 'session-1');
  assert.equal(result.ok, true);
  assert.equal(result.workout.sessionId, 'session-1');
  assert.deepEqual(result.workout.sets.map((row) => row.setId), ['set-1']);
});

test('retry updates one delivery record instead of duplicating workout authority', () => {
  const first = beginWearableDelivery(fixture(), { providerId: 'provider-a', sessionId: 'session-1', attemptedAt: '2026-08-29T10:00:00Z' });
  const failed = finishWearableDelivery(first.db, {
    providerId: 'provider-a',
    sessionId: 'session-1',
    ok: false,
    error: 'timeout',
    finishedAt: '2026-08-29T10:00:05Z',
  });
  const retry = beginWearableDelivery(failed.db, { providerId: 'provider-a', sessionId: 'session-1', attemptedAt: '2026-08-29T10:01:00Z' });
  const sent = finishWearableDelivery(retry.db, {
    providerId: 'provider-a',
    sessionId: 'session-1',
    ok: true,
    externalWorkoutId: 'remote-77',
    finishedAt: '2026-08-29T10:01:02Z',
  });

  assert.equal(sent.db.athleteWearableDeliveries.length, 1);
  assert.equal(sent.delivery.attemptCount, 2);
  assert.equal(sent.delivery.status, 'sent');
  assert.equal(sent.delivery.externalWorkoutId, 'remote-77');
  assert.equal(sent.db.trainingSessions.length, 1);
  assert.equal(sent.db.trainingSessions[0].wearableSync.attemptCount, 2);
});

test('wearable execution can update only canonical sets belonging to the same session', () => {
  const merged = mergeWearableExecutionIntoDb(fixture(), 'session-1', {
    sessionId: 'session-1',
    status: 'completed',
    syncedAt: '2026-08-29T11:00:00Z',
    sets: [{ setId: 'set-1', completedReps: 8, averageHr: 155 }],
  });
  assert.equal(merged.ok, true);
  assert.equal(merged.db.trainingSessionSets[0].execution.completedReps, 8);
  assert.equal(merged.db.trainingSessions[0].wearableSync.status, 'completed');

  const rejected = mergeWearableExecutionIntoDb(fixture(), 'session-1', {
    sessionId: 'session-1',
    sets: [{ setId: 'foreign-set', completedReps: 1 }],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 409);
});

test('pending athlete proposal cannot be sent to wearable', () => {
  const db = fixture();
  db.trainingSessions[0].approvalStatus = 'pending';
  const result = buildCanonicalWearableWorkout(db, 'session-1');
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
});
