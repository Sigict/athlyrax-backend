import { filterSuppressedGeneratedScheduleRows } from './scheduleOccurrenceSuppressions.js';

const canonicalScheduleCache = new WeakMap();
const EMPTY_SUPPRESSIONS = Object.freeze([]);

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

function scheduleId(row) {
  return text(row?.id || row?.scheduleId || row?.trainingScheduleId);
}

function candidateRank(row, index) {
  return {
    row,
    index,
    updated: timestamp(row?.updatedAt || row?.modifiedAt || row?.savedAt),
    created: timestamp(row?.createdAt),
  };
}

function compareCandidateRank(a, b) {
  if (a.updated !== b.updated) return a.updated - b.updated;
  if (a.created !== b.created) return a.created - b.created;
  return a.index - b.index;
}

export function dedupeScheduleRowsById(rows) {
  const source = asArray(rows);
  const winnerById = new Map();

  source.forEach((row, index) => {
    const id = scheduleId(row);
    if (!id) return;
    const candidate = candidateRank(row, index);
    const current = winnerById.get(id);
    if (!current || compareCandidateRank(current, candidate) < 0) {
      winnerById.set(id, candidate);
    }
  });

  return [...winnerById.values()]
    .sort((a, b) => a.index - b.index)
    .map((candidate) => candidate.row);
}

export function getGeneratedScheduleSourceIdentity(row) {
  if (!row?.generatedByPlanner && !text(row?.generatedSourceSlotId || row?.generatedSourceScheduleId)) return '';
  const date = text(row?.scheduleDate || row?.date).slice(0, 10);
  const timetableId = text(row?.timetableId || row?.sourceTimetableId);
  const sourceSlotId = text(row?.generatedSourceSlotId || row?.generatedSourceScheduleId);
  return sourceSlotId && date ? [sourceSlotId, date, timetableId].join('::') : '';
}

export function getGeneratedScheduleStrictIdentity(row) {
  if (!row?.generatedByPlanner && !text(row?.generatedSourceSlotId || row?.generatedSourceScheduleId)) return '';
  const date = text(row?.scheduleDate || row?.date).slice(0, 10);
  if (!date) return '';
  const squadIds = asArray(row?.squadIds).map(text).filter(Boolean).sort().join('|');
  return [
    date,
    text(row?.startTime),
    text(row?.endTime),
    text(row?.venueId || row?.venue),
    text(row?.sessionTypeId || row?.trainingTypeId || row?.sessionType || row?.type),
    text(row?.timetableId || row?.sourceTimetableId),
    squadIds,
  ].join('::');
}

export function dedupeGeneratedScheduleRowsByOccurrence(rows) {
  const byId = dedupeScheduleRowsById(rows);
  const winnerBySource = new Map();
  const passthrough = [];

  byId.forEach((row, index) => {
    const generated = row?.generatedByPlanner === true || Boolean(text(row?.generatedSourceSlotId || row?.generatedSourceScheduleId));
    if (!generated) {
      passthrough.push(candidateRank(row, index));
      return;
    }

    const sourceIdentity = getGeneratedScheduleSourceIdentity(row);
    if (!sourceIdentity) return;
    const key = `source:${sourceIdentity}`;
    const candidate = candidateRank(row, index);
    const current = winnerBySource.get(key);
    if (!current || compareCandidateRank(current, candidate) < 0) winnerBySource.set(key, candidate);
  });

  return [...winnerBySource.values(), ...passthrough]
    .sort((a, b) => a.index - b.index)
    .map((candidate) => candidate.row);
}

export function getCanonicalScheduleRows(db) {
  const safeDb = db && typeof db === 'object' ? db : {};
  if (!Object.prototype.hasOwnProperty.call(safeDb, 'schedule')) return [];

  const scheduleRows = Array.isArray(safeDb.schedule) ? safeDb.schedule : EMPTY_SUPPRESSIONS;
  const suppressionRows = Array.isArray(safeDb?.__meta?.scheduleOccurrenceSuppressions)
    ? safeDb.__meta.scheduleOccurrenceSuppressions
    : EMPTY_SUPPRESSIONS;

  let bySuppressions = canonicalScheduleCache.get(scheduleRows);
  if (!bySuppressions) {
    bySuppressions = new WeakMap();
    canonicalScheduleCache.set(scheduleRows, bySuppressions);
  }
  const cached = bySuppressions.get(suppressionRows);
  if (cached) return cached;

  const canonicalRows = dedupeGeneratedScheduleRowsByOccurrence(
    filterSuppressedGeneratedScheduleRows(safeDb, scheduleRows),
  );
  bySuppressions.set(suppressionRows, canonicalRows);
  return canonicalRows;
}
