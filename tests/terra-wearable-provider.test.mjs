import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  buildTerraPlannedWorkout,
  buildTerraPlannedWorkoutRequest,
  buildTerraWidgetRequest,
  parseTerraAuthEvent,
  parseTerraPlannedWorkoutResponse,
  verifyTerraSignature,
} from '../terra-wearable-provider.mjs';

test('Terra planned workout preserves canonical session identity and converts swim distance', () => {
  const payload = buildTerraPlannedWorkout({
    sessionId: 'session-1',
    title: 'Aerobic quality',
    date: '2026-09-01',
    sets: [{ setId: 'set-1', title: 'Main set', rounds: 2, reps: 4, distance: 100, distanceUnit: 'm', stroke: 'Freestyle' }],
  });
  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0].metadata.summary_id, 'session-1');
  assert.equal(payload.data[0].steps.length, 1);
  assert.equal(payload.data[0].steps[0].exercise_type, 'SWIMMING');
  assert.equal(payload.data[0].steps[0].durations[0].duration_type, 'DISTANCE');
  assert.equal(payload.data[0].steps[0].durations[0].distance_meters, 800);
});

test('Terra planned workout converts yards to metres without mutating canonical data', () => {
  const payload = buildTerraPlannedWorkout({
    sessionId: 'session-yards',
    sets: [{ setId: 'set-y', reps: 2, distance: 100, distanceUnit: 'yd' }],
  });
  assert.equal(payload.data[0].steps[0].durations[0].distance_meters, 182.88);
});

test('Terra API requests keep credentials in backend headers', () => {
  const request = buildTerraPlannedWorkoutRequest({
    workout: { sessionId: 'session-1', sets: [] },
    terraUserId: 'terra-user-1',
    apiKey: 'secret-key',
    devId: 'dev-1',
  });
  assert.match(request.url, /\/plannedWorkout\?user_id=terra-user-1$/);
  assert.equal(request.init.headers['x-api-key'], 'secret-key');
  assert.equal(request.init.headers['dev-id'], 'dev-1');
  assert.equal(JSON.parse(request.init.body).data[0].metadata.summary_id, 'session-1');
});

test('Terra widget request binds the connection to an AthlyraX reference id', () => {
  const request = buildTerraWidgetRequest({
    referenceId: 'wearable-ref-1', apiKey: 'secret-key', devId: 'dev-1', successUrl: 'https://app.example/success', failureUrl: 'https://app.example/failure',
  });
  const body = JSON.parse(request.init.body);
  assert.match(request.url, /\/auth\/generateWidgetSession$/);
  assert.equal(body.reference_id, 'wearable-ref-1');
  assert.equal(body.auth_success_redirect_url, 'https://app.example/success');
  assert.equal(request.init.headers['x-api-key'], 'secret-key');
});

test('Terra webhook HMAC verification accepts v1 signature and rejects tampering', () => {
  const rawBody = JSON.stringify({ type: 'auth', status: 'success' });
  const timestamp = 1723808700;
  const secret = 'signing-secret';
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const header = `t=${timestamp},v1=${digest}`;
  assert.equal(verifyTerraSignature({ rawBody, signatureHeader: header, signingSecret: secret, nowSeconds: timestamp }), true);
  assert.equal(verifyTerraSignature({ rawBody: `${rawBody}x`, signatureHeader: header, signingSecret: secret, nowSeconds: timestamp }), false);
  assert.equal(verifyTerraSignature({ rawBody, signatureHeader: header, signingSecret: secret, nowSeconds: timestamp + 301 }), false);
});

test('Terra auth event parser returns only successful authenticated connections', () => {
  assert.deepEqual(parseTerraAuthEvent({
    type: 'auth', status: 'success', reference_id: 'wearable-ref-1', user: { user_id: 'terra-user-1', provider: 'GARMIN', active: true },
  }), { terraUserId: 'terra-user-1', referenceId: 'wearable-ref-1', provider: 'garmin', active: true });
  assert.equal(parseTerraAuthEvent({ type: 'auth', status: 'failed' }), null);
});

test('Terra planned workout response uses returned log id as external workout id', () => {
  assert.deepEqual(parseTerraPlannedWorkoutResponse({ log_ids: ['log-1', 'log-2'] }), {
    ok: true, externalWorkoutId: 'log-1', externalWorkoutIds: ['log-1', 'log-2'], error: '',
  });
  assert.equal(parseTerraPlannedWorkoutResponse({ message: 'failed' }).ok, false);
});
