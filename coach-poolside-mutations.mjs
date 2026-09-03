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
  const now = text(input.now) || new Date().toISOString();
  const actor = text(input.updatedBy);
  const existing = list(db.attendance);
  const next = existing.slice();
  for (const submittedRow of submitted) {
    const swimmerId = text(submittedRow.swimmerId || submittedRow.athleteId);
    const status = text(submittedRow.status).toLowerCase();
    if (!swimmerId || !['present', 'absent', 'late', 'excused'].includes(status)) {
      return { ok: false, status: 400, error: 'Attendance rows require swimmerId and a supported status.' };
    }
    const index = next.findIndex((row) =>
      text(row.swimmerId || row.athleteId) === swimmerId
      && (
        (link.sessionId && text(row.sessionId || row.trainingSessionId) === link.sessionId)
        || (link.scheduleId && text(row.scheduleId) === link.scheduleId)
      )
    );
    const base = index >= 0 ? next[index] : {};
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
    if (index >= 0) next[index] = row;
    else next.push(row);
  }
  return { ok: true, db: { ...db, attendance: next }, rows: next.filter((row) => submitted.some((item) => text(item.swimmerId) === text(row.swimmerId)) && ((link.sessionId && text(row.sessionId || row.trainingSessionId) === link.sessionId) || (link.scheduleId && text(row.scheduleId) === link.scheduleId))) };
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
