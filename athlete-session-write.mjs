const text = (value) => String(value ?? '').trim();
const asArray = (value) => Array.isArray(value) ? value : [];

export const ATHLETE_SESSION_POLICIES = Object.freeze({
  COACH_ONLY: 'coach_only',
  ATHLETE_EXTRA: 'athlete_extra',
  APPROVAL_REQUIRED: 'approval_required',
});

const VALID_POLICIES = new Set(Object.values(ATHLETE_SESSION_POLICIES));

function normalizeDate(value) {
  const date = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

function safeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const integer = Math.trunc(number);
  if (integer < min || integer > max) return null;
  return integer;
}

function normalizeSet(raw = {}, index = 0) {
  const rounds = raw.rounds == null ? null : safeInteger(raw.rounds, { min: 1, max: 100 });
  const reps = raw.reps == null ? null : safeInteger(raw.reps, { min: 1, max: 1000 });
  const distance = raw.distance == null ? null : safeInteger(raw.distance, { min: 1, max: 100000 });
  return {
    order: safeInteger(raw.order, { min: 0, max: 10000 }) ?? index + 1,
    title: text(raw.title || raw.name || `Set ${index + 1}`).slice(0, 160),
    rounds,
    reps,
    distance,
    distanceUnit: text(raw.distanceUnit || 'm').slice(0, 16) || 'm',
    stroke: text(raw.stroke).slice(0, 80),
    sendoff: text(raw.sendoff).slice(0, 40),
    rest: text(raw.rest).slice(0, 40),
    target: text(raw.target).slice(0, 160),
    energySystem: text(raw.energySystem).slice(0, 80),
    modality: text(raw.modality).slice(0, 80),
    coachComment: '',
    athleteVisible: true,
    wearableEligible: raw.wearableEligible !== false,
  };
}

export function selectAthleteSessionTarget(authorisedConnections = [], { clubId = '', primaryTenantId = '' } = {}) {
  const rows = asArray(authorisedConnections).filter((row) => row && row.status === 'active' && text(row.tenantId));
  const requestedClub = text(clubId);
  if (requestedClub) {
    return rows.find((row) => [row.clubId, row.tenantId, row.connectionId].map(text).includes(requestedClub)) || null;
  }

  const personalSources = new Set(['coach-link-source', 'disconnect-restored-source']);
  const personal = rows.find((row) => personalSources.has(text(row.source)));
  if (personal) return personal;
  const primary = rows.find((row) => text(row.tenantId) === text(primaryTenantId));
  return primary || rows[0] || null;
}

export function athleteSessionPolicyForProjection(projection = {}, target = {}, disciplineId = 'swimming') {
  const requestedDiscipline = text(disciplineId) || 'swimming';
  const targetKeys = new Set([target.clubId, target.tenantId, target.connectionId].map(text).filter(Boolean));
  const connection = asArray(projection.clubConnections).find((row) => [
    row.clubId,
    row.tenantId,
    row.connectionId,
  ].map(text).some((value) => targetKeys.has(value)));

  if (!connection) {
    if (text(target.source) === 'coach-link-source' || text(target.source) === 'disconnect-restored-source') {
      return { policy: ATHLETE_SESSION_POLICIES.ATHLETE_EXTRA, connection: null, independent: true };
    }
    return { policy: ATHLETE_SESSION_POLICIES.COACH_ONLY, connection: null, independent: false };
  }

  const perDiscipline = connection.sessionPolicies && typeof connection.sessionPolicies === 'object'
    ? text(connection.sessionPolicies[requestedDiscipline])
    : '';
  const legacy = requestedDiscipline === 'swimming' ? text(connection.swimmingSessionPolicy) : '';
  const policy = VALID_POLICIES.has(perDiscipline)
    ? perDiscipline
    : (VALID_POLICIES.has(legacy) ? legacy : ATHLETE_SESSION_POLICIES.COACH_ONLY);
  return { policy, connection, independent: false };
}

