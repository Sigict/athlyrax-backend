const asArray = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();

function identityValues(user = {}) {
  return new Set([
    user.id,
    user.userId,
    user.swimmerId,
    user.username,
    user.email,
    user.asn,
    user.asaN,
  ].map(text).filter(Boolean));
}

function rowMatchesIdentity(row = {}, ids = new Set()) {
  const candidates = [
    row.id,
    row.userId,
    row.swimmerId,
    row.username,
    row.email,
    row.swimmerAccountUsername,
    row.swimmerAccountEmail,
    row.asn,
    row.asaN,
  ].map(text).filter(Boolean);
  return candidates.some((value) => ids.has(value));
}

function athleteIdentityValues(athlete = {}, authIds = new Set()) {
  return new Set([
    ...authIds,
    athlete.id,
    athlete.userId,
    athlete.swimmerId,
    athlete.username,
    athlete.email,
    athlete.swimmerAccountUsername,
    athlete.swimmerAccountEmail,
    athlete.asn,
    athlete.asaN,
  ].map(text).filter(Boolean));
}

function athleteSquadValues(athlete = {}, clubConnections = []) {
  return new Set([
    athlete.currentSquadId,
    athlete.squadId,
    athlete.squad,
    ...clubConnections.flatMap((row) => [row?.squadId, row?.squadCode, row?.squadName, row?.squad]),
  ].map(text).filter(Boolean));
}

function sessionMatchesAthlete(session = {}, athleteIds = new Set(), squadIds = new Set()) {
  const explicit = [session.swimmerId, session.athleteId, session.userId, session.memberId]
    .map(text)
    .filter(Boolean);
  if (explicit.length) return explicit.some((value) => athleteIds.has(value));

  const sessionSquads = [session.squadId, session.squadCode, session.squadName, session.squad]
    .map(text)
    .filter(Boolean);
  return sessionSquads.some((value) => squadIds.has(value));
}

function setSessionId(set = {}) {
  return text(set.sessionId || set.trainingSessionId || set.parentSessionId);
}

function setScheduleId(set = {}) {
  return text(set.scheduleId || set.scheduleSessionId || set.occurrenceId);
}

function safeSet(set = {}) {
  if (set.coachPrivate === true || set.athleteVisible === false) return null;
  return {
    id: text(set.id || set.setId),
    order: set.order ?? set.index ?? null,
    title: text(set.title || set.name || set.text || set.description),
    rounds: set.rounds ?? set.numRounds ?? null,
    reps: set.reps ?? set.numReps ?? null,
    distance: set.distance ?? set.distancePerRep ?? null,
    distanceUnit: text(set.distanceUnit || set.unit || 'm'),
    stroke: text(set.stroke || set.strokeType),
    sendoff: text(set.sendoff || set.sendOff || set.interval),
    rest: text(set.rest || set.restTime),
    target: text(set.target || set.targetTime || set.targetPace),
    energySystem: text(set.energySystem || set.energy),
    modality: text(set.modality),
    coachComment: text(set.coachComment || set.comment),
    athleteVisible: true,
    wearableEligible: set.wearableEligible !== false,
    execution: set.execution && typeof set.execution === 'object' ? set.execution : null,
  };
}

function canonicalSessionId(session = {}) {
  return text(session.id || session.sessionId || session.trainingSessionId || session.scheduleId || session.occurrenceId);
}

function safeSession(session = {}, linkedSets = []) {
  const sessionId = canonicalSessionId(session);
  const nestedSets = asArray(session.sets || session.sessionSets);
  const sets = nestedSets.length ? nestedSets : linkedSets;
  return {
    id: sessionId,
    date: text(session.date || session.sessionDate),
    disciplineId: text(session.disciplineId || session.discipline || 'swimming'),
    ownerType: session.ownerType === 'athlete' ? 'athlete' : 'club',
    ownerClubId: text(session.ownerClubId || session.clubId),
    approvalStatus: text(session.approvalStatus || 'approved'),
    completionStatus: text(session.completionStatus || session.status),
    completed: session.completed === true,
    title: text(session.title || session.name || session.label || session.sessionType),
    startTime: text(session.startTime || session.start),
    endTime: text(session.endTime || session.end),
    venue: text(session.venue || session.location || session.pool),
    coachName: text(session.coachName || session.coach),
    squadName: text(session.squadName || session.squad),
    sessionType: text(session.sessionType || session.type),
    mainFocus: text(session.mainFocus || session.focus),
    secondaryFocus: text(session.secondaryFocus),
    volume: session.totalVolume ?? session.volume ?? null,
    volumeUnit: text(session.volumeUnit || session.unit || 'm'),
    sets: sets.map(safeSet).filter(Boolean),
    wearableSync: session.wearableSync && typeof session.wearableSync === 'object' ? session.wearableSync : {},
    executionSummary: session.executionSummary && typeof session.executionSummary === 'object' ? session.executionSummary : null,
  };
}

