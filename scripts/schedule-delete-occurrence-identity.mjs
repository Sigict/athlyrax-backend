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

function linkedSessionsForSchedule(sessionRows, scheduleId) {
  const target = text(scheduleId);
  if (!target) return [];
  return asArray(sessionRows).filter((row) => text(row?.scheduleId || row?.trainingScheduleId) === target);
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

function buildOccurrenceIdentity(scheduleRow, sessionRows) {
  if (!scheduleRow || typeof scheduleRow !== 'object') return null;
  const scheduleId = text(scheduleRow?.id);
  if (!scheduleId) return null;
  const linkedSessions = linkedSessionsForSchedule(sessionRows, scheduleId);
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

function identitiesMatch(a, b) {
  if (!a || !b) return false;
  if (a.manual !== b.manual) return false;
  if (a.sourceKey && b.sourceKey && a.sourceKey === b.sourceKey) return true;
  if (a.fingerprintKey && b.fingerprintKey && a.fingerprintKey === b.fingerprintKey) return true;
  return false;
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

  const directlyResolvedScheduleIds = new Set();
  for (const row of schedules) {
    const id = text(row?.id);
    if (id && requested.has(id)) directlyResolvedScheduleIds.add(id);
  }
  for (const row of sessions) {
    const sessionId = text(row?.id);
    if (!sessionId || !requested.has(sessionId)) continue;
    const scheduleId = text(row?.scheduleId || row?.trainingScheduleId);
    if (scheduleId) directlyResolvedScheduleIds.add(scheduleId);
  }

  const identitiesByScheduleId = new Map();
  for (const row of schedules) {
    const identity = buildOccurrenceIdentity(row, sessions);
    if (!identity) continue;
    const existing = identitiesByScheduleId.get(identity.scheduleId) || [];
    existing.push(identity);
    identitiesByScheduleId.set(identity.scheduleId, existing);
  }

  const selectedIdentities = [];
  for (const scheduleId of directlyResolvedScheduleIds) {
    selectedIdentities.push(...(identitiesByScheduleId.get(scheduleId) || []));
  }

  const targetScheduleIds = new Set(directlyResolvedScheduleIds);
  for (const [scheduleId, identities] of identitiesByScheduleId.entries()) {
    if (selectedIdentities.some((selected) => identities.some((candidate) => identitiesMatch(selected, candidate)))) {
      targetScheduleIds.add(scheduleId);
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
