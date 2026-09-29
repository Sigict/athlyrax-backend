const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();

function parentSessionId(row = {}) {
  return text(row.trainingSessionId || row.sessionId || row.parentSessionId);
}

function linkedSession(db, sessionId, scheduleId = '') {
  const canonicalId = text(sessionId);
  const canonicalScheduleId = text(scheduleId);
  const session = list(db.trainingSessions).find((row) =>
    text(row.id) === canonicalId
    || (canonicalScheduleId && text(row.scheduleId || row.trainingScheduleId) === canonicalScheduleId)
  );
  if (session) return { sessionId: text(session.id), scheduleId: text(session.scheduleId || session.trainingScheduleId || canonicalScheduleId) };
  const schedule = list(db.schedule).find((row) =>
    text(row.id) === canonicalScheduleId
    || text(row.trainingSessionId) === canonicalId
  );
  if (!schedule) return null;
  return { sessionId: canonicalId || text(schedule.trainingSessionId), scheduleId: text(schedule.id) };
}

export function applyCoachPoolsideAttendance(db = {}, input = {}) {
  const link = linkedSession(db, input.sessionId, input.scheduleId);
  if (!link?.sessionId && !link?.scheduleId) return { ok: false, status: 404, error: 'Canonical session was not found.' };
  const submitted = list(input.rows);
  if (!submitted.length) return { ok: false, status: 400, error: 'At least one attendance row is required.' };

  const normalizedSubmitted = submitted.map((submittedRow) => {
    const swimmerId = text(submittedRow.swimmerId || submittedRow.athleteId);
    const status = text(submittedRow.status).toLowerCase();
    if (!swimmerId || !['present', 'absent', 'late', 'excused', 'unmarked'].includes(status)) return null;
    return { swimmerId, status };
  });
  if (normalizedSubmitted.some((row) => !row)) {
    return { ok: false, status: 400, error: 'Attendance rows require swimmerId and a supported status.' };
  }

  const now = text(input.now) || new Date().toISOString();
  const actor = text(input.updatedBy);
  const existing = list(db.attendance);
  const submittedBySwimmerId = new Map(normalizedSubmitted.map((row) => [row.swimmerId, row]));
  const uniqueSubmitted = Array.from(submittedBySwimmerId.values());
  const existingTargetBySwimmerId = new Map();

  const matchesLinkedSession = (row) => (
    (link.sessionId && text(row.sessionId || row.trainingSessionId) === link.sessionId)
    || (link.scheduleId && text(row.scheduleId) === link.scheduleId)
  );

  for (const row of existing) {
    if (!matchesLinkedSession(row)) continue;
    const swimmerId = text(row.swimmerId || row.athleteId);
    if (!swimmerId || !submittedBySwimmerId.has(swimmerId)) continue;
    existingTargetBySwimmerId.set(swimmerId, row);
  }

  const retained = existing.filter((row) => {
    if (!matchesLinkedSession(row)) return true;
    const swimmerId = text(row.swimmerId || row.athleteId);
    return !submittedBySwimmerId.has(swimmerId);
  });

  const changedRows = [];
  for (const { swimmerId, status } of uniqueSubmitted) {
    if (status === 'unmarked') continue;
    const base = existingTargetBySwimmerId.get(swimmerId) || {};
    const row = {
      ...base,
      id: text(base.id) || `attendance:${link.sessionId || link.scheduleId}:${swimmerId}`,
      sessionId: link.sessionId,
      trainingSessionId: link.sessionId,
      scheduleId: link.scheduleId,
      swimmerId,
      status,
      present: status === 'present' || status === 'late',
      updatedAt: now,
      updatedBy: actor,
    };
    retained.push(row);
    changedRows.push(row);
  }

  return { ok: true, db: { ...db, attendance: retained }, rows: changedRows };
}

export function applyCoachPoolsideSetChange(db = {}, input = {}) {
  const sessionId = text(input.sessionId);
  const setId = text(input.setId);
  if (!sessionId || !setId) return { ok: false, status: 400, error: 'Canonical session and set IDs are required.' };
  const sets = list(db.trainingSessionSets);
  const index = sets.findIndex((row) => text(row.id) === setId && parentSessionId(row) === sessionId);
  if (index < 0) return { ok: false, status: 404, error: 'Canonical set was not found in this session.' };
  const reps = Number(input.reps);
  const sendoffSeconds = Number(input.sendoffSeconds);
  if (!Number.isFinite(reps) || reps < 1 || reps > 1000 || !Number.isFinite(sendoffSeconds) || sendoffSeconds < 0 || sendoffSeconds > 86400) {
    return { ok: false, status: 400, error: 'Reps or send-off is invalid.' };
  }
  const now = text(input.now) || new Date().toISOString();
  const next = sets.slice();
  next[index] = {
    ...next[index],
    reps: Math.trunc(reps),
    sendoff: sendoffSeconds,
    sendOff: sendoffSeconds,
    updatedAt: now,
    updatedBy: text(input.updatedBy),
  };
  return { ok: true, db: { ...db, trainingSessionSets: next }, set: next[index] };
}