export function buildAthleteSessionWrite({
  athlete = {},
  authUser = {},
  target = {},
  projection = {},
  input = {},
  sessionId,
  setIdFactory,
  createdAt,
} = {}) {
  const athleteId = text(athlete.id || athlete.swimmerId || authUser.swimmerId || authUser.id);
  if (!athleteId) return { ok: false, status: 409, error: 'Authenticated athlete identity is unavailable.' };

  const date = normalizeDate(input.date || input.sessionDate);
  if (!date) return { ok: false, status: 400, error: 'Session date must use YYYY-MM-DD.' };
  const title = text(input.title).slice(0, 160);
  if (!title) return { ok: false, status: 400, error: 'Session title is required.' };
  const disciplineId = text(input.disciplineId || 'swimming').slice(0, 80) || 'swimming';
  const id = text(sessionId);
  if (!id) return { ok: false, status: 500, error: 'Session identity could not be generated.' };

  const policyResult = athleteSessionPolicyForProjection(projection, target, disciplineId);
  if (!policyResult.independent && policyResult.policy === ATHLETE_SESSION_POLICIES.COACH_ONLY) {
    return { ok: false, status: 403, error: 'Club controls this discipline programme.' };
  }

  const approvalStatus = policyResult.policy === ATHLETE_SESSION_POLICIES.APPROVAL_REQUIRED ? 'pending' : 'approved';
  const ownerClubId = policyResult.independent ? '' : text(policyResult.connection?.clubId || target.clubId || target.tenantId);
  const ownerTenantId = text(target.tenantId);
  const now = text(createdAt) || new Date().toISOString();
  const normalizedSets = asArray(input.sets).slice(0, 100).map(normalizeSet);

  const session = {
    id,
    swimmerId: athleteId,
    athleteId,
    date,
    sessionDate: date,
    disciplineId,
    ownerType: 'athlete',
    ownerClubId,
    ownerTenantId,
    approvalStatus,
    athleteProposed: !policyResult.independent,
    createdBy: text(authUser.username || authUser.email || athleteId),
    createdAt: now,
    updatedAt: now,
    title,
    startTime: text(input.startTime).slice(0, 20),
    endTime: text(input.endTime).slice(0, 20),
    venue: text(input.venue).slice(0, 160),
    sessionType: text(input.sessionType).slice(0, 100),
    mainFocus: text(input.mainFocus).slice(0, 160),
    secondaryFocus: text(input.secondaryFocus).slice(0, 160),
    totalVolume: input.volume == null ? null : safeInteger(input.volume, { min: 0, max: 1000000 }),
    volumeUnit: text(input.volumeUnit || 'm').slice(0, 16) || 'm',
    status: approvalStatus === 'pending' ? 'Pending Approval' : 'Planned',
  };

  const sets = normalizedSets.map((set, index) => ({
    ...set,
    id: text(setIdFactory?.(index, set)) || `${id}:set:${index + 1}`,
    sessionId: id,
    trainingSessionId: id,
    swimmerId: athleteId,
    athleteId,
    ownerClubId,
    ownerTenantId,
    approvalStatus,
    createdBy: session.createdBy,
    createdAt: now,
    updatedAt: now,
    date,
    sessionDate: date,
  }));

  return {
    ok: true,
    status: 201,
    approvalRequired: approvalStatus === 'pending',
    policy: policyResult.independent ? 'independent' : policyResult.policy,
    session,
    sets,
  };
}

export function appendAthleteSessionWrite(db = {}, write = {}) {
  if (!write?.ok || !write.session) throw new Error('Valid athlete session write required.');
  const sessionId = text(write.session.id);
  const currentSessions = asArray(db.trainingSessions);
  if (currentSessions.some((row) => text(row?.id || row?.sessionId || row?.trainingSessionId) === sessionId)) {
    throw new Error('Athlete session identity collision.');
  }
  const currentSets = asArray(db.trainingSessionSets);
  const next = {
    ...db,
    trainingSessions: [...currentSessions, write.session],
    trainingSessionSets: [...currentSets, ...asArray(write.sets)],
  };
  return next;
}
