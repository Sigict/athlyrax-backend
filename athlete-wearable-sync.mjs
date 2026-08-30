const asArray = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();

function sessionIdOf(row = {}) { return text(row.id || row.sessionId || row.trainingSessionId); }
function setIdOf(row = {}) { return text(row.id || row.setId); }
function setSessionId(row = {}) { return text(row.sessionId || row.trainingSessionId || row.parentSessionId); }

export function buildCanonicalWearableWorkout(db = {}, sessionId = '') {
  const id = text(sessionId);
  const session = asArray(db.trainingSessions).find((row) => sessionIdOf(row) === id);
  if (!session) return { ok: false, status: 404, error: 'Canonical training session was not found.' };
  if (text(session.approvalStatus).toLowerCase() === 'pending') return { ok: false, status: 409, error: 'Pending athlete proposal cannot be sent to a wearable.' };
  if (text(session.approvalStatus).toLowerCase() === 'rejected') return { ok: false, status: 409, error: 'Rejected athlete proposal cannot be sent to a wearable.' };
  const sets = asArray(db.trainingSessionSets)
    .filter((row) => setSessionId(row) === id && row?.wearableEligible !== false && row?.athleteVisible !== false && row?.coachPrivate !== true)
    .sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0));
  return {
    ok: true,
    status: 200,
    workout: {
      sessionId: id,
      disciplineId: text(session.disciplineId || 'swimming'),
      title: text(session.title || session.name || 'Training session'),
      date: text(session.date || session.sessionDate),
      startTime: text(session.startTime),
      sets: sets.map((row, index) => ({
        setId: setIdOf(row), order: Number(row?.order || index + 1), title: text(row.title || row.name || `Set ${index + 1}`),
        rounds: row.rounds ?? null, reps: row.reps ?? null, distance: row.distance ?? null,
        distanceUnit: text(row.distanceUnit || 'm'), stroke: text(row.stroke), sendoff: text(row.sendoff), rest: text(row.rest), target: text(row.target),
      })).filter((row) => row.setId),
    },
  };
}

function deliveryKey(providerId, sessionId) { return `${text(providerId).toLowerCase()}:${text(sessionId)}`; }

export function beginWearableDelivery(db = {}, { providerId, sessionId, attemptedAt = '' } = {}) {
  const provider = text(providerId).toLowerCase();
  const id = text(sessionId);
  if (!provider || !id) return { ok: false, status: 400, error: 'Provider and canonical session id are required.' };
  const key = deliveryKey(provider, id);
  const rows = asArray(db.athleteWearableDeliveries);
  const previous = rows.find((row) => text(row?.key) === key) || null;
  const now = text(attemptedAt) || new Date().toISOString();
  const delivery = { ...(previous || {}), key, providerId: provider, sessionId: id, status: 'sending', attemptCount: Number(previous?.attemptCount || 0) + 1, lastAttemptAt: now, lastError: '' };
  return { ok: true, delivery, db: { ...db, athleteWearableDeliveries: [...rows.filter((row) => text(row?.key) !== key), delivery] } };
}

export function finishWearableDelivery(db = {}, { providerId, sessionId, ok, externalWorkoutId = '', error = '', finishedAt = '' } = {}) {
  const provider = text(providerId).toLowerCase();
  const id = text(sessionId);
  const key = deliveryKey(provider, id);
  const rows = asArray(db.athleteWearableDeliveries);
  const previous = rows.find((row) => text(row?.key) === key);
  if (!previous) return { ok: false, status: 409, error: 'Wearable delivery attempt was not started.' };
  const now = text(finishedAt) || new Date().toISOString();
  const delivery = {
    ...previous,
    status: ok === true ? 'sent' : 'failed',
    externalWorkoutId: ok === true ? text(externalWorkoutId || previous.externalWorkoutId) : text(previous.externalWorkoutId),
    lastError: ok === true ? '' : text(error || 'Wearable provider rejected the workout.'),
    lastSyncedAt: ok === true ? now : text(previous.lastSyncedAt),
    updatedAt: now,
  };
  const sessions = asArray(db.trainingSessions).map((row) => sessionIdOf(row) !== id ? row : ({
    ...row,
    wearableSync: {
      ...(row?.wearableSync && typeof row.wearableSync === 'object' ? row.wearableSync : {}),
      provider, status: delivery.status, attemptCount: delivery.attemptCount, externalWorkoutId: delivery.externalWorkoutId, lastError: delivery.lastError, lastSyncedAt: delivery.lastSyncedAt,
    },
  }));
  return { ok: true, delivery, db: { ...db, trainingSessions: sessions, athleteWearableDeliveries: [...rows.filter((row) => text(row?.key) !== key), delivery] } };
}

export function mergeWearableExecutionIntoDb(db = {}, sessionId = '', execution = {}) {
  const id = text(sessionId);
  if (!id || text(execution.sessionId) !== id) return { ok: false, status: 400, error: 'Wearable execution must target the same canonical session.' };
  const session = asArray(db.trainingSessions).find((row) => sessionIdOf(row) === id);
  if (!session) return { ok: false, status: 404, error: 'Canonical training session was not found.' };
  const returnedById = new Map(asArray(execution.sets).map((row) => [text(row?.setId), row]).filter(([setId]) => setId));
  const validSetIds = new Set(asArray(db.trainingSessionSets).filter((row) => setSessionId(row) === id).map(setIdOf));
  for (const setId of returnedById.keys()) if (!validSetIds.has(setId)) return { ok: false, status: 409, error: 'Wearable returned a set outside the canonical session.' };
  const now = text(execution.syncedAt) || new Date().toISOString();
  const sets = asArray(db.trainingSessionSets).map((row) => {
    if (setSessionId(row) !== id) return row;
    const returned = returnedById.get(setIdOf(row));
    return returned ? { ...row, execution: { ...returned }, updatedAt: now } : row;
  });
  const sessions = asArray(db.trainingSessions).map((row) => sessionIdOf(row) !== id ? row : ({
    ...row,
    completionStatus: text(execution.status || row.completionStatus || row.status),
    wearableSync: { ...(row?.wearableSync && typeof row.wearableSync === 'object' ? row.wearableSync : {}), status: text(execution.status || 'completed'), externalWorkoutId: text(execution.externalWorkoutId || row?.wearableSync?.externalWorkoutId), lastSyncedAt: now },
    updatedAt: now,
  }));
  return { ok: true, db: { ...db, trainingSessions: sessions, trainingSessionSets: sets } };
}