function safeClubConnection(connection = {}) {
  return {
    connectionId: text(connection.connectionId || connection.id),
    clubId: text(connection.clubId || connection.clubCode || connection.club),
    clubName: text(connection.clubName || connection.club || connection.name),
    squadId: text(connection.squadId || connection.squadCode),
    squadName: text(connection.squadName || connection.squad),
    status: text(connection.status || 'active'),
    startDate: text(connection.startDate),
    endDate: text(connection.endDate),
    swimmingSessionPolicy: text(connection.swimmingSessionPolicy || 'coach_only'),
    sessionPolicies: connection.sessionPolicies && typeof connection.sessionPolicies === 'object'
      ? connection.sessionPolicies
      : {},
    dataScopes: asArray(connection.dataScopes),
  };
}

function dedupeSessions(rows = []) {
  const byId = new Map();
  for (const row of rows) {
    const id = text(row?.id);
    if (!id) continue;
    const previous = byId.get(id);
    if (!previous) {
      byId.set(id, row);
      continue;
    }
    const setsById = new Map();
    for (const set of [...asArray(previous.sets), ...asArray(row.sets)]) {
      const setId = text(set?.id);
      if (setId && !setsById.has(setId)) setsById.set(setId, set);
    }
    byId.set(id, {
      ...previous,
      ...row,
      sets: [...setsById.values()],
    });
  }
  return [...byId.values()];
}

export function buildAthleteHomeProjection(db = {}, authUser = {}) {
  const authIds = identityValues(authUser);
  const athlete = asArray(db.swimmers).find((row) => rowMatchesIdentity(row, authIds));
  if (!athlete) return null;

  const athleteIds = athleteIdentityValues(athlete, authIds);
  const rawClubConnections = [
    ...asArray(db.clubConnections),
    ...asArray(db.swimmerClubConnections),
    ...asArray(athlete.clubConnections),
  ].filter((row) => {
    const swimmerId = text(row.swimmerId || row.athleteId || row.userId);
    return !swimmerId || athleteIds.has(swimmerId);
  });
  const clubConnections = rawClubConnections.map(safeClubConnection);
  const squadIds = athleteSquadValues(athlete, rawClubConnections);

  const linkedSetRows = asArray(db.trainingSessionSets);
  const rawSessions = [
    ...asArray(db.trainingSessions),
    ...asArray(db.sessions),
    ...asArray(db.schedule),
    ...asArray(db.scheduledSessions),
  ].filter((row) => sessionMatchesAthlete(row, athleteIds, squadIds));

  const sessions = dedupeSessions(rawSessions.map((row) => {
    const sessionId = canonicalSessionId(row);
    const scheduleId = text(row.scheduleId || row.occurrenceId || row.id);
    const linkedSets = linkedSetRows.filter((set) => {
      const parentSessionId = setSessionId(set);
      const parentScheduleId = setScheduleId(set);
      return Boolean(
        (sessionId && parentSessionId === sessionId) ||
        (scheduleId && parentScheduleId === scheduleId)
      );
    });
    return safeSession(row, linkedSets);
  }));

  return {
    athlete: {
      id: text(athlete.id || athlete.swimmerId || athlete.userId),
      displayName: text(athlete.displayName || athlete.name || `${text(athlete.firstName)} ${text(athlete.lastName)}`),
      dob: text(athlete.dob || athlete.dateOfBirth),
      asn: text(athlete.asn || athlete.asaN || athlete.asaNumber || athlete.membershipNumber),
    },
    clubConnections,
    sessions,
    disciplines: asArray(athlete.disciplines),
    integratedProfile: athlete.integratedProfile || null,
    readiness: athlete.readiness || null,
    latestCoachFeedback: athlete.latestCoachFeedback || null,
    nextTarget: athlete.nextTarget || null,
  };
}
