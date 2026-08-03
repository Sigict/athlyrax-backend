import crypto from 'node:crypto';

const SCHEDULE_COLLECTION_KEYS = [
  'schedule',
  'schedules',
  'trainingSchedules',
  'trainingPlannerSchedules',
  'plannerSchedules',
  'sessionSchedules',
];

const SESSION_SCHEDULE_LINK_KEYS = [
  'scheduleId',
  'trainingScheduleId',
  'plannerScheduleId',
  'sessionScheduleId',
  'timetableId',
  'calendarScheduleId',
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeId(value) {
  const next = String(value || '').trim();
  return next || '';
}

export function hasValidIsoDate(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!/^\d{4}-\d{2}-\d{2}(?:[Tt].*)?$/.test(trimmed)) return false;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed);
}

export function getScheduleCollectionKey(dbShape) {
  for (const key of SCHEDULE_COLLECTION_KEYS) {
    if (Array.isArray(dbShape?.[key])) return key;
  }
  return null;
}

function getScheduleDateValue(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return '';
  const candidates = [row.date, row.scheduleDate, row.sessionDate, row.startDate];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function getScheduleDateMap(dbShape) {
  const key = getScheduleCollectionKey(dbShape);
  const rows = key ? asArray(dbShape?.[key]) : [];
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = normalizeId(row.id);
    if (!id) continue;
    map.set(id, hasValidIsoDate(getScheduleDateValue(row)));
  }
  return { key, map, rows };
}

export function collectSessionLinkedScheduleIds(session) {
  const linked = [];
  for (const key of SESSION_SCHEDULE_LINK_KEYS) {
    const value = normalizeId(session?.[key]);
    if (value) linked.push(value);
  }
  if (Array.isArray(session?.scheduleIds)) {
    for (const value of session.scheduleIds) {
      const normalized = normalizeId(value);
      if (normalized) linked.push(normalized);
    }
  }
  return [...new Set(linked)];
}

