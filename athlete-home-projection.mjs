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

function athleteClubValues(clubConnections = []) {
  return new Set(clubConnections.flatMap((row) => [
    row?.clubId,
    row?.clubCode,
    row?.clubName,
    row?.club,
    row?.name,
    row?.tenantId,
  ]).map(text).filter(Boolean));
}

function sessionMatchesAthlete(session = {}, athleteIds = new Set(), squadIds = new Set(), clubIds = new Set()) {
  const explicit = [session.swimmerId, session.athleteId, session.userId, session.memberId]
    .map(text)
    .filter(Boolean);
  if (explicit.length) return explicit.some((value) => athleteIds.has(value));

  const sessionSquads = [session.squadId, session.squadCode, session.squadName, session.squad]
    .map(text)
    .filter(Boolean);
  if (!sessionSquads.some((value) => squadIds.has(value))) return false;

  const sessionClubs = [session.ownerClubId, session.clubId, session.clubCode, session.clubName, session.club]
    .map(text)
    .filter(Boolean);
  if (sessionClubs.length === 0) return true;
  return sessionClubs.some((value) => clubIds.has(value));
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
  const nestedSets = asArray(session.sets || session.sessionSets);
  const sets = nestedSets.length ? nestedSets : linkedSets;
  return {
    id: canonicalSessionId(session),
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
    connectionId: text(connection.connectionId || connection.id || (connection.tenantId ? `tenant:${connection.tenantId}` : '')),
    tenantId: text(connection.tenantId),
    clubId: text(connection.clubId || connection.clubCode || connection.club || connection.tenantId),
    clubName: text(connection.clubName || connection.club || connection.name),
    squadId: text(connection.squadId || connection.squadCode),
    squadName: text(connection.squadName || connection.squad),
    status: text(connection.status || 'active'),
    startDate: text(connection.startDate),
    endDate: text(connection.endDate),
    swimmingSessionPolicy: text(connection.swimmingSessionPolicy),
    sessionPolicies: connection.sessionPolicies && typeof connection.sessionPolicies === 'object' ? connection.sessionPolicies : {},
    dataScopes: asArray(connection.dataScopes),
  };
}

function dedupeConnections(rows = []) {
  const byKey = new Map();
  for (const row of rows.map(safeClubConnection)) {
    const key = text(row.connectionId || row.tenantId || row.clubId || row.clubName);
    if (!key) continue;
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, row);
      continue;
    }
    byKey.set(key, {
      ...previous,
      ...row,
      swimmingSessionPolicy: row.swimmingSessionPolicy || previous.swimmingSessionPolicy,
      sessionPolicies: Object.keys(row.sessionPolicies || {}).length ? row.sessionPolicies : previous.sessionPolicies,
      dataScopes: row.dataScopes.length ? row.dataScopes : previous.dataScopes,
    });
  }
  return [...byKey.values()];
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
    byId.set(id, { ...previous, ...row, sets: [...setsById.values()] });
  }
  return [...byId.values()];
}

export function buildAthleteHomeProjection(db = {}, authUser = {}, context = {}) {
  const authIds = identityValues(authUser);
  const athlete = asArray(db.swimmers).find((row) => rowMatchesIdentity(row, authIds));
  if (!athlete) return null;

  const athleteIds = athleteIdentityValues(athlete, authIds);
  const topLevelClubConnections = [
    ...asArray(db.clubConnections),
    ...asArray(db.swimmerClubConnections),
  ].filter((row) => {
    const swimmerId = text(row.swimmerId || row.athleteId || row.userId);
    return Boolean(swimmerId && athleteIds.has(swimmerId));
  });
  const nestedClubConnections = asArray(athlete.clubConnections);
  const contextConnection = context?.connection && typeof context.connection === 'object'
    ? { ...context.connection, tenantId: text(context.tenantId || context.connection.tenantId), status: 'active' }
    : null;
  const rawClubConnections = [
    ...topLevelClubConnections,
    ...nestedClubConnections,
    ...(contextConnection ? [contextConnection] : []),
  ];
  const clubConnections = dedupeConnections(rawClubConnections);
  const squadIds = athleteSquadValues(athlete, rawClubConnections);
  const clubIds = athleteClubValues(rawClubConnections);

  const linkedSetRows = asArray(db.trainingSessionSets);
  const rawSessions = [
    ...asArray(db.trainingSessions),
    ...asArray(db.sessions),
    ...asArray(db.schedule),
    ...asArray(db.scheduledSessions),
  ].filter((row) => sessionMatchesAthlete(row, athleteIds, squadIds, clubIds));

  const sessions = dedupeSessions(rawSessions.map((row) => {
    const sessionId = canonicalSessionId(row);
    const scheduleId = text(row.scheduleId || row.occurrenceId || row.id);
    const linkedSets = linkedSetRows.filter((set) => {
      const parentSessionId = setSessionId(set);
      const parentScheduleId = setScheduleId(set);
      return Boolean((sessionId && parentSessionId === sessionId) || (scheduleId && parentScheduleId === scheduleId));
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
