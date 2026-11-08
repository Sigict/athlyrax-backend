// The athlete's own fixtures and competition reflections (Athlete Master v31 Fixtures page).
// Personal planning only: kept in the athlete's own store, never written to a club, never a result.
// Entry and target times are plans, not verified performances. Field set and limits follow Master v31.
const text = (value, max = 160) => String(value ?? '').trim().slice(0, max);
const asArray = (value) => (Array.isArray(value) ? value : []);
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
const clockSeconds = (value) => { const m = /^(?:(\d{1,2}):)?(\d{1,2}(?:\.\d{1,2})?)$/.exec(String(value || '').trim()); return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN; };
export const FIXTURE_STATUSES = ['Planning', 'Intending to enter', 'Entry submitted', 'Confirmed', 'Withdrawn', 'Completed'];
const COURSES = ['', 'SCM', 'LCM', 'SCY'];
const STROKES = ['free', 'back', 'breast', 'fly', 'im'];
const DISTANCES = [25, 50, 100, 200, 400, 800, 1500];
const ANSWERS = { recovery: ['', 'Very good', 'Good', 'Mixed', 'Difficult'], preparation: ['', 'As planned', 'Partly', 'Not as planned'], satisfaction: ['', 'Very satisfied', 'Satisfied', 'Mixed', 'Disappointed'] };

export class InvalidCompetitionRecord extends Error {}
const fail = (message) => { throw new InvalidCompetitionRecord(message); };

export function normalizeFixture(raw = {}) {
  const name = text(raw.name, 140);
  if (!name) fail('Enter a meet name.');
  if (!isDate(raw.date)) fail('Enter a valid competition date.');
  const endDate = text(raw.endDate, 10);
  if (endDate && (!isDate(endDate) || endDate < raw.date)) fail('The last competition day cannot be before the first.');
  const deadline = text(raw.deadline, 10);
  if (deadline && (!isDate(deadline) || deadline > raw.date)) fail('The entry deadline cannot be after the competition date.');
  const course = text(raw.course, 4).toUpperCase();
  if (!COURSES.includes(course)) fail('Course must be 25 m, 50 m or 25 yd.');
  const status = text(raw.status, 30) || 'Planning';
  if (!FIXTURE_STATUSES.includes(status)) fail('Unknown entry status.');
  const events = asArray(raw.events).slice(0, 51);
  if (events.length > 50) fail('At most 50 events per fixture.');
  return {
    name, date: raw.date, endDate, deadline, course, status, isMainEvent: raw.isMainEvent === true,
    venue: text(raw.venue, 160), notes: text(raw.notes, 2000),
    events: events.map((e, i) => {
      const where = `Event ${i + 1}`;
      const distance = Number(e?.distance);
      if (!DISTANCES.includes(distance)) fail(`${where}: distance must be 25–1500.`);
      const stroke = text(e?.stroke, 10).toLowerCase();
      if (!STROKES.includes(stroke)) fail(`${where}: choose a stroke.`);
      for (const key of ['entryTime', 'targetTime']) if (text(e?.[key], 12) && !(clockSeconds(e[key]) > 0)) fail(`${where}: times are positive m:ss.xx or seconds.`);
      return { id: text(e?.id, 96) || `event-${i + 1}`, distance, stroke, round: text(e?.round, 40), entryTime: text(e?.entryTime, 12), targetTime: text(e?.targetTime, 12), note: text(e?.note, 500) };
    }),
    source: 'athlete-entered', verification: 'athlete-entered-unverified',
  };
}

export function normalizeReflection(raw = {}) {
  const meet = text(raw.meet, 140);
  if (!meet || !isDate(raw.date)) fail('Enter a competition name and date.');
  const out = { date: raw.date, meet, fixtureId: text(raw.fixtureId, 96), note: text(raw.note, 3000), source: 'athlete-entered', verification: 'athlete-entered-unverified' };
  for (const [key, allowed] of Object.entries(ANSWERS)) { const v = text(raw[key], 20); if (!allowed.includes(v)) fail(`Unknown answer for ${key}.`); out[key] = v; }
  return out;
}

// Upcoming club fixtures the linked swimmer is entered in, read-only (club planning, not results).
export function clubFixturesForSwimmer(db = {}, swimmerId = '', { today = new Date().toISOString().slice(0, 10) } = {}) {
  const id = text(swimmerId, 160);
  if (!id) return [];
  return asArray(db.fixtures).map((f) => {
    const date = text(f?.startDate || f?.date, 10);
    const events = [...asArray(f?.events), ...asArray(f?.galaEvents)].filter((e) => asArray(e?.attendeeIds).map(String).includes(id) || Object.prototype.hasOwnProperty.call(e?.resultsBySwimmer || {}, id));
    return { id: text(f?.id, 160), name: text(f?.name || 'Competition', 140), date, endDate: text(f?.endDate, 10), course: text(f?.course || f?.poolCourse, 10), isMainEvent: f?.isMainEvent === true,
      events: events.map((e) => ({ id: text(e?.id, 160), event: text(e?.eventLabel || e?.event || e?.name, 80), distance: Number(e?.distance) || null, stroke: text(e?.stroke, 20) })) };
  }).filter((f) => isDate(f.date) && f.date >= today && f.events.length).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 100);
}