function getSessionRows(dbShape) {
  return asArray(dbShape?.trainingSessions)
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

function getSetRows(dbShape) {
  return asArray(dbShape?.trainingSessionSets)
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

function stableNormalize(value) {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableNormalize(value[key]);
  }
  return out;
}

function signature(value) {
  return JSON.stringify(stableNormalize(value));
}

export function analyzeUndatedSessions(dbShape) {
  const sessions = getSessionRows(dbShape);
  const sets = getSetRows(dbShape);
  const { key: scheduleCollection, map: scheduleDateMap, rows: schedules } = getScheduleDateMap(dbShape);
  const sessionIds = new Set();
  const trulyUndatedSessions = [];
  const setCountBySessionId = new Map();

  for (const row of sessions) {
    const sessionId = normalizeId(row.id);
    if (sessionId) sessionIds.add(sessionId);
  }

  let orphanSetCount = 0;
  for (const row of sets) {
    const parentId = normalizeId(row.trainingSessionId || row.sessionId);
    if (!parentId) {
      orphanSetCount += 1;
      continue;
    }
    if (!sessionIds.has(parentId)) orphanSetCount += 1;
    setCountBySessionId.set(parentId, (setCountBySessionId.get(parentId) || 0) + 1);
  }

  for (const row of sessions) {
    const sessionId = normalizeId(row.id);
    if (!sessionId) continue;
    const hasSessionDate = hasValidIsoDate(row.date);
    const linkedScheduleIds = collectSessionLinkedScheduleIds(row);
    const hasLinkedDatedSchedule = linkedScheduleIds.some((id) => scheduleDateMap.get(id) === true);
    if (!hasSessionDate && !hasLinkedDatedSchedule) {
      trulyUndatedSessions.push({
        sessionId,
        childSetCount: setCountBySessionId.get(sessionId) || 0,
        linkedScheduleIds,
        sessionDate: row.date ?? null,
      });
    }
  }

  return {
    scheduleCollection,
    counts: {
      schedules: schedules.length,
      trainingSessions: sessions.length,
      trainingSessionSets: sets.length,
      orphanSetCount,
    },
    trulyUndatedSessions,
  };
}

export function planUndatedCleanup(dbShape) {
  const analysis = analyzeUndatedSessions(dbShape);
  const deleteSessionIds = new Set(analysis.trulyUndatedSessions.map((row) => row.sessionId));
  const setRows = getSetRows(dbShape);
  const deleteSetIds = [];

  for (const row of setRows) {
    const parentId = normalizeId(row.trainingSessionId || row.sessionId);
    if (parentId && deleteSessionIds.has(parentId)) {
      const setId = normalizeId(row.id) || `set-no-id-${deleteSetIds.length + 1}`;
      deleteSetIds.push(setId);
    }
  }

  const remainingOrphanSetCountAfterDelete = analysis.counts.orphanSetCount;
  return {
    ...analysis,
    deleteSessionIds: [...deleteSessionIds],
    deleteSetIds,
    deleteSessionCount: deleteSessionIds.size,
    deleteSetCount: deleteSetIds.length,
    remainingOrphanSetCountAfterDelete,
  };
}

export function applyUndatedCleanup(dbShape) {
  const plan = planUndatedCleanup(dbShape);
  const deleteSessionIdSet = new Set(plan.deleteSessionIds);
  const sessionRows = getSessionRows(dbShape);
  const setRows = getSetRows(dbShape);

  const nextSessions = sessionRows.filter((row) => !deleteSessionIdSet.has(normalizeId(row.id)));
  const nextSets = setRows.filter((row) => !deleteSessionIdSet.has(normalizeId(row.trainingSessionId || row.sessionId)));

  const nextDb = {
    ...(dbShape && typeof dbShape === 'object' ? dbShape : {}),
    trainingSessions: nextSessions,
    trainingSessionSets: nextSets,
  };
  const post = analyzeUndatedSessions(nextDb);

  return {
    cleanedDb: nextDb,
    report: {
      deletedSessionCount: plan.deleteSessionCount,
      deletedChildSetCount: plan.deleteSetCount,
      remainingOrphanSetCount: post.counts.orphanSetCount,
      remainingTrulyUndatedSessionCount: post.trulyUndatedSessions.length,
      deletedSessionIds: plan.deleteSessionIds,
      deletedSetIds: plan.deleteSetIds,
      postHashSha256: crypto.createHash('sha256').update(JSON.stringify(nextDb)).digest('hex'),
    },
  };
}

export function validateDbWritePayload({ existingDb, incomingDb }) {
  const currentById = new Map();
  for (const row of getSessionRows(existingDb)) {
    const id = normalizeId(row.id);
    if (!id) continue;
    currentById.set(id, signature(row));
  }

  const incomingRows = getSessionRows(incomingDb);
  const { map: scheduleDateMap } = getScheduleDateMap(incomingDb);
  const invalidUndatedSessionIds = [];

  for (const row of incomingRows) {
    const sessionId = normalizeId(row.id);
    if (!sessionId) continue;
    const before = currentById.get(sessionId);
    const after = signature(row);
    const isNewOrEdited = before === undefined || before !== after;
    if (!isNewOrEdited) continue;

    const hasSessionDate = hasValidIsoDate(row.date);
    const linkedScheduleIds = collectSessionLinkedScheduleIds(row);
    const hasLinkedDatedSchedule = linkedScheduleIds.some((id) => scheduleDateMap.get(id) === true);
    if (!hasSessionDate && !hasLinkedDatedSchedule) {
      invalidUndatedSessionIds.push(sessionId);
    }
  }

  const incomingSessionIds = new Set();
  for (const row of incomingRows) {
    const id = normalizeId(row.id);
    if (id) incomingSessionIds.add(id);
  }

  const invalidTrainingSessionSetIds = [];
  for (const row of getSetRows(incomingDb)) {
    const parentId = normalizeId(row.trainingSessionId || row.sessionId);
    if (!parentId) continue;
    if (!incomingSessionIds.has(parentId)) {
      invalidTrainingSessionSetIds.push(normalizeId(row.id) || `${parentId}-missing-parent`);
    }
  }

  return {
    ok: invalidUndatedSessionIds.length < 1 && invalidTrainingSessionSetIds.length < 1,
    invalidUndatedSessionIds,
    invalidTrainingSessionSetIds,
  };
}