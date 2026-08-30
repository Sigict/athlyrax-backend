import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  beginWearableDelivery,
  buildCanonicalWearableWorkout,
  finishWearableDelivery,
  mergeWearableExecutionIntoDb,
} from '../athlete-wearable-sync.mjs';
import {
  buildTerraPlannedWorkout,
  buildTerraPlannedWorkoutRequest,
  buildTerraWidgetRequest,
  parseTerraAuthEvent,
  parseTerraPlannedWorkoutResponse,
  verifyTerraSignature,
} from '../terra-wearable-provider.mjs';

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

test('Terra planned workout preserves canonical session identity and swim distance', () => {
  const canonical = buildCanonicalWearableWorkout(fixture(), 'session-1').workout;
  const payload = buildTerraPlannedWorkout(canonical);
  assert.equal(payload.data[0].metadata.summary_id, 'session-1');
  assert.equal(payload.data[0].steps[0].exercise_type, 'SWIMMING');
  assert.equal(payload.data[0].steps[0].durations[0].duration_type, 'DISTANCE');
  assert.equal(payload.data[0].steps[0].durations[0].distance_meters, 800);
});

test('Terra provider keeps API credentials server-side and targets connected Terra user', () => {
  const request = buildTerraPlannedWorkoutRequest({
    workout: buildCanonicalWearableWorkout(fixture(), 'session-1').workout,
    terraUserId: 'terra-user-1',
    apiKey: 'secret-key',
    devId: 'dev-1',
  });
  assert.match(request.url, /\/plannedWorkout\?user_id=terra-user-1$/);
  assert.equal(request.init.headers['x-api-key'], 'secret-key');
  assert.equal(request.init.headers['dev-id'], 'dev-1');
});

test('Terra widget binds provider authentication to AthlyraX reference id', () => {
  const request = buildTerraWidgetRequest({ referenceId: 'wearable-ref-1', apiKey: 'secret-key', devId: 'dev-1' });
  assert.equal(JSON.parse(request.init.body).reference_id, 'wearable-ref-1');
  assert.match(request.url, /\/auth\/generateWidgetSession$/);
});

test('Terra webhook signature verification rejects tampered and stale events', () => {
  const rawBody = JSON.stringify({ type: 'auth', status: 'success' });
  const timestamp = 1723808700;
  const secret = 'signing-secret';
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const header = `t=${timestamp},v1=${digest}`;
  assert.equal(verifyTerraSignature({ rawBody, signatureHeader: header, signingSecret: secret, nowSeconds: timestamp }), true);
  assert.equal(verifyTerraSignature({ rawBody: `${rawBody}x`, signatureHeader: header, signingSecret: secret, nowSeconds: timestamp }), false);
  assert.equal(verifyTerraSignature({ rawBody, signatureHeader: header, signingSecret: secret, nowSeconds: timestamp + 301 }), false);
});

test('Terra successful auth and workout response map provider identity without duplicate authority', () => {
  assert.deepEqual(parseTerraAuthEvent({
    type: 'auth', status: 'success', reference_id: 'wearable-ref-1', user: { user_id: 'terra-user-1', provider: 'GARMIN', active: true },
  }), { terraUserId: 'terra-user-1', referenceId: 'wearable-ref-1', provider: 'garmin', active: true });
  assert.equal(parseTerraAuthEvent({ type: 'auth', status: 'failed' }), null);
  const parsed = parseTerraPlannedWorkoutResponse({ log_ids: ['terra-log-1'] });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.externalWorkoutId, 'terra-log-1');
});
