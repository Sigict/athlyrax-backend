function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value ?? '').trim();
}

function rowTime(row, index = 0) {
  for (const value of [row?.updatedAt, row?.modifiedAt, row?.savedAt, row?.createdAt]) {
    const parsed = Date.parse(text(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return index;
}

function latest(rows) {
  let winner = null;
  asArray(rows).forEach((row, index) => {
    const candidate = { row, time: rowTime(row, index), index };
    if (!winner || candidate.time > winner.time || (candidate.time === winner.time && candidate.index > winner.index)) {
      winner = candidate;
    }
  });
  return winner?.row || null;
}

function setId(row) {
  return text(row?.setId || row?.trainingSetId || row?.parentSetId || row?.plannedSetId);
}

function swimmerId(row) {
  return text(row?.swimmerId || row?.athleteId);
}

function sessionId(row) {
  return text(row?.sessionId || row?.trainingSessionId);
}

function scheduleId(row) {
  return text(row?.scheduleId || row?.trainingScheduleId || row?.scheduledSessionId);
}

function laneToken(row) {
  return text(row?.laneId || row?.lane || row?.laneNumber || row?.laneNo);
}

function uniqueRows(groups) {
  const seen = new Set();
  const out = [];
  groups.flatMap(asArray).forEach((row) => {
    if (!row || typeof row !== 'object') return;
    const key = text(row?.id) || JSON.stringify(row);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  });
  return out;
}

function deliveryRows(db, names) {
  return uniqueRows(names.map((name) => db?.[name]));
}

function sameOccurrence(row, setRow) {
  const wantedSessionId = sessionId(setRow);
  const wantedScheduleId = scheduleId(setRow);
  const rowSessionId = sessionId(row);
  const rowScheduleId = scheduleId(row);
  if (rowSessionId && wantedSessionId) return rowSessionId === wantedSessionId;
  if (rowScheduleId && wantedScheduleId) return rowScheduleId === wantedScheduleId;
  return !rowSessionId && !rowScheduleId;
}

function assignmentContainsSwimmer(row, wantedSwimmerId) {
  if (swimmerId(row) === wantedSwimmerId) return true;
  const ids = [
    ...asArray(row?.swimmerIds),
    ...asArray(row?.athleteIds),
    ...asArray(row?.swimmers).map((item) => typeof item === 'object' ? (item?.swimmerId || item?.athleteId || item?.id) : item),
  ].map(text).filter(Boolean);
  return ids.includes(wantedSwimmerId);
}

function assignmentPosition(row, wantedSwimmerId) {
  const direct = Number(row?.laneOrder ?? row?.position ?? row?.orderInLane);
  if (Number.isFinite(direct) && direct > 0 && swimmerId(row) === wantedSwimmerId) return direct;
  const ids = [
    ...asArray(row?.swimmerIds),
    ...asArray(row?.athleteIds),
    ...asArray(row?.swimmers).map((item) => typeof item === 'object' ? (item?.swimmerId || item?.athleteId || item?.id) : item),
  ].map(text).filter(Boolean);
  const index = ids.indexOf(wantedSwimmerId);
  return index >= 0 ? index + 1 : null;
}

const DELIVERY_FIELDS = [
  'setName', 'name', 'title', 'rounds', 'reps', 'distance', 'stroke',
  'energySystem', 'energy', 'modality', 'setType', 'sendOff', 'sendOffTime',
  'rest', 'description', 'notes', 'equipment', 'targetTime',
  'targetPace', 'totalTimeSec', 'setTimeSeconds', 'deliveredVolume',
  'volumeDelivered', 'actualVolume', 'completedVolume', 'volumeSwam',
  'swamVolume', 'completedReps', 'completedRounds', 'status', 'hasResult',
];

function applyDefined(base, override) {
  if (!override || typeof override !== 'object') return { ...base };
  const next = { ...base };
  DELIVERY_FIELDS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(override, key) && override[key] !== undefined && override[key] !== null && override[key] !== '') {
      next[key] = override[key];
    }
  });
  // Read legacy poolside aliases, but normalize the resolved model to Send-off Time.
  if (Object.prototype.hasOwnProperty.call(override, 'endOff') && override?.endOff !== undefined && override?.endOff !== null && override?.endOff !== '') next.sendOff = override.endOff;
  if (Object.prototype.hasOwnProperty.call(override, 'endOffTime') && override?.endOffTime !== undefined && override?.endOffTime !== null && override?.endOffTime !== '') next.sendOffTime = override.endOffTime;
  return next;
}

export function resolveTrainingSetForSwimmer(setRow, db, wantedSwimmerId) {
  const planned = setRow && typeof setRow === 'object' ? setRow : {};
  const wanted = text(wantedSwimmerId);
  if (!wanted) return planned;

  const assignments = deliveryRows(db, [
    'trainingLaneAssignments',
    'poolsideLaneAssignments',
    'laneAssignments',
  ]).filter((row) => assignmentContainsSwimmer(row, wanted) && sameOccurrence(row, planned));
  const assignment = latest(assignments);
  const lane = laneToken(assignment);
  const laneOrder = assignment ? assignmentPosition(assignment, wanted) : null;

  const laneOverride = lane ? latest(deliveryRows(db, [
    'trainingSetLaneOverrides',
    'poolsideSetLaneOverrides',
    'setLaneOverrides',
  ]).filter((row) => setId(row) === text(planned?.id) && laneToken(row) === lane)) : null;

  const swimmerOverride = latest(deliveryRows(db, [
    'trainingSetSwimmerOverrides',
    'poolsideSetSwimmerOverrides',
    'setSwimmerOverrides',
  ]).filter((row) => setId(row) === text(planned?.id) && swimmerId(row) === wanted));

  const result = latest(deliveryRows(db, [
    'trainingSetSwimmerResults',
    'poolsideSetSwimmerResults',
    'setSwimmerResults',
  ]).filter((row) => setId(row) === text(planned?.id) && swimmerId(row) === wanted));

  let resolved = applyDefined(planned, laneOverride);
  resolved = applyDefined(resolved, swimmerOverride);
  resolved = applyDefined(resolved, result);

  const deliveryLevel = swimmerOverride || result ? 'swimmer' : (laneOverride ? 'lane' : 'planned');
  return {
    ...resolved,
    plannedSetId: text(planned?.id),
    swimmerId: wanted,
    laneId: lane || text(resolved?.laneId),
    laneOrder: laneOrder ?? resolved?.laneOrder ?? null,
    deliveryLevel,
    hasLaneOverride: Boolean(laneOverride),
    hasSwimmerOverride: Boolean(swimmerOverride),
    hasSwimmerResult: Boolean(result),
    plannedSet: planned,
    laneOverride: laneOverride || null,
    swimmerOverride: swimmerOverride || null,
    swimmerResult: result || null,
  };
}

export function resolveTrainingSetsForSwimmer(setRows, db, wantedSwimmerId) {
  return asArray(setRows).map((row) => resolveTrainingSetForSwimmer(row, db, wantedSwimmerId));
}
