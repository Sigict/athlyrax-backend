import { resolveDemoFixturePoolLength } from './demoCompetitionCourse.js';

// One canonical pool-course resolver for every consumer of race results.
// Short-course and long-course swims are different performances and must
// never be compared with each other. A course is only ever read from the
// recorded competition configuration; it is never inferred from a time.
export function canonicalCourseMetres(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (YARD_COURSE_VALUES.includes(raw)) return null;
  if (['25','25m','sc','short','short course','short-course','scm'].includes(raw)) return 25;
  if (['50','50m','lc','long','long course','long-course','lcm'].includes(raw)) return 50;
  return null;
}

// Short course yards (25-yard pool). Yard races are a separate course: they are
// never compared with metre races and never scored against metre references.
const YARD_COURSE_VALUES = ['25y', '25yd', '25 yd', 'scy', 'short course yards', 'yards', 'yd'];
const isYardRow = (row) => {
  if (!row || typeof row !== 'object') return false;
  const unit = String(row.poolUnit ?? row.courseUnit ?? '').trim().toLowerCase();
  if (unit === 'yd' || unit === 'yards') return true;
  return YARD_COURSE_VALUES.includes(String(row.course ?? '').trim().toLowerCase());
};
const hasExplicitUnit = (row) => Boolean(row && typeof row === 'object'
  && (String(row.poolUnit ?? row.courseUnit ?? '').trim() || YARD_COURSE_VALUES.includes(String(row.course ?? '').trim().toLowerCase())));

/**
 * The course of one fixture as a key: '25' (25 m), '50' (50 m), '25y'
 * (25 yd) or '' when no course is recorded. The fixture editor always sends
 * its events, so an event's explicit unit wins over the fixture-level one.
 */
export function resolveCompetitionCourseKey({ fixture = null, eventItem = null, legacyRow = null } = {}) {
  const metres = resolveCompetitionCourseMetres({ fixture, eventItem, legacyRow });
  const events = Array.isArray(fixture?.events) ? fixture.events : [];
  const unitSource = [eventItem, ...events].find(hasExplicitUnit) || fixture || legacyRow;
  if (isYardRow(unitSource) && (metres === 25 || metres === null)) return '25y';
  return metres ? String(metres) : '';
}

export const isYardCourseKey = (key) => key === '25y';
export const courseUnitLabel = (key) => (isYardCourseKey(key) ? 'yd' : 'm');
// 1 yd = 0.9144 m (exact, by definition): used only to express a yard split
// as a surface distance for distance-per-cycle; never to rescore a race.
export const courseDistanceMetres = (distance, key) => (isYardCourseKey(key) ? Number(distance) * 0.9144 : Number(distance));

// One fixture has one pool course. Its explicitly saved pool length wins over
// stale per-event SC/LC fields. Legacy result rows carry their own fields.
export function resolveCompetitionCourseMetres({ fixture = null, eventItem = null, legacyRow = null } = {}) {
  return canonicalCourseMetres(fixture?.poolLength)
    || canonicalCourseMetres(fixture?.course)
    || canonicalCourseMetres(eventItem?.poolLength)
    || canonicalCourseMetres(eventItem?.course)
    || canonicalCourseMetres(legacyRow?.poolLength)
    || canonicalCourseMetres(legacyRow?.course)
    || (fixture ? resolveDemoFixturePoolLength(fixture) : null);
}
