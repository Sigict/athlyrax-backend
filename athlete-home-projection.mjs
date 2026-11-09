import { buildClubCapabilityProfile, clubSwimmingDiscipline } from './athlete-club-capability.mjs';
import { coachSessionName } from './session-name.mjs';

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
    ...asArray(athlete.squadIds),
    ...asArray(athlete.currentSquadIds),
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

  // ATHLYRAX_ATHLETE_HOME_PLANNER_SESSIONS: the Planner stores squads as squadIds / squadNames arrays.
  const sessionSquads = [session.squadId, session.squadCode, session.squadName, session.squad, ...asArray(session.squadIds), ...asArray(session.squadNames)]
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

// Send-offs saved as plain seconds (e.g. 105) are shown as clock time (1:45).
function clockOrText(value) {
  if (typeof value === 'number' || /^\d+$/.test(text(value))) {
    const s = Math.max(0, Math.round(Number(value)));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  return text(value);
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
    sendoff: clockOrText(set.sendoff ?? set.sendOff ?? set.interval),
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

// ATHLYRAX_ATHLETE_OWN_CLUB_RESULTS: the athlete sees the club's recorded results for THEIR OWN swimmer
// record only (times, splits, stroke counts per repetition) and their own lane and start offset.
// Other swimmers' results and coach-only fields are never included. Read-only.
const RESULT_TEXT = ['overallTime', 'time', 'overallStrokeCount', 'strokeCount', 'strokeCycles', 'underwater', 'underwaterDistance', 'breakout', 'rpe', 'heartRate'];
function ownRepResult(rep = {}, index = 0) {
  if (!rep || typeof rep !== 'object') return null;
  const out = { rep: Number.isInteger(Number(rep.rep)) && Number(rep.rep) > 0 ? Number(rep.rep) : index + 1 };
  for (const k of RESULT_TEXT) if (text(rep[k])) out[k] = text(rep[k]);
  const splits = asArray(rep.splits).map((sp) => ({ time: text(sp?.time), strokeCount: text(sp?.strokeCount), distance: sp?.distance ?? null })).filter((sp) => sp.time || sp.strokeCount);
  if (splits.length) out.splits = splits;
  return Object.keys(out).length > 1 ? out : null;
}
export function ownSetResult(set = {}, swimmerId = '') {
  const id = text(swimmerId);
  const all = set?.resultsBySwimmer && typeof set.resultsBySwimmer === 'object' ? set.resultsBySwimmer : null;
  const mine = id && all && Object.prototype.hasOwnProperty.call(all, id) ? all[id] : null;
  if (!mine || typeof mine !== 'object') return null;
  const reps = asArray(mine.reps).map(ownRepResult).filter(Boolean);
  const summary = {};
  for (const k of ['overallTime', 'overallStrokeCount']) if (text(mine[k])) summary[k] = text(mine[k]);
  if (!reps.length && !Object.keys(summary).length) return null;
  return { ...summary, reps, source: text(mine.source), updatedAt: text(mine.updatedAt), label: 'Recorded by the club (read-only)' };
}
export function ownLane(session = {}, swimmerId = '') {
  const id = text(swimmerId);
  const lanes = asArray(session?.poolsideLanePlan?.lanes);
  for (const lane of lanes) {
    const position = asArray(lane?.swimmerIds).map(text).indexOf(id);
    if (id && position >= 0) {
      const stagger = Number.isFinite(Number(lane.staggerSeconds)) ? Number(lane.staggerSeconds) : null;
      return { lane: text(lane.lane), position: position + 1, swimmersInLane: asArray(lane.swimmerIds).length, sendoffSeconds: lane.sendoffSeconds ?? null, staggerSeconds: stagger, startOffsetSeconds: stagger === null ? null : stagger * position };
    }
  }
  return null;
}

function safeSession(session = {}, linkedSets = [], ownSwimmerId = '') {
  const sessionId = canonicalSessionId(session);
  const nestedSets = asArray(session.sets || session.sessionSets);
  const sets = nestedSets.length ? nestedSets : linkedSets;
  return {
    id: sessionId,
    date: text(session.date || session.sessionDate || session.scheduleDate).slice(0, 10),
    scheduleId: text(session.scheduleId || session.trainingScheduleId),
    disciplineId: text(session.disciplineId || session.discipline || 'swimming'),
    ownerType: session.ownerType === 'athlete' ? 'athlete' : 'club',
    ownerClubId: text(session.ownerClubId || session.clubId),
    approvalStatus: text(session.approvalStatus || 'approved'),
    completionStatus: text(session.completionStatus || session.status),
    completed: session.completed === true,
    title: text(session.title || session.name || session.label || session.mainFocus || session.sessionType),
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
    sets: sets.map((set) => { const safe = safeSet(set); if (!safe) return null; const mine = ownSwimmerId ? ownSetResult(set, ownSwimmerId) : null; return mine ? { ...safe, myResult: mine } : safe; }).filter(Boolean),
    myLane: ownSwimmerId ? ownLane(session, ownSwimmerId) : null,
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
    // How the connection was made (e.g. 'athlete-invite': the athlete may leave it from the app).
    source: text(connection.source),
    startDate: text(connection.startDate),
    endDate: text(connection.endDate),
    swimmingSessionPolicy: text(connection.swimmingSessionPolicy),
    sessionPolicies: connection.sessionPolicies && typeof connection.sessionPolicies === 'object'
      ? connection.sessionPolicies
      : {},
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
    const nextPolicies = Object.keys(row.sessionPolicies || {}).length
      ? row.sessionPolicies
      : previous.sessionPolicies;
    const nextSwimmingPolicy = row.swimmingSessionPolicy || previous.swimmingSessionPolicy;
    const nextScopes = row.dataScopes.length ? row.dataScopes : previous.dataScopes;
    byKey.set(key, {
      ...previous,
      ...row,
      swimmingSessionPolicy: nextSwimmingPolicy,
      sessionPolicies: nextPolicies,
      dataScopes: nextScopes,
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
    byId.set(id, {
      ...previous,
      ...row,
      sets: [...setsById.values()],
    });
  }
  return [...byId.values()];
}

function clubDisciplines(athlete, clubProfile) {
  const own = asArray(athlete.disciplines);
  const swimming = clubSwimmingDiscipline(clubProfile);
  if (!swimming) return own;
  return [swimming, ...own.filter((row) => text(row?.id).toLowerCase() !== 'swimming')];
}

// ATHLYRAX_ATHLETE_EXPLICIT_LINK_FIRST: an explicit account link (set by the club's invitation) always
// decides which swimmer this account is; invitation-managed accounts never fall back to loose matching
// (email, id, membership number), so a matching email cannot reveal another swimmer's record.
// Shared by every athlete route that reads a club's data, so all of them resolve the same swimmer.
export function resolveLinkedSwimmer(db = {}, authUser = {}) {
  const username = text(authUser.username).toLowerCase();
  const explicit = username ? asArray(db.swimmers).find((row) => text(row?.swimmerAccountUsername).toLowerCase() === username) : null;
  return explicit || (authUser.athleteInviteManaged === true ? null : asArray(db.swimmers).find((row) => rowMatchesIdentity(row, identityValues(authUser)))) || null;
}

export function buildAthleteHomeProjection(db = {}, authUser = {}, context = {}) {
  const authIds = identityValues(authUser);
  const athlete = resolveLinkedSwimmer(db, authUser);
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
  // A Planner session is a schedule row (date, squads, name) plus a training session row holding the
  // sets (linked by scheduleId). The athlete sees it once, under the training session id, with the
  // schedule's date, squads and name filled in where the session row has none. Deleted rows are hidden.
  const isDeleted = (row) => text(row?.status).toLowerCase() === 'deleted' || Boolean(row?.deletedAt);
  const scheduleRows = [...asArray(db.schedule), ...asArray(db.scheduledSessions)].filter((row) => !isDeleted(row));
  const scheduleById = new Map(scheduleRows.map((row) => [text(row.id), row]));
  const sessionRows = [...asArray(db.trainingSessions), ...asArray(db.sessions)].filter((row) => !isDeleted(row));
  const linkedScheduleIds = new Set();
  const withSchedule = sessionRows.map((row) => {
    const scheduleId = text(row.scheduleId || row.trainingScheduleId);
    const schedule = (scheduleId ? scheduleById.get(scheduleId) : null)
      || scheduleRows.find((sch) => text(sch.trainingSessionId) && text(sch.trainingSessionId) === canonicalSessionId(row));
    if (!schedule) return row;
    linkedScheduleIds.add(text(schedule.id));
    const filled = { ...row, scheduleId: text(schedule.id) };
    // ATHLYRAX_ATHLETE_SESSION_NAME: the title is the coach's session name (see session-name.mjs); the
    // automatic capability focus stays the session's focus and is never shown as its title.
    const coachName = coachSessionName(row, schedule);
    if (coachName) filled.title = coachName;
    for (const key of ['date', 'scheduleDate', 'startTime', 'endTime', 'mainFocus', 'secondaryFocus', 'squadId', 'squadIds', 'squadName', 'squadNames', 'ownerClubId', 'clubId', 'venueName', 'venue']) {
      const empty = filled[key] === undefined || filled[key] === null || filled[key] === '' || (Array.isArray(filled[key]) && !filled[key].length);
      if (empty && schedule[key] !== undefined) filled[key] = schedule[key];
    }
    return filled;
  });
  const rawSessions = [
    ...withSchedule,
    ...scheduleRows.filter((row) => !linkedScheduleIds.has(text(row.id))),
  ].filter((row) => sessionMatchesAthlete(row, athleteIds, squadIds, clubIds));

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
    const safe = safeSession(row, linkedSets, text(athlete.id));
    // Club sessions read from this club's data belong to this club's context in the Athlete App.
    if (safe.ownerType === 'club' && !safe.ownerClubId && contextConnection?.clubId) safe.ownerClubId = text(contextConnection.clubId);
    return safe;
  }));

  // ATHLYRAX_ATHLETE_CLUB_CAPABILITY: the swimmer's profile is calculated on the server from the club's
  // own evidence for this swimmer with the AthlyraX capability engine (same call as the club's ISP).
  let clubProfile = null;
  if (text(athlete.id)) {
    try { clubProfile = buildClubCapabilityProfile(db, athlete, { tenantId: text(context?.tenantId) }); }
    catch (error) { console.warn('[athlete-home] capability profile unavailable:', String(error?.message || error).slice(0, 200)); }
  }

  return {
    athlete: {
      id: text(athlete.id || athlete.swimmerId || athlete.userId),
      displayName: text(athlete.displayName || athlete.name || `${text(athlete.firstName)} ${text(athlete.lastName)}`),
      dob: text(athlete.dob || athlete.dateOfBirth),
      asn: text(athlete.asn || athlete.asaN || athlete.asaNumber || athlete.membershipNumber),
    },
    clubConnections,
    sessions,
    disciplines: clubDisciplines(athlete, clubProfile),
    integratedProfile: clubProfile || athlete.integratedProfile || null,
    readiness: athlete.readiness || null,
    latestCoachFeedback: athlete.latestCoachFeedback || null,
    nextTarget: athlete.nextTarget || null,
  };
}
