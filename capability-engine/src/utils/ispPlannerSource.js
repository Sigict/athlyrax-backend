import { buildCanonicalTrainingSessionIdSet, buildCanonicalTrainingSessionMap } from './canonicalTrainingSessionLinks.js';
import { dedupeTrainingSetRowsById } from './canonicalTrainingSetRows.js';
import { resolvePlannerSetVolume } from './plannerCanonicalSession.js';
import { isMeaningfulPlannerSetRow } from './plannerSetValidity.js';
import { resolveTrainingSetsForSwimmer } from './swimmerTrainingDelivery.js';

const canonicalPlannerSetRowsCache = new WeakMap();
const plannerScopedSetRowsCache = new WeakMap();

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value ?? '').trim();
}

function setSessionId(row) {
  return text(row?.sessionId || row?.trainingSessionId);
}

function setScheduleId(row) {
  return text(row?.scheduleId || row?.trainingScheduleId || row?.scheduledSessionId || row?.scheduledSessionOccurrenceId);
}

function isCancelledSchedule(row) {
  const status = text(row?.status || row?.coverageStatus || row?.coverStatus).toLowerCase();
  return status === 'cancelled' || status === 'canceled' || status === 'deleted' || status === 'removed';
}

function setMutationTime(row) {
  for (const value of [row?.updatedAt, row?.modifiedAt, row?.savedAt, row?.createdAt]) {
    const parsed = Date.parse(text(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function collapseLegacySetRevisions(rows, explicitSetIdsBySession) {
  const winners = new Map();
  const passthrough = [];
  rows.forEach((row, index) => {
    const sessionId = setSessionId(row);
    if (sessionId && explicitSetIdsBySession.has(sessionId)) {
      passthrough.push({ row, index });
      return;
    }
    const ownerKey = sessionId ? `session:${sessionId}` : `schedule:${setScheduleId(row)}`;
    const order = Number(row?.order ?? row?.setOrder ?? row?.sequence);
    if (!ownerKey || !Number.isFinite(order) || order <= 0) {
      passthrough.push({ row, index });
      return;
    }
    const key = `${ownerKey}::order:${order}`;
    const candidate = { row, index, time: setMutationTime(row) };
    const current = winners.get(key);
    if (!current || candidate.time > current.time || (candidate.time === current.time && candidate.index > current.index)) {
      winners.set(key, candidate);
    }
  });
  return [...passthrough, ...winners.values()]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.row);
}

function filterCanonicalPlannerSetRows(safeDb, canonicalSessionIds, canonicalSessionMap) {
  const rows = dedupeTrainingSetRowsById(asArray(safeDb.trainingSessionSets));
  const activeScheduleIds = new Set(
    asArray(safeDb.schedule)
      .filter((row) => !isCancelledSchedule(row))
      .map((row) => text(row?.id || row?.scheduleId || row?.trainingScheduleId))
      .filter(Boolean),
  );
  const canonicalScheduleIds = new Set(
    Array.from(canonicalSessionMap.keys())
      .map(text)
      .filter((id) => id && activeScheduleIds.has(id)),
  );
  const knownScheduleIds = new Set(asArray(safeDb.schedule)
    .map((row) => text(row?.id || row?.scheduleId || row?.trainingScheduleId)).filter(Boolean));
  const scheduleIdBySessionId = new Map(Array.from(canonicalSessionMap.entries())
    .map(([key, session]) => [text(session?.id), text(session?.scheduleId || session?.trainingScheduleId || key)])
    .filter(([sessionId, scheduleId]) => sessionId && scheduleId));
  const explicitSetIdsBySession = new Map();
  for (const session of canonicalSessionMap.values()) {
    const sessionId = text(session?.id);
    if (!sessionId) continue;
    const hasExplicitSetAuthority = Object.prototype.hasOwnProperty.call(session || {}, 'setIds')
      || Object.prototype.hasOwnProperty.call(session || {}, 'sets');
    if (!hasExplicitSetAuthority) continue;
    const setIds = [
      ...asArray(session?.setIds).map(text),
      ...asArray(session?.sets).map((item) => text(item?.id || item?.setId || item)),
    ].filter(Boolean);
    explicitSetIdsBySession.set(sessionId, new Set(setIds));
  }

  const linkedRows = rows.filter((row) => {
    if (!isMeaningfulPlannerSetRow(row)) return false;
    const sessionId = setSessionId(row);
    const scheduleId = setScheduleId(row);
    const rowId = text(row?.id);

    // Persisted rows that still point at an old/deleted Planner session are stale.
    // Do not revive them merely because the Calendar occurrence still exists.
    if (sessionId) {
      if (!canonicalSessionIds.has(sessionId)) return false;
      if (explicitSetIdsBySession.has(sessionId) && !explicitSetIdsBySession.get(sessionId).has(rowId)) return false;
      // The current canonical session owns the schedule occurrence: judge the
      // occurrence (active vs cancelled) by the SESSION's schedule, so a stale
      // persisted set scheduleId after regeneration cannot drop the set.
      const owningScheduleId = scheduleIdBySessionId.get(sessionId);
      if (owningScheduleId) {
        // A scheduleId naming a DIFFERENT occurrence that still exists marks an
        // old revision of the set; one naming no existing occurrence is only a
        // stale link left by regeneration.
        if (scheduleId && scheduleId !== owningScheduleId && knownScheduleIds.has(scheduleId)) return false;
        return canonicalScheduleIds.has(owningScheduleId);
      }
      return !scheduleId || canonicalScheduleIds.has(scheduleId);
    }

    // Legacy schedule-only rows remain valid only for an active canonical occurrence.
    return Boolean(scheduleId) && canonicalScheduleIds.has(scheduleId);
  });

  // Older sessions did not persist an explicit setIds list. Re-saving the same
  // set position could therefore leave several historical rows attached to the
  // still-live session. The Planner displays one set per positive order slot, so
  // keep only the newest persisted revision for that slot.
  return collapseLegacySetRevisions(linkedRows, explicitSetIdsBySession);
}

/**
 * Return the exact persisted set rows owned by Training Planner.
 * trainingSessionSets is the only runtime set source. Current canonical
 * session links are preferred; a canonical Schedule occurrence is used as the
 * fallback authority only when that occurrence has no current-session set rows.
 */
export function buildPlannerAuthoritativeSetRows(db) {
  const safeDb = db && typeof db === 'object' ? db : {};
  const canonicalSessionMap = buildCanonicalTrainingSessionMap(safeDb);
  const canonicalSessionIds = buildCanonicalTrainingSessionIdSet(safeDb);
  const sourceRows = asArray(safeDb.trainingSessionSets);

  let bySessionAuthority = canonicalPlannerSetRowsCache.get(sourceRows);
  if (!bySessionAuthority) {
    bySessionAuthority = new WeakMap();
    canonicalPlannerSetRowsCache.set(sourceRows, bySessionAuthority);
  }
  const cached = bySessionAuthority.get(canonicalSessionMap);
  if (cached) return cached;

  const canonicalRows = filterCanonicalPlannerSetRows(safeDb, canonicalSessionIds, canonicalSessionMap);
  bySessionAuthority.set(canonicalSessionMap, canonicalRows);
  return canonicalRows;
}

export function buildPlannerAuthoritativeSetRowsForScope(db, { sessionId = '', scheduleId = '' } = {}) {
  const safeDb = db && typeof db === 'object' ? db : {};
  const wantedSessionId = text(sessionId);
  const wantedScheduleId = text(scheduleId);
  if (!wantedSessionId && !wantedScheduleId) return [];

  const setSource = asArray(safeDb.trainingSessionSets);
  const sessionSource = asArray(safeDb.trainingSessions);
  const scheduleSource = asArray(safeDb.schedule);
  const scopeKey = `${wantedSessionId}::${wantedScheduleId}`;

  let cache = plannerScopedSetRowsCache.get(setSource);
  if (!cache || cache.sessionSource !== sessionSource || cache.scheduleSource !== scheduleSource) {
    cache = {
      sessionSource,
      scheduleSource,
      byScope: new Map(),
    };
    plannerScopedSetRowsCache.set(setSource, cache);
  }
  if (cache.byScope.has(scopeKey)) return cache.byScope.get(scopeKey);

  // First-open path: scan only to collect the selected occurrence. Do not build
  // whole-history Map indexes before one report can display its chosen session.
  const scopedRows = setSource.filter((row) => {
    const rowSessionId = setSessionId(row);
    const rowScheduleId = setScheduleId(row);
    if (wantedSessionId && rowSessionId === wantedSessionId) return true;
    return Boolean(wantedScheduleId) && !rowSessionId && rowScheduleId === wantedScheduleId;
  });
  if (scopedRows.length === 0) {
    cache.byScope.set(scopeKey, []);
    return [];
  }

  const scopedSessionRows = sessionSource.filter((row) => {
    const rowId = text(row?.id);
    const rowScheduleId = text(
      row?.scheduleId
      || row?.trainingScheduleId
      || row?.scheduledSessionId
      || row?.scheduledSessionOccurrenceId
      || row?.sessionOccurrenceId
      || row?.occurrenceId
      || row?.parentOccurrenceId
    );
    return (wantedSessionId && rowId === wantedSessionId)
      || (wantedScheduleId && rowScheduleId === wantedScheduleId);
  });

  const resolvedScheduleIds = new Set(
    [wantedScheduleId, ...scopedSessionRows.map((row) => text(
      row?.scheduleId
      || row?.trainingScheduleId
      || row?.scheduledSessionId
      || row?.scheduledSessionOccurrenceId
      || row?.sessionOccurrenceId
      || row?.occurrenceId
      || row?.parentOccurrenceId
    ))].filter(Boolean),
  );

  const scopedScheduleRows = scheduleSource.filter((row) => (
    resolvedScheduleIds.has(text(row?.id || row?.scheduleId || row?.trainingScheduleId))
  ));

  const scopedDb = {
    ...safeDb,
    schedule: scopedScheduleRows,
    trainingSessions: scopedSessionRows,
    trainingSessionSets: scopedRows,
  };
  const canonicalSessionMap = buildCanonicalTrainingSessionMap(scopedDb);
  const canonicalSessionIds = buildCanonicalTrainingSessionIdSet(scopedDb);
  const result = filterCanonicalPlannerSetRows(scopedDb, canonicalSessionIds, canonicalSessionMap);
  cache.byScope.set(scopeKey, result);
  return result;
}

export function resolveIspPlannerSetVolume(row) {
  return Math.max(0, Number(resolvePlannerSetVolume(row)) || 0);
}

export function isIspAnalysisSnapshotCurrentForPlanner(snapshot, db) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const snapshotMs = Date.parse(text(snapshot?.updatedAt));
  if (!Number.isFinite(snapshotMs)) return false;
  const plannerTimestamps = [db?.__savedAt, db?.__meta?.updatedAt]
    .map((value) => Date.parse(text(value)))
    .filter(Number.isFinite);
  if (plannerTimestamps.length === 0) return true;
  return snapshotMs >= Math.max(...plannerTimestamps);
}


export function buildIspPlannerSetRowsForSwimmer(db, swimmerId, scope = {}) {
  const rows = scope?.sessionId || scope?.scheduleId
    ? buildPlannerAuthoritativeSetRowsForScope(db, scope)
    : buildPlannerAuthoritativeSetRows(db);
  return resolveTrainingSetsForSwimmer(rows, db, swimmerId);
}
