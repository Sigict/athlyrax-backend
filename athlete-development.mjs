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
