const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();

function swimmerExists(db, swimmerId) {
  return list(db?.swimmers).some((row) => text(row?.id) === text(swimmerId));
}

export function applyCoachObservation(db = {}, input = {}) {
  const swimmerId = text(input?.swimmerId || input?.athleteId);
  const notes = text(input?.notes || input?.note || input?.coachNotes);
  if (!swimmerId) return { ok: false, status: 400, error: 'Swimmer is required.' };
  if (!notes) return { ok: false, status: 400, error: 'Observation note is required.' };
  if (!swimmerExists(db, swimmerId)) return { ok: false, status: 404, error: 'Swimmer was not found.' };

  const now = text(input?.updatedAt || input?.createdAt) || new Date().toISOString();
  const id = text(input?.id) || `coach-observation:${swimmerId}:${Date.now()}`;
  const existing = list(db?.coachObservations);
  const index = existing.findIndex((row) => text(row?.id) === id);
  const prior = index >= 0 ? existing[index] : {};
  const observation = {
    ...prior,
    id,
    swimmerId,
    athleteId: swimmerId,
    date: text(input?.date) || now.slice(0, 10),
    notes,
    mainFocus: text(input?.mainFocus || input?.focus),
    sessionId: text(input?.sessionId || input?.trainingSessionId),
    trainingSessionId: text(input?.sessionId || input?.trainingSessionId),
    scheduleId: text(input?.scheduleId || input?.trainingScheduleId),
    trainingScheduleId: text(input?.scheduleId || input?.trainingScheduleId),
    setId: text(input?.setId || input?.trainingSetId),
    fixtureId: text(input?.fixtureId),
    eventId: text(input?.eventId),
    coachId: text(input?.coachId || input?.updatedBy),
    coachName: text(input?.coachName),
    source: text(input?.source) || 'athlyrax-software',
    tags: list(input?.tags).map(text).filter(Boolean),
    createdAt: text(prior?.createdAt) || now,
    updatedAt: now,
    updatedBy: text(input?.updatedBy),
  };

  const next = existing.slice();
  if (index >= 0) next[index] = observation;
  else next.push(observation);

  return {
    ok: true,
    observation,
    db: {
      ...db,
      coachObservations: next,
      __meta: { ...(db?.__meta || {}), updatedAt: now },
    },
  };
}