export function applyCoachPoolsideExecution(db = {}, input = {}) {
  const sessionId = text(input.sessionId);
  const setId = text(input.setId);
  const swimmerId = text(input.swimmerId);
  const execution = input.execution && typeof input.execution === 'object' ? input.execution : null;
  if (!sessionId || !setId || !swimmerId || !execution) return { ok: false, status: 400, error: 'Canonical session, set, swimmer and execution are required.' };
  const sets = list(db.trainingSessionSets);
  const index = sets.findIndex((row) => text(row.id) === setId && parentSessionId(row) === sessionId);
  if (index < 0) return { ok: false, status: 404, error: 'Canonical set was not found in this session.' };
  if (!list(db.swimmers).some((row) => text(row.id) === swimmerId)) return { ok: false, status: 404, error: 'Swimmer was not found in this club.' };
  const executionId = text(execution.executionId || execution.id);
  if (!executionId) return { ok: false, status: 400, error: 'Execution ID is required.' };
  const current = list(sets[index].poolsideExecutions);
  const existingIndex = current.findIndex((row) => text(row.executionId || row.id) === executionId);
  const row = { ...execution, executionId, sessionId, setId, swimmerId, recordedAt: text(execution.recordedAt) || new Date().toISOString(), recordedBy: text(input.updatedBy) };
  const nextExecutions = current.slice();
  if (existingIndex >= 0) nextExecutions[existingIndex] = row;
  else nextExecutions.push(row);
  const nextSets = sets.slice();
  nextSets[index] = { ...nextSets[index], poolsideExecutions: nextExecutions, updatedAt: row.recordedAt, updatedBy: row.recordedBy };
  return { ok: true, db: { ...db, trainingSessionSets: nextSets }, execution: row };
}


function normalizeCanonicalResultRep(rep = {}) {
  const splits = list(rep?.splits).map((split) => ({
    ...split,
    time: text(split?.time),
    strokeCount: text(split?.strokeCount),
  }));
  return {
    ...rep,
    overallTime: text(rep?.overallTime),
    overallStrokeCount: text(rep?.overallStrokeCount),
    computedTotalTime: text(rep?.computedTotalTime),
    computedStrokeCount: text(rep?.computedStrokeCount),
    splits,
  };
}

export function applyCoachPoolsideCanonicalResult(db = {}, input = {}) {
  const sessionId = text(input.sessionId);
  const setId = text(input.setId);
  const swimmerId = text(input.swimmerId);
  const reps = list(input.reps).map(normalizeCanonicalResultRep);
  if (!sessionId || !setId || !swimmerId) {
    return { ok: false, status: 400, error: 'Canonical session, set and swimmer are required.' };
  }
  if (!reps.length) return { ok: false, status: 400, error: 'At least one result rep is required.' };
  const sets = list(db.trainingSessionSets);
  const index = sets.findIndex((row) => text(row.id) === setId && parentSessionId(row) === sessionId);
  if (index < 0) return { ok: false, status: 404, error: 'Canonical set was not found in this session.' };
  if (!list(db.swimmers).some((row) => text(row.id) === swimmerId)) {
    return { ok: false, status: 404, error: 'Swimmer was not found in this club.' };
  }
  const now = text(input.now) || new Date().toISOString();
  const currentResults = sets[index]?.resultsBySwimmer && typeof sets[index].resultsBySwimmer === 'object'
    ? sets[index].resultsBySwimmer
    : {};
  const nextResult = {
    ...(currentResults[swimmerId] && typeof currentResults[swimmerId] === 'object' ? currentResults[swimmerId] : {}),
    reps,
    source: text(input.source) || 'coach-poolside',
    updatedAt: now,
    updatedBy: text(input.updatedBy),
  };
  const nextSets = sets.slice();
  nextSets[index] = {
    ...nextSets[index],
    resultsBySwimmer: { ...currentResults, [swimmerId]: nextResult },
    updatedAt: now,
    updatedBy: text(input.updatedBy),
  };
  return { ok: true, db: { ...db, trainingSessionSets: nextSets }, result: nextResult, set: nextSets[index] };
}


function competitionRef(row = {}) {
  return text(row.id || row._id || row.fixtureId || row.fixtureReference);
}

function competitionEventNumber(row = {}) {
  return text(row.eventN || row.eventNumber || row.number);
}

function normalizeCompetitionVideoEvidence(value, source, now, actor) {
  return list(value).map((row, index) => {
    const item = row && typeof row === 'object' ? row : { note: text(row) };
    return {
      ...item,
      id: text(item.id || item.videoId) || `competition-video:${now}:${index + 1}`,
      source: text(item.source) || source,
      recordedAt: text(item.recordedAt || item.createdAt) || now,
      recordedBy: text(item.recordedBy) || actor,
    };
  });
}

