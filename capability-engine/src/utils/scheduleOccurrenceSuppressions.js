const text = (value) => String(value ?? '').trim();
const asArray = (value) => (Array.isArray(value) ? value : []);

const suppressionArrayCache = new WeakMap();

function sourceSlotId(row) {
  return text(row?.sourceSlotId || row?.generatedSourceSlotId || row?.generatedSourceScheduleId);
}

function occurrenceDate(row) {
  return text(row?.scheduleDate || row?.date).slice(0, 10);
}

function timetableId(row) {
  return text(row?.timetableId || row?.sourceTimetableId);
}

function explicitManualScheduleRow(row) {
  return Boolean(row && typeof row === 'object' && row?.manualScheduleEntry === true);
}

function suppressionRecency(row) {
  const parsed = Date.parse(text(row?.deletedAt));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getScheduleOccurrenceIdentity(row) {
  const slotId = sourceSlotId(row);
  const date = occurrenceDate(row);
  const timetable = timetableId(row);
  if (!slotId || !date) return null;
  if (timetable) {
    return {
      identityType: 'source-slot',
      key: JSON.stringify([slotId, date, timetable]),
      sourceSlotId: slotId,
      scheduleDate: date,
      timetableId: timetable,
    };
  }
  // Older generated Schedule rows can legitimately lack timetableId even though
  // their durable source slot and occurrence date are present. A delete for such
  // a row must still suppress regeneration; otherwise the next planner refresh
  // recreates the session the coach just deleted.
  return {
    identityType: 'source-slot-date',
    key: JSON.stringify([slotId, date]),
    sourceSlotId: slotId,
    scheduleDate: date,
    timetableId: '',
  };
}

function normalizeSuppressionEntry(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const identity = getScheduleOccurrenceIdentity(row);
  if (!identity) return null;
  return { ...identity, deletedAt: text(row?.deletedAt), deletedBy: text(row?.deletedBy) };
}

function mergeSuppressionArrays(...sources) {
  const byKey = new Map();
  sources.flatMap((source) => asArray(source)).forEach((row) => {
    const normalized = normalizeSuppressionEntry(row);
    if (!normalized) return;
    const current = byKey.get(normalized.key);
    if (!current || suppressionRecency(normalized) >= suppressionRecency(current)) byKey.set(normalized.key, normalized);
  });
  return Array.from(byKey.values());
}

function buildSuppressionIndex(normalizedSuppressions) {
  const sourceSlotKeys = new Set();
  const sourceSlotDateKeys = new Set();
  for (const suppression of asArray(normalizedSuppressions)) {
    if (suppression?.identityType === 'source-slot' && suppression.key) sourceSlotKeys.add(suppression.key);
    if (suppression?.identityType === 'source-slot-date' && suppression.key) sourceSlotDateKeys.add(suppression.key);
  }
  return { sourceSlotKeys, sourceSlotDateKeys };
}

function compiledSuppressions(source) {
  const raw = Array.isArray(source)
    ? source
    : (Array.isArray(source?.__meta?.scheduleOccurrenceSuppressions)
      ? source.__meta.scheduleOccurrenceSuppressions
      : []);
  if (raw.length === 0) return { suppressions: [], index: null };
  const cached = suppressionArrayCache.get(raw);
  if (cached) return cached;
  const suppressions = mergeSuppressionArrays(raw);
  const compiled = { suppressions, index: buildSuppressionIndex(suppressions) };
  suppressionArrayCache.set(raw, compiled);
  return compiled;
}

export function mergeScheduleOccurrenceSuppressions(...sources) {
  return mergeSuppressionArrays(...sources);
}

export function getScheduleOccurrenceSuppressions(db) {
  return compiledSuppressions(db).suppressions;
}

function isScheduleOccurrenceSuppressedWithIndex(index, row) {
  if (!index || explicitManualScheduleRow(row)) return false;
  const identity = getScheduleOccurrenceIdentity(row);
  if (!identity) return false;
  if (identity.identityType === 'source-slot') {
    if (index.sourceSlotKeys.has(identity.key)) return true;
    return index.sourceSlotDateKeys.has(JSON.stringify([identity.sourceSlotId, identity.scheduleDate]));
  }
  return index.sourceSlotDateKeys.has(identity.key);
}

export function isScheduleOccurrenceSuppressed(dbOrSuppressions, row) {
  if (explicitManualScheduleRow(row)) return false;
  const { suppressions, index } = compiledSuppressions(dbOrSuppressions);
  if (suppressions.length === 0) return false;
  return isScheduleOccurrenceSuppressedWithIndex(index, row);
}

export function filterSuppressedGeneratedScheduleRows(dbOrSuppressions, rows) {
  const { suppressions, index } = compiledSuppressions(dbOrSuppressions);
  if (suppressions.length === 0) return asArray(rows);
  return asArray(rows).filter((row) => !isScheduleOccurrenceSuppressedWithIndex(index, row));
}
