const rows = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();
const ids = (value) => rows(value).map(text).filter(Boolean);

function sessionDate(row = {}) {
  return text(row.scheduleDate || row.sessionDate || row.date || row.startDate).slice(0, 10);
}

function sessionId(row = {}) {
  return text(row.id || row.sessionId || row.trainingSessionId);
}

function setSessionId(row = {}) {
  return text(row.trainingSessionId || row.sessionId || row.parentSessionId);
}

function rowSquadIds(row = {}) {
  return [...new Set([
    ...ids(row.squadIds),
    text(row.squadId),
    text(row.teamId),
  ].filter(Boolean))];
}

function fullName(row = {}) {
  return text(row.fullName || row.name || [row.firstName, row.lastName].map(text).filter(Boolean).join(' '));
}

export function buildCoachPoolsideProjection(db = {}, { date = '' } = {}) {
  const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(text(date))
    ? text(date)
    : new Date().toISOString().slice(0, 10);
  const schedules = rows(db.schedule).filter((row) => sessionDate(row) === selectedDate && text(row.status).toLowerCase() !== 'deleted');
  const trainingSessions = rows(db.trainingSessions);
  const sessionByScheduleId = new Map();
  for (const session of trainingSessions) {
    const scheduleId = text(session.scheduleId || session.trainingScheduleId);
    if (scheduleId && !sessionByScheduleId.has(scheduleId)) sessionByScheduleId.set(scheduleId, session);
  }
  const canonicalSessions = schedules.map((schedule) => {
    const linked = sessionByScheduleId.get(sessionId(schedule)) || trainingSessions.find((row) => sessionId(row) === text(schedule.trainingSessionId)) || {};
    return { ...schedule, ...linked, id: sessionId(linked) || sessionId(schedule), scheduleId: sessionId(schedule), date: selectedDate };
  });
  for (const session of trainingSessions) {
    if (sessionDate(session) !== selectedDate || text(session.status).toLowerCase() === 'deleted') continue;
    if (!canonicalSessions.some((row) => sessionId(row) === sessionId(session))) canonicalSessions.push({ ...session, id: sessionId(session), date: selectedDate });
  }
  const sessionIds = new Set(canonicalSessions.map(sessionId).filter(Boolean));
  const setsBySession = new Map();
  for (const set of rows(db.trainingSessionSets)) {
    const parentId = setSessionId(set);
    if (!sessionIds.has(parentId)) continue;
    const list = setsBySession.get(parentId) || [];
    list.push({
      id: text(set.id),
      order: Number(set.order ?? set.setOrder ?? list.length + 1),
      phase: text(set.phase),
      rounds: Number(set.rounds || 0),
      reps: Number(set.reps || 0),
      distance: Number(set.distance || 0),
      distanceUnit: text(set.distanceUnit || set.unit || 'm'),
      stroke: text(set.stroke),
      modality: text(set.modality),
      sendoff: text(set.sendoff || set.sendOff),
      comment: text(set.comment || set.notes),
      energySystem: text(set.energySystem),
    });
    setsBySession.set(parentId, list);
  }
  const squadIdSet = new Set(canonicalSessions.flatMap(rowSquadIds));
  const swimmers = rows(db.swimmers)
    .filter((row) => {
      const memberSquads = rowSquadIds(row);
      return squadIdSet.size === 0 || memberSquads.some((id) => squadIdSet.has(id));
    })
    .map((row) => ({ id: text(row.id), name: fullName(row), squadIds: rowSquadIds(row) }))
    .filter((row) => row.id && row.name);
  const attendance = rows(db.attendance)
    .filter((row) => {
      const ref = text(row.sessionId || row.trainingSessionId || row.scheduleId);
      return sessionIds.has(ref) || canonicalSessions.some((session) => text(session.scheduleId) === ref);
    })
    .map((row) => ({ id: text(row.id), sessionId: text(row.sessionId || row.trainingSessionId), scheduleId: text(row.scheduleId), swimmerId: text(row.swimmerId || row.athleteId), status: text(row.status || (row.present === false ? 'absent' : 'present')).toLowerCase() }));
  return {
    date: selectedDate,
    sessions: canonicalSessions.map((session) => ({
      id: sessionId(session),
      scheduleId: text(session.scheduleId),
      title: text(session.title || session.name || session.sessionName || 'Training session'),
      startTime: text(session.startTime),
      endTime: text(session.endTime),
      venue: text(session.venueName || session.venue),
      venueId: text(session.venueId),
      sessionType: text(session.sessionType || session.type),
      squadIds: rowSquadIds(session),
      coachIds: ids(session.coachIds).length ? ids(session.coachIds) : [text(session.coachId)].filter(Boolean),
      sets: (setsBySession.get(sessionId(session)) || []).sort((a, b) => a.order - b.order),
    })),
    swimmers,
    attendance,
  };
}
