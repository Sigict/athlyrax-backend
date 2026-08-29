import crypto from 'node:crypto';

const text = (value) => String(value ?? '').trim();
const asArray = (value) => Array.isArray(value) ? value : [];

export const TERRA_PROVIDER_ID = 'terra';
export const TERRA_API_BASE_URL = 'https://api.tryterra.co/v2';

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function base64url(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64url');
}

function unbase64url(value) {
  return Buffer.from(String(value ?? ''), 'base64url').toString('utf8');
}

function secureEqualText(a, b) {
  const left = Buffer.from(text(a));
  const right = Buffer.from(text(b));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function setDistanceMeters(set = {}) {
  const distance = positiveNumber(set.distance);
  const reps = positiveNumber(set.reps) || 1;
  const rounds = positiveNumber(set.rounds) || 1;
  if (!distance) return null;
  const unit = text(set.distanceUnit || 'm').toLowerCase();
  const metresPerRep = unit === 'yd' || unit === 'yard' || unit === 'yards' ? distance * 0.9144 : distance;
  return Math.round(metresPerRep * reps * rounds * 100) / 100;
}

export function buildTerraPlannedWorkout(workout = {}) {
  const sessionId = text(workout.sessionId);
  if (!sessionId) throw new Error('Canonical session id is required for Terra workout export.');
  const steps = asArray(workout.sets).map((set, index) => {
    const distanceMeters = setDistanceMeters(set);
    const descriptionParts = [
      text(set.title),
      positiveNumber(set.rounds) ? `${Number(set.rounds)} rounds` : '',
      positiveNumber(set.reps) ? `${Number(set.reps)} reps` : '',
      text(set.stroke),
      text(set.sendoff) ? `send-off ${text(set.sendoff)}` : '',
      text(set.rest) ? `rest ${text(set.rest)}` : '',
      text(set.target),
    ].filter(Boolean);
    return {
      type: 'STEP',
      order: index + 1,
      name: text(set.title || `Set ${index + 1}`),
      description: descriptionParts.join(' · '),
      intensity: 'ACTIVE',
      exercise_type: 'SWIMMING',
      durations: distanceMeters ? [{ duration_type: 'DISTANCE', distance_meters: distanceMeters }] : [],
      targets: [],
    };
  });
  return {
    data: [{
      metadata: {
        summary_id: sessionId,
        name: text(workout.title || 'AthlyraX training session'),
        planned_date: text(workout.date),
      },
      steps,
    }],
  };
}

export function buildTerraPlannedWorkoutRequest({ workout, terraUserId, apiKey, devId, apiBaseUrl = TERRA_API_BASE_URL } = {}) {
  const userId = text(terraUserId);
  const key = text(apiKey);
  const developerId = text(devId);
  if (!userId) throw new Error('Terra user id is required.');
  if (!key || !developerId) throw new Error('Terra API credentials are not configured.');
  return {
    url: `${text(apiBaseUrl).replace(/\/$/, '')}/plannedWorkout?user_id=${encodeURIComponent(userId)}`,
    init: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-api-key': key,
        'dev-id': developerId,
      },
      body: JSON.stringify(buildTerraPlannedWorkout(workout)),
    },
  };
}

export function parseTerraPlannedWorkoutResponse(payload = {}) {
  const ids = asArray(payload.log_ids).map(text).filter(Boolean);
  return {
    ok: ids.length > 0,
    externalWorkoutId: ids[0] || '',
    externalWorkoutIds: ids,
    error: ids.length > 0 ? '' : text(payload.message || payload.error || 'Terra did not return a workout log id.'),
  };
}

export function buildTerraWidgetRequest({ referenceId, apiKey, devId, successUrl = '', failureUrl = '', language = 'en', apiBaseUrl = TERRA_API_BASE_URL } = {}) {
  const reference = text(referenceId);
  const key = text(apiKey);
  const developerId = text(devId);
  if (!reference) throw new Error('AthlyraX wearable reference id is required.');
  if (!key || !developerId) throw new Error('Terra API credentials are not configured.');
  return {
    url: `${text(apiBaseUrl).replace(/\/$/, '')}/auth/generateWidgetSession`,
    init: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-api-key': key,
        'dev-id': developerId,
      },
      body: JSON.stringify({
        language: text(language || 'en') || 'en',
        reference_id: reference,
        ...(text(successUrl) ? { auth_success_redirect_url: text(successUrl) } : {}),
        ...(text(failureUrl) ? { auth_failure_redirect_url: text(failureUrl) } : {}),
      }),
    },
  };
}

