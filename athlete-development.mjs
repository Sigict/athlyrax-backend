// The athlete's own development records (Athlete Master v31 My Development, Timetable & Planner):
// personal diary entries. Personal records only: kept in the athlete's own store, never in a club.
const text = (value, max = 160) => String(value ?? '').trim().slice(0, max);
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
export const DIARY_TYPES = ['Training day', 'Rest day', 'Recovery', 'Competition', 'Personal reflection'];
export const DIARY_FEELINGS = ['', 'Very good', 'Good', 'OK', 'Tired', 'Very tired'];

export class InvalidDevelopmentRecord extends Error {}
const fail = (message) => { throw new InvalidDevelopmentRecord(message); };

export function normalizeDiary(raw = {}) {
  if (!isDate(raw.date)) fail('Choose a diary date.');
  const type = text(raw.type, 30) || 'Training day';
  if (!DIARY_TYPES.includes(type)) fail('Unknown diary day type.');
  const feel = text(raw.feel, 20);
  if (!DIARY_FEELINGS.includes(feel)) fail('Unknown feeling.');
  const note = text(raw.note, 3000);
  if (!feel && !note) fail('Add a feeling or note before saving.');
  // Coach sharing is a preference for the future coach view; nothing is shared by this record.
  const visibility = raw.visibility === 'share_with_coach' ? 'share_with_coach' : 'private';
  return { date: raw.date, type, feel, note, visibility, source: 'athlete-entered' };
}

// Weekly planner row (Master v31 normalizeWeeklyPlanner): the athlete's own phase, cycle note and target
// fixture for one week. The record id is the week's Monday; it never overwrites a club-owned plan.
// The five canonical AthlyraX phases (Coaching Software planner: Intro, Aerobic, Specific, Race, Taper).
export const WEEK_PHASES = ['Intro', 'Aerobic', 'Specific', 'Race', 'Taper'];
export function normalizeWeekPlan(raw = {}) {
  if (!isDate(raw.week) || new Date(`${raw.week}T12:00:00Z`).getUTCDay() !== 1) fail('A week starts on a Monday (yyyy-mm-dd).');
  const phase = text(raw.phase, 20);
  if (phase && !WEEK_PHASES.includes(phase)) fail('Phase must be Intro, Aerobic, Specific, Race or Taper.');
  return { week: raw.week, phase, cycle: text(raw.cycle, 80), targetFixtureId: text(raw.targetFixtureId, 120), source: 'athlete-entered' };
}

// Personal goal (Master v31 normalizeAthleteGoals). Completing a goal is a self-report, never an assessment.
export const GOAL_HORIZONS = ['Short-term', 'Medium-term', 'Long-term'];
export const GOAL_CATEGORIES = ['Technical Control', 'Efficiency', 'Robustness of Efficiency', 'Aerobic Capacity', 'Anaerobic Capacity', 'Power & Speed Expression', 'Adaptability', 'Durability', 'Competition / target race', 'Consistency / attendance', 'Other'];
export function normalizeGoal(raw = {}) {
  const goalText = text(raw.text, 180);
  if (!goalText) fail('Enter a goal before saving.');
  const date = text(raw.date, 10);
  if (date && !isDate(date)) fail('Target date must be a valid date.');
  const horizon = GOAL_HORIZONS.includes(raw.horizon) ? raw.horizon : 'Short-term';
  const category = GOAL_CATEGORIES.includes(raw.category) ? raw.category : 'Other';
  return { text: goalText, date, horizon, category, measure: text(raw.measure, 160), outcome: text(raw.outcome, 100), done: raw.done === true, source: 'athlete-entered' };
}

// Imported-record provenance: where a record came from (Athlete Master v31 backup or an AthlyraX backup),
// its original id and source label. Kept on the record; never changes how the record is validated.
export function normalizeOrigin(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const from = text(raw.from, 40);
  if (!['athlete-master-v31', 'athlyrax-athlete-app-backup'].includes(from)) return null;
  return { from, originalId: text(raw.originalId, 120), originalType: text(raw.originalType, 60), sourceLabel: text(raw.sourceLabel, 160), importedAt: text(raw.importedAt, 30) };
}

// Read-only legacy archive (owner decision 8 Nov 2026): historical Athlete Master records that do not
// match an active AthlyraX record type (for example Max 75 or Single effort tests) are kept with their
// original values. They are never an active test type and never used in any capability calculation.
export function normalizeLegacy(raw = {}) {
  const origin = normalizeOrigin(raw.origin);
  if (!origin) fail('Legacy records must come from an imported backup.');
  const original = raw.original && typeof raw.original === 'object' ? raw.original : null;
  if (!original) fail('Legacy records keep the original record.');
  const json = JSON.stringify(original);
  if (json.length > 20000) fail('Legacy record is too large.');
  return { originalType: text(raw.originalType, 60) || 'record', date: isDate(raw.date) ? raw.date : '', summary: text(raw.summary, 300), reason: text(raw.reason, 300), original: JSON.parse(json), origin, readOnly: true, usedInCapability: false, verification: 'athlete-entered-unverified' };
}

// The athlete's own profile details (Athlete Master v31 My Profile). Club identity (name, date of birth,
// membership number) stays with the club and is shown read-only; these are the athlete's own entries.
export const PROFILE_SEX = ['', 'Female', 'Male', 'Other'];
export function normalizeProfile(raw = {}) {
  const sex = text(raw.sex, 10);
  if (!PROFILE_SEX.includes(sex)) fail('Unknown sex / gender marker.');
  const dob = text(raw.dob, 10);
  if (dob && !isDate(dob)) fail('Date of birth must be a valid date.');
  return { preferredName: text(raw.preferredName, 120), dob, sex, mainEvent: text(raw.mainEvent, 80), clubText: text(raw.clubText, 120), note: text(raw.note, 1000), source: 'athlete-entered' };
}
