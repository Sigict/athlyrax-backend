import { getCanonicalScheduleRows } from './canonicalScheduleRows.js';

const canonicalSessionMapCache = new WeakMap();
const canonicalSessionIdSetCache = new WeakMap();
const EMPTY_SESSION_ROWS = Object.freeze([]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value ?? '').trim();
}

function timestamp(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function trainingSessionScheduleId(row) {
  return text(
    row?.scheduleId
    || row?.trainingScheduleId
    || row?.scheduledSessionId
    || row?.scheduledSessionOccurrenceId
    || row?.sessionOccurrenceId
    || row?.occurrenceId
    || row?.parentOccurrenceId
  );
}

export function isDeletedTrainingSession(row) {
  if (!row || typeof row !== 'object') return true;
  if (row?.isDeleted === true || row?.deleted === true) return true;
  if (text(row?.deletedAt)) return true;
  const status = text(row?.status).toLowerCase();
  return status === 'deleted' || status === 'removed';
}

function candidateRank(row, index) {
  const updated = timestamp(row?.updatedAt || row?.modifiedAt || row?.savedAt);
  const created = timestamp(row?.createdAt);
  return { row, index, updated, created };
}

function compareCandidateRank(a, b) {
  if (a.updated !== b.updated) return a.updated - b.updated;
  if (a.created !== b.created) return a.created - b.created;
  return a.index - b.index;
}

export function dedupeTrainingSessionRowsById(rows) {
  const source = asArray(rows);
  const winners = new Map();
  source.forEach((row, index) => {
    if (!row || typeof row !== 'object' || isDeletedTrainingSession(row)) return;
    const sessionId = text(row?.id);
    if (!sessionId) return;
    const candidate = candidateRank(row, index);
    const current = winners.get(sessionId);
    if (!current || compareCandidateRank(current, candidate) < 0) winners.set(sessionId, candidate);
  });

  return Array.from(winners.values())
    .sort((a, b) => a.index - b.index)
    .map((candidate) => candidate.row);
}

export function buildCanonicalTrainingSessionMap(db) {
  const safeDb = db && typeof db === 'object' ? db : {};
  const scheduleRows = getCanonicalScheduleRows(safeDb);
  const sessionRows = Array.isArray(safeDb.trainingSessions)
    ? safeDb.trainingSessions
    : EMPTY_SESSION_ROWS;

  let bySessions = canonicalSessionMapCache.get(scheduleRows);
  if (!bySessions) {
    bySessions = new WeakMap();
    canonicalSessionMapCache.set(scheduleRows, bySessions);
  }
  const cached = bySessions.get(sessionRows);
  if (cached) return cached;

  const scheduleIds = new Set(scheduleRows.map((row) => text(row?.id)).filter(Boolean));
  const winnerByScheduleId = new Map();
  sessionRows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || isDeletedTrainingSession(row)) return;
    const sessionId = text(row?.id);
    const scheduleId = trainingSessionScheduleId(row);
    if (!sessionId || !scheduleId || !scheduleIds.has(scheduleId)) return;
    const candidate = { scheduleId, ...candidateRank(row, index) };
    const current = winnerByScheduleId.get(scheduleId);
    if (!current || compareCandidateRank(current, candidate) < 0) winnerByScheduleId.set(scheduleId, candidate);
  });

  const winnerBySessionId = new Map();
  for (const candidate of winnerByScheduleId.values()) {
    const sessionId = text(candidate?.row?.id);
    if (!sessionId) continue;
    const current = winnerBySessionId.get(sessionId);
    if (!current || compareCandidateRank(current, candidate) < 0) winnerBySessionId.set(sessionId, candidate);
  }

  const sessionByScheduleId = new Map();
  for (const candidate of winnerBySessionId.values()) {
    sessionByScheduleId.set(candidate.scheduleId, {
      ...candidate.row,
      scheduleId: candidate.scheduleId,
    });
  }

  bySessions.set(sessionRows, sessionByScheduleId);
  return sessionByScheduleId;
}

export function buildCanonicalTrainingSessionIdSet(db) {
  const sessionMap = buildCanonicalTrainingSessionMap(db);
  const cached = canonicalSessionIdSetCache.get(sessionMap);
  if (cached) return cached;
  const sessionIds = new Set(
    Array.from(sessionMap.values())
      .map((row) => text(row?.id))
      .filter(Boolean),
  );
  canonicalSessionIdSetCache.set(sessionMap, sessionIds);
  return sessionIds;
}

export function getCanonicalTrainingSessions(db) {
  return Array.from(buildCanonicalTrainingSessionMap(db).values());
}
