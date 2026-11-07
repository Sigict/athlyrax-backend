// The coach's name for a training session, shared by the Coach Console and the Athlete App.
// The Planner saves the "Session name" as mainFocus on the schedule row; it also fills the linked
// training session's mainFocus (and sometimes title) automatically with the capability focus of its
// sets. A session-row name that is only that automatic focus is therefore not the coach's name.
const text = (value) => String(value ?? '').trim();
const AXIS_LABELS = new Set(['technical control', 'efficiency', 'robustness of efficiency', 'aerobic capacity', 'anaerobic capacity', 'power & speed expression', 'durability', 'adaptability']);

function ownName(row = {}) {
  const focus = new Set([text(row.mainFocus), text(row.secondaryFocus)].filter(Boolean).map((v) => v.toLowerCase()));
  return ['title', 'name', 'sessionName'].map((key) => text(row?.[key]))
    .find((value) => value && !focus.has(value.toLowerCase()) && !AXIS_LABELS.has(value.toLowerCase())) || '';
}

function scheduleName(row = {}) {
  return ['title', 'name', 'sessionName', 'mainFocus'].map((key) => text(row?.[key])).find(Boolean) || '';
}

export function coachSessionName(session = {}, schedule = null) {
  return ownName(session) || (schedule ? scheduleName(schedule) : '') || scheduleName(session);
}
