const trainingSetDedupeCache = new WeakMap();

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

function stableHash(value) {
  const source = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function legacyRowId(row, index) {
  return `legacy_set_${stableHash(JSON.stringify({
    index,
    sessionId: text(row?.sessionId || row?.trainingSessionId),
    scheduleId: text(row?.scheduleId),
    order: row?.order ?? row?.setOrder ?? '',
    createdAt: row?.createdAt ?? '',
    updatedAt: row?.updatedAt ?? '',
    rounds: row?.rounds ?? '',
    reps: row?.reps ?? '',
    distance: row?.distance ?? '',
    stroke: row?.stroke ?? '',
    description: row?.description ?? row?.comment ?? '',
  }))}`;
}

function canonicalizeLegacyFields(row, index) {
  const source = row && typeof row === 'object' ? row : {};
  const hasId = Boolean(text(source?.id));
  const hasRetiredAliases = ['numRounds', 'numReps', 'repCount', 'distancePerRep']
    .some((key) => Object.prototype.hasOwnProperty.call(source, key));

  // Keep already-canonical rows by reference. Planner mutation helpers depend on
  // the dedupe winner being the same physical object when collapsing duplicate
  // copies. Only legacy/idless rows need a normalized replacement object.
  if (hasId && !hasRetiredAliases) return source;

  const {
    numRounds: _numRounds,
    numReps: _numReps,
    repCount: _repCount,
    distancePerRep: _distancePerRep,
    ...rest
  } = source;

  // Retired aliases are deliberately discarded here. This boundary may preserve
  // an old physical row and give an idless row stable identity, but it must never
  // turn obsolete cached/alias values back into live Planner fields.
  return {
    ...rest,
    id: text(rest.id) || legacyRowId(source, index),
  };
}

function rank(row, index) {
  return {
    row,
    index,
    updated: timestamp(row?.updatedAt || row?.modifiedAt || row?.savedAt),
    created: timestamp(row?.createdAt),
  };
}

function compareRank(a, b) {
  if (a.updated !== b.updated) return a.updated - b.updated;
  if (a.created !== b.created) return a.created - b.created;
  return a.index - b.index;
}

export function dedupeTrainingSetRowsById(rows) {
  const source = asArray(rows);
  const cached = trainingSetDedupeCache.get(source);
  if (cached) return cached;

  const winnerById = new Map();

  source.forEach((rawRow, index) => {
    const row = canonicalizeLegacyFields(rawRow, index);
    const id = text(row?.id);
    const candidate = rank(row, index);
    const current = winnerById.get(id);
    if (!current || compareRank(current, candidate) < 0) winnerById.set(id, candidate);
  });

  const result = [...winnerById.values()]
    .sort((a, b) => a.index - b.index)
    .map((candidate) => candidate.row);
  trainingSetDedupeCache.set(source, result);
  return result;
}
