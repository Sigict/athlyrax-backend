const text = (value) => String(value ?? '').trim();
const asArray = (value) => (Array.isArray(value) ? value : []);

function unique(values) {
  return Array.from(new Set(values.map(text).filter(Boolean)));
}

function normalizeDate(value) {
  const raw = text(value);
  if (!raw) return '';
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function normalizeTime(value) {
  const raw = text(value);
  const match = raw.match(/^(\d{1,2})[.:](\d{2})(?::(\d{2}))?$/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return '';
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return '';
  if (!Number.isInteger(second) || second < 0 || second > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function scheduleDate(row) {
  return normalizeDate(row?.scheduleDate || row?.rawDate || row?.date || row?.plannedDate);
}

function sourceSlotId(row) {
  return text(row?.generatedSourceSlotId || row?.generatedSourceScheduleId || row?.timetableSlotId || row?.sourceSlotId);
}

function timetableId(row) {
  return text(row?.timetableId || row?.timetableSourceId);
}

function venueId(row) {
  return text(row?.venueId || row?.venue);
}

function sessionTypeId(row) {
  return text(row?.sessionTypeId || row?.trainingTypeId || row?.sessionType || row?.type);
}

function squadIds(row) {
  return unique([
    ...asArray(row?.squadIds),
    row?.squadId,
    row?.squad,
  ]).sort();
}

function firstValue(scheduleRow, linkedSessions, resolver) {
  const own = resolver(scheduleRow);
  if (own) return own;
  for (const row of linkedSessions) {
    const value = resolver(row);
    if (value) return value;
  }
  return '';
}

function buildOccurrenceIdentity(scheduleRow, linkedSessions) {
  if (!scheduleRow || typeof scheduleRow !== 'object') return null;
  const scheduleId = text(scheduleRow?.id);
  if (!scheduleId) return null;
  const date = firstValue(scheduleRow, linkedSessions, scheduleDate);
  const slot = firstValue(scheduleRow, linkedSessions, sourceSlotId);
  const timetable = firstValue(scheduleRow, linkedSessions, timetableId);
  const startTime = firstValue(scheduleRow, linkedSessions, (row) => normalizeTime(row?.startTime));
  const endTime = firstValue(scheduleRow, linkedSessions, (row) => normalizeTime(row?.endTime));
  const venue = firstValue(scheduleRow, linkedSessions, venueId);
  const type = firstValue(scheduleRow, linkedSessions, sessionTypeId);
  const squads = unique([
    ...squadIds(scheduleRow),
    ...linkedSessions.flatMap((row) => squadIds(row)),
  ]).sort();
  const manual = scheduleRow?.manualScheduleEntry === true;

  const sourceKey = slot && date && timetable
    ? `source-slot:${slot}:${date}:${timetable}`
    : '';

  const timeEvidenceCount = Number(Boolean(startTime)) + Number(Boolean(endTime));
  const contextEvidenceCount = Number(Boolean(timetable)) + Number(Boolean(venue)) + Number(Boolean(type)) + Number(squads.length > 0);
  const fingerprintSafe = Boolean(date && (timeEvidenceCount >= 2 || (timeEvidenceCount >= 1 && contextEvidenceCount >= 1)));
  const fingerprintKey = fingerprintSafe
    ? JSON.stringify({
      date,
      startTime,
      endTime,
      timetable,
      venue,
      type,
      squads,
    })
    : '';

  return {
    scheduleId,
    manual,
    date,
    slot,
    timetable,
    startTime,
    endTime,
    venue,
    type,
    squads,
    sourceKey,
    fingerprintKey,
    fingerprintSafe,
  };
}

function identityMatchKeys(identity) {
  if (!identity) return [];
  const kind = identity.manual ? 'manual' : 'generated';
  const keys = [];
  if (identity.sourceKey) keys.push(`${kind}|source|${identity.sourceKey}`);
  if (identity.fingerprintKey) keys.push(`${kind}|fingerprint|${identity.fingerprintKey}`);
  return keys;
}

function suppressionForIdentity(identity, deletedAt) {
  if (!identity || identity.manual) return null;
  if (identity.sourceKey) {
    return {
      identityType: 'source-slot',
      sourceSlotId: identity.slot,
      scheduleDate: identity.date,
      timetableId: identity.timetable,
      deletedAt,
      deletedBy: 'server-authoritative-schedule-delete',
    };
  }
  if (!identity.fingerprintSafe) return null;
  return {
    identityType: 'legacy-fingerprint',
    scheduleDate: identity.date,
    ...(identity.timetable ? { timetableId: identity.timetable } : {}),
    ...(identity.startTime ? { startTime: identity.startTime } : {}),
    ...(identity.endTime ? { endTime: identity.endTime } : {}),
    ...(identity.venue ? { venueId: identity.venue } : {}),
    ...(identity.type ? { sessionTypeId: identity.type } : {}),
    squadIds: identity.squads,
    deletedAt,
    deletedBy: 'server-authoritative-schedule-delete',
  };
}

function suppressionKey(row) {
  return JSON.stringify({
    identityType: text(row?.identityType),
    sourceSlotId: text(row?.sourceSlotId),
    scheduleDate: normalizeDate(row?.scheduleDate),
    timetableId: text(row?.timetableId),
    startTime: normalizeTime(row?.startTime),
    endTime: normalizeTime(row?.endTime),
    venueId: text(row?.venueId),
    sessionTypeId: text(row?.sessionTypeId),
    squadIds: unique(asArray(row?.squadIds)).sort(),
  });
}

export function resolveCanonicalScheduleDeleteTargets({
  requestedIds,
  scheduleRows,
  legacyScheduleRows,
  sessionRows,
  deletedAt = new Date().toISOString(),
}) {
  const requested = new Set(asArray(requestedIds).map(text).filter(Boolean));
  const schedules = [...asArray(scheduleRows), ...asArray(legacyScheduleRows)];
  const sessions = asArray(sessionRows);

  // Build the relation once. The old resolver filtered the entire session table once
  // for every Schedule row, which made whole-calendar deletion quadratic.
  const sessionsByScheduleId = new Map();
  const scheduleIdBySessionId = new Map();
  for (const row of sessions) {
    const scheduleId = text(row?.scheduleId || row?.trainingScheduleId);
    const sessionId = text(row?.id);
    if (sessionId && scheduleId) scheduleIdBySessionId.set(sessionId, scheduleId);
    if (!scheduleId) continue;
    const linked = sessionsByScheduleId.get(scheduleId);
    if (linked) linked.push(row);
    else sessionsByScheduleId.set(scheduleId, [row]);
  }

  const directlyResolvedScheduleIds = new Set();
  for (const row of schedules) {
    const id = text(row?.id);
    if (id && requested.has(id)) directlyResolvedScheduleIds.add(id);
  }
  for (const requestedId of requested) {
    const linkedScheduleId = scheduleIdBySessionId.get(requestedId);
    if (linkedScheduleId) directlyResolvedScheduleIds.add(linkedScheduleId);
  }

  const identitiesByScheduleId = new Map();
  for (const row of schedules) {
    const scheduleId = text(row?.id);
    const identity = buildOccurrenceIdentity(row, sessionsByScheduleId.get(scheduleId) || []);
    if (!identity) continue;
    const existing = identitiesByScheduleId.get(identity.scheduleId);
    if (existing) existing.push(identity);
    else identitiesByScheduleId.set(identity.scheduleId, [identity]);
  }

  // Index selected semantic identities once. The old resolver ran nested .some()
  // comparisons for every Schedule row against every selected identity.
  const selectedMatchKeys = new Set();
  for (const scheduleId of directlyResolvedScheduleIds) {
    for (const identity of identitiesByScheduleId.get(scheduleId) || []) {
      for (const key of identityMatchKeys(identity)) selectedMatchKeys.add(key);
    }
  }

  const targetScheduleIds = new Set(directlyResolvedScheduleIds);
  if (selectedMatchKeys.size > 0) {
    for (const [scheduleId, identities] of identitiesByScheduleId.entries()) {
      let matches = false;
      for (const identity of identities) {
        if (identityMatchKeys(identity).some((key) => selectedMatchKeys.has(key))) {
          matches = true;
          break;
        }
      }
      if (matches) targetScheduleIds.add(scheduleId);
    }
  }

  const suppressions = [];
  const seenSuppressions = new Set();
  const unresolvedGeneratedScheduleIds = [];
  for (const scheduleId of targetScheduleIds) {
    const identities = identitiesByScheduleId.get(scheduleId) || [];
    const generatedIdentities = identities.filter((identity) => !identity.manual);
    if (generatedIdentities.length === 0) continue;
    let safe = false;
    for (const identity of generatedIdentities) {
      const suppression = suppressionForIdentity(identity, deletedAt);
      if (!suppression) continue;
      safe = true;
      const key = suppressionKey(suppression);
      if (seenSuppressions.has(key)) continue;
      seenSuppressions.add(key);
      suppressions.push(suppression);
    }
    if (!safe) unresolvedGeneratedScheduleIds.push(scheduleId);
  }

  return {
    requestedIds: Array.from(requested),
    directlyResolvedScheduleIds: Array.from(directlyResolvedScheduleIds),
    targetScheduleIds: Array.from(targetScheduleIds),
    suppressions,
    unresolvedGeneratedScheduleIds: unique(unresolvedGeneratedScheduleIds),
  };
}