export function applyCoachPoolsideCompetitionEvidence(db = {}, input = {}) {
  const fixtureId = text(input.fixtureId || input.fixtureReference);
  const eventId = text(input.eventId);
  const eventN = text(input.eventN || input.eventNumber);
  const swimmerId = text(input.swimmerId);
  if (!fixtureId || (!eventId && !eventN) || !swimmerId) {
    return { ok: false, status: 400, error: 'Competition, event and swimmer are required.' };
  }
  if (!list(db.swimmers).some((row) => text(row.id) === swimmerId)) {
    return { ok: false, status: 404, error: 'Swimmer was not found in this club.' };
  }

  const fixtures = list(db.fixtures);
  const fixtureIndex = fixtures.findIndex((row) => competitionRef(row) === fixtureId);
  if (fixtureIndex < 0) return { ok: false, status: 404, error: 'Competition was not found.' };

  const currentFixture = fixtures[fixtureIndex] && typeof fixtures[fixtureIndex] === 'object' ? fixtures[fixtureIndex] : {};
  const events = list(currentFixture.events).map((row) => ({ ...row }));
  const eventIndex = events.findIndex((row) => (
    (eventId && text(row.id) === eventId)
    || (eventN && competitionEventNumber(row) === eventN)
  ));
  if (eventIndex < 0) return { ok: false, status: 404, error: 'Competition event was not found.' };

  const now = text(input.now) || new Date().toISOString();
  const actor = text(input.updatedBy);
  const sourceKind = ['official', 'coach', 'other'].includes(text(input.sourceKind)) ? text(input.sourceKind) : 'coach';
  const source = text(input.source) || (sourceKind === 'coach' ? 'coach-poolside' : sourceKind);
  const currentEvent = events[eventIndex];
  const resultsBySwimmer = currentEvent.resultsBySwimmer && typeof currentEvent.resultsBySwimmer === 'object'
    ? { ...currentEvent.resultsBySwimmer }
    : {};
  const previous = resultsBySwimmer[swimmerId] && typeof resultsBySwimmer[swimmerId] === 'object'
    ? resultsBySwimmer[swimmerId]
    : {};
  const evidenceBySource = previous.evidenceBySource && typeof previous.evidenceBySource === 'object'
    ? { ...previous.evidenceBySource }
    : {};
  const previousSourceEvidence = evidenceBySource[sourceKind] && typeof evidenceBySource[sourceKind] === 'object'
    ? evidenceBySource[sourceKind]
    : {};
  const totalTime = text(input.totalTime || input.resultTime);
  const entryTime = text(input.entryTime) || text(previous.entryTime);
  const coachNotes = text(input.coachNotes || input.notes);
  const videos = normalizeCompetitionVideoEvidence(input.videoAnalyses || input.videos, source, now, actor);

  evidenceBySource[sourceKind] = {
    ...previousSourceEvidence,
    ...(totalTime ? { totalTime } : {}),
    ...(entryTime ? { entryTime } : {}),
    ...(coachNotes ? { coachNotes } : {}),
    ...(videos.length ? { videoAnalyses: [...list(previousSourceEvidence.videoAnalyses), ...videos] } : {}),
    source,
    updatedAt: now,
    updatedBy: actor,
  };

  const officialTime = text(evidenceBySource.official?.totalTime);
  const coachTime = text(evidenceBySource.coach?.totalTime);
  const mergedCoachNotes = text(evidenceBySource.coach?.coachNotes || previous.coachNotes);
  const mergedVideos = list(evidenceBySource.coach?.videoAnalyses);

  const nextResult = {
    ...previous,
    ...(entryTime ? { entryTime } : {}),
    totalTime: officialTime || coachTime || totalTime || text(previous.totalTime),
    officialTime,
    coachTime,
    coachNotes: mergedCoachNotes,
    videoAnalyses: mergedVideos,
    evidenceBySource,
    updatedAt: now,
    updatedBy: actor,
  };

  resultsBySwimmer[swimmerId] = nextResult;
  const attendeeIds = Array.from(new Set([...list(currentEvent.attendeeIds), swimmerId].map(text).filter(Boolean)));
  events[eventIndex] = { ...currentEvent, attendeeIds, resultsBySwimmer, updatedAt: now, updatedBy: actor };

  const fixtureAttendeeIds = Array.from(new Set(events.flatMap((row) => list(row.attendeeIds)).map(text).filter(Boolean)));
  const nextFixtures = fixtures.slice();
  nextFixtures[fixtureIndex] = { ...currentFixture, events, attendeeIds: fixtureAttendeeIds, updatedAt: now, updatedBy: actor };

  return {
    ok: true,
    db: { ...db, fixtures: nextFixtures },
    result: nextResult,
    event: events[eventIndex],
    fixture: nextFixtures[fixtureIndex],
  };
}
