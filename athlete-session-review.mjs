const asArray = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();

const DECISIONS = new Set(['approved', 'rejected']);

function sessionIdOf(row = {}) {
  return text(row.id || row.sessionId || row.trainingSessionId);
}

function setSessionId(row = {}) {
  return text(row.sessionId || row.trainingSessionId || row.parentSessionId);
}

export function listPendingAthleteSessionProposals(db = {}) {
  return asArray(db.trainingSessions)
    .filter((row) => row?.athleteProposed === true && text(row.approvalStatus).toLowerCase() === 'pending')
    .map((row) => ({
      id: sessionIdOf(row),
      athleteId: text(row.athleteId || row.swimmerId),
      swimmerId: text(row.swimmerId || row.athleteId),
      ownerClubId: text(row.ownerClubId || row.clubId),
      date: text(row.date || row.sessionDate),
      disciplineId: text(row.disciplineId || 'swimming'),
      title: text(row.title),
      startTime: text(row.startTime),
      venue: text(row.venue),
      volume: row.totalVolume ?? row.volume ?? null,
      volumeUnit: text(row.volumeUnit || 'm'),
      approvalStatus: 'pending',
      createdAt: text(row.createdAt),
    }))
    .filter((row) => row.id);
}

export function reviewAthleteSessionProposal(db = {}, {
  sessionId,
  decision,
  reviewer = '',
  reviewedAt = '',
} = {}) {
  const id = text(sessionId);
  const normalizedDecision = text(decision).toLowerCase();
  if (!id) return { ok: false, status: 400, error: 'Session id is required.' };
  if (!DECISIONS.has(normalizedDecision)) return { ok: false, status: 400, error: 'Decision must be approved or rejected.' };

  const sessions = asArray(db.trainingSessions);
  const index = sessions.findIndex((row) => sessionIdOf(row) === id);
  if (index < 0) return { ok: false, status: 404, error: 'Athlete session proposal was not found.' };
  const current = sessions[index];
  if (current?.athleteProposed !== true) return { ok: false, status: 409, error: 'Only athlete proposals can be reviewed here.' };
  if (text(current.approvalStatus).toLowerCase() !== 'pending') return { ok: false, status: 409, error: 'Athlete session proposal has already been reviewed.' };

  const now = text(reviewedAt) || new Date().toISOString();
  const nextSession = {
    ...current,
    approvalStatus: normalizedDecision,
    status: normalizedDecision === 'approved' ? 'Planned' : 'Rejected',
    reviewedBy: text(reviewer),
    reviewedAt: now,
    updatedAt: now,
  };
  const nextSessions = sessions.map((row, rowIndex) => rowIndex === index ? nextSession : row);
  const nextSets = asArray(db.trainingSessionSets).map((row) => {
    if (setSessionId(row) !== id) return row;
    return {
      ...row,
      approvalStatus: normalizedDecision,
      reviewedBy: text(reviewer),
      reviewedAt: now,
      updatedAt: now,
    };
  });

  return {
    ok: true,
    status: 200,
    decision: normalizedDecision,
    session: nextSession,
    db: {
      ...db,
      trainingSessions: nextSessions,
      trainingSessionSets: nextSets,
    },
  };
}
