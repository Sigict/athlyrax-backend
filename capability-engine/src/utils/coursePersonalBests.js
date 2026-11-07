import { competitionCourse, timeSeconds } from './repResultCells.js';

// Personal bests per pool course and event. Short course (25 m), long course
// (50 m) and short course yards are separate: a time on one course is never a
// PB on another. One source for the PBs tab, the rankings and the ISP.
export const COURSE_ORDER = ['25', '50', '25y', ''];

export function raceEventLabel(row, unit = 'm') {
  const distance = Number(row?.distance || 0);
  const stroke = String(row?.stroke || row?.raw?.event || row?.raw?.eventLabel || '').trim();
  return [distance > 0 ? `${distance}${unit}` : '', stroke].filter(Boolean).join(' ') || String(row?.eventId || '').trim() || 'Event';
}

// rows: completed canonical competition rows of one swimmer.
// Returns [{ course, events: [{ eventLabel, distance, best, races }] }].
export function personalBestsByCourse(rows) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const course = competitionCourse(row);
    const eventLabel = raceEventLabel(row, course.unit);
    const seconds = timeSeconds(String(row?.resultValue ?? '').trim());
    const key = `${course.key}|${eventLabel}`;
    if (!byKey.has(key)) byKey.set(key, { course, eventLabel, distance: Number(row?.distance) || 0, best: null, races: 0 });
    const item = byKey.get(key);
    item.races += 1;
    if (seconds !== null && seconds > 0 && (!item.best || seconds < item.best.seconds)) item.best = { row, seconds, time: String(row.resultValue).trim() };
  }
  return COURSE_ORDER.map((key) => ({
    course: [...byKey.values()].find((item) => item.course.key === key)?.course,
    events: [...byKey.values()].filter((item) => item.course.key === key && item.best)
      .sort((a, b) => a.eventLabel.replace(/^\d+\S*\s*/, '').localeCompare(b.eventLabel.replace(/^\d+\S*\s*/, '')) || a.distance - b.distance),
  })).filter((section) => section.events.length);
}

// "SC: 50m Free 34.63, 100m Free 1:13.61 · LC: …"
export function personalBestsSummary(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map((section) => `${section.course.short || section.course.label}: ${section.events.map((item) => `${item.eventLabel} ${item.best.time}`).join(', ')}`)
    .join(' · ');
}