export function createAthlyraxTerraReference({ username, tenantId, secret } = {}) {
  const user = text(username).toLowerCase();
  const tenant = text(tenantId);
  const key = text(secret);
  if (!user || !tenant || !key) throw new Error('Athlete username, tenant and reference secret are required.');
  const payload = base64url(JSON.stringify({ u: user, t: tenant, v: 1 }));
  const signature = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function parseAthlyraxTerraReference(referenceId, secret) {
  const reference = text(referenceId);
  const key = text(secret);
  const [payload, signature, extra] = reference.split('.');
  if (!payload || !signature || extra || !key) return null;
  const expected = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  if (!secureEqualText(signature, expected)) return null;
  try {
    const parsed = JSON.parse(unbase64url(payload));
    const username = text(parsed?.u).toLowerCase();
    const tenantId = text(parsed?.t);
    if (!username || !tenantId || Number(parsed?.v) !== 1) return null;
    return { username, tenantId };
  } catch {
    return null;
  }
}

export function upsertTerraConnection(db = {}, { username, tenantId, terraUserId, provider, referenceId, active = true, updatedAt = '' } = {}) {
  const user = text(username).toLowerCase();
  const tenant = text(tenantId);
  const terraId = text(terraUserId);
  const resource = text(provider).toLowerCase();
  if (!user || !tenant || !terraId || !resource) return { ok: false, error: 'Complete Terra connection identity is required.' };
  const rows = asArray(db.athleteWearableConnections);
  const key = `terra:${tenant}:${user}:${resource}`;
  const previous = rows.find((row) => text(row?.key) === key) || {};
  const connection = {
    ...previous,
    key,
    gateway: TERRA_PROVIDER_ID,
    provider: resource,
    username: user,
    tenantId: tenant,
    terraUserId: terraId,
    referenceId: text(referenceId),
    active: active !== false,
    updatedAt: text(updatedAt) || new Date().toISOString(),
  };
  return {
    ok: true,
    connection,
    db: { ...db, athleteWearableConnections: [...rows.filter((row) => text(row?.key) !== key), connection] },
  };
}

export function findTerraConnection(db = {}, { username, tenantId, provider = '' } = {}) {
  const user = text(username).toLowerCase();
  const tenant = text(tenantId);
  const resource = text(provider).toLowerCase();
  return asArray(db.athleteWearableConnections).find((row) => (
    text(row?.gateway).toLowerCase() === TERRA_PROVIDER_ID
    && text(row?.username).toLowerCase() === user
    && text(row?.tenantId) === tenant
    && row?.active !== false
    && (!resource || text(row?.provider).toLowerCase() === resource)
  )) || null;
}

export function verifyTerraSignature({ rawBody, signatureHeader, signingSecret, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300 } = {}) {
  const signature = text(signatureHeader);
  const secret = text(signingSecret);
  if (!signature || !secret) return false;
  const parts = signature.split(',').map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2) || '';
  const candidates = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3)).filter(Boolean);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Number(nowSeconds) - ts) > Number(toleranceSeconds)) return false;
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return candidates.some((candidate) => {
    const left = Buffer.from(candidate, 'hex');
    const right = Buffer.from(expected, 'hex');
    return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
  });
}

export function parseTerraAuthEvent(payload = {}) {
  if (text(payload.type).toLowerCase() !== 'auth' || text(payload.status).toLowerCase() !== 'success') return null;
  const user = payload.user && typeof payload.user === 'object' ? payload.user : {};
  const terraUserId = text(user.user_id);
  const referenceId = text(payload.reference_id || user.reference_id);
  const provider = text(user.provider).toLowerCase();
  if (!terraUserId || !referenceId || !provider) return null;
  return { terraUserId, referenceId, provider, active: user.active !== false };
}
