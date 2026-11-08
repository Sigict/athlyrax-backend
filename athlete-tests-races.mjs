// Tests and races for the Athlete App (Phase 3A).
//
// Protocols come from the Coaching Software's canonical test catalogue (capability-engine copy of
// src/utils/testTemplateCatalog.js): Max effort 25/50/100/200/400, Repeatability 8x25/8x50/8x100 and the
// 5x400 Aerobic / Durability Check (kept in the catalogue for reading results), plus Competition race.
// Validation rules follow Athlete Master v31 (splits cumulative or individual and adding up to the finish
// time within 0.11 s, one stroke count per split, all repetition times for repeatability).
//
// Everything the athlete enters is self-reported (athlete-entered, unverified) and is kept in the
// athlete's own store; it never changes the validated capability radar and never touches club records.
// Club results are read with the canonical evidence collector and the canonical PB function, read-only.
import { buildFixedTestTemplateRows, canonicalBuiltInTestTemplate } from './capability-engine/src/utils/testTemplateCatalog.js';
import { buildCanonicalSwimmerEvidence } from './capability-engine/src/utils/canonicalSwimmerEvidence.js';
import { personalBestsByCourse, raceEventLabel } from './capability-engine/src/utils/coursePersonalBests.js';
import { competitionCourse, timeSeconds } from './capability-engine/src/utils/repResultCells.js';
import { clubFixturesForSwimmer } from './athlete-competitions.mjs';

const text = (value, max = 160) => String(value ?? '').trim().slice(0, max);
const asArray = (value) => (Array.isArray(value) ? value : []);
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
const isClock = (value) => /^(?:\d{1,2}:)?\d{1,2}(?:\.\d{1,2})?$/.test(String(value || '')) && timeSeconds(String(value)) > 0;
const STROKES = new Set(['free', 'back', 'breast', 'fly', 'im']);
const COURSES = new Set(['SCM', 'LCM', 'SCY']);
const RACE_DISTANCES = new Set([25, 50, 100, 200, 400, 800, 1500]);
const CHECKIN = new Set(['', 'Yes', 'No', 'Partly', 'Not sure']);

class InvalidTest extends Error {}
const fail = (message) => { throw new InvalidTest(message); };

// Canonical protocols, built from the catalogue (no second copy of the definitions).
export function testProtocols() {
  const fixed = buildFixedTestTemplateRows().map((row) => ({
    id: row.id, category: row.category === 'repeat' ? 'repeatability' : 'max', label: row.label,
    reps: row.reps, distance: row.distance, sendOff: row.sendOff, stroke: row.stroke, guidance: row.guidance, recurrenceEveryWeeks: row.recurrenceEveryWeeks,
  }));
  const aerobic = canonicalBuiltInTestTemplate('5x400');
  const row = aerobic.rows[0];
  return [
    ...fixed,
    { id: 'aerobic-5x400', category: 'aerobic', label: row.label, reps: row.reps, distance: row.distance, sendOff: row.sendOff, stroke: row.stroke, guidance: row.protocol, recurrenceEveryWeeks: row.recurrenceEveryWeeks, catalogueNote: aerobic.notes },
    { id: 'race', category: 'race', label: 'Competition race', reps: 1, distance: null, sendOff: '', stroke: '', guidance: 'One swim at a competition. Choose the pool course so race history stays comparable.' },
  ];
}

function splitsChecked(values, mode, total, where) {
  const splits = asArray(values).map((v) => text(v, 12)).filter(Boolean);
  if (splits.length > 60) fail(`${where}: too many splits.`);
  if (splits.some((v) => !isClock(v))) fail(`${where}: one or more splits are invalid.`);
  if (!splits.length) return { splits, mode: '' };
  const secs = splits.map((v) => timeSeconds(v));
  if (mode === 'cumulative') {
    if (secs.some((v, i) => i && v <= secs[i - 1])) fail(`${where}: cumulative splits must increase.`);
    if (Math.abs(secs.at(-1) - total) > 0.11) fail(`${where}: the final cumulative split must match the finish time.`);
  } else if (mode === 'individual') {
    if (Math.abs(secs.reduce((a, b) => a + b, 0) - total) > 0.11) fail(`${where}: individual segments must add up to the finish time.`);
  } else fail(`${where}: choose cumulative or individual splits.`);
  return { splits, mode };
}
function strokesChecked(values, count, where) {
  const strokes = asArray(values).filter((v) => v !== '' && v !== null && v !== undefined).map(Number);
  if (!strokes.length) return [];
  if (strokes.length !== count || strokes.some((n) => !Number.isInteger(n) || n < 1 || n > 999)) fail(`${where}: enter one whole-number stroke count for each recorded time, or none.`);
  return strokes;
}

// Normalises one self-reported test or race. `previous` is the stored version (for the amendment trail).
export function normalizeTest(raw = {}, previous = null, { now = new Date().toISOString() } = {}) {
  const protocol = testProtocols().find((p) => p.id === raw.protocolId);
  if (!protocol) fail('Choose a test from the catalogue.');
  if (!isDate(raw.date)) fail('A valid date is required.');
  const stroke = text(raw.stroke, 10).toLowerCase() || protocol.stroke;
  if (!STROKES.has(stroke)) fail('Choose a stroke.');
  const course = text(raw.course, 4).toUpperCase();
  if (course && !COURSES.has(course)) fail('Course must be 25 m, 50 m or 25 yd.');
  const out = {
    protocolId: protocol.id, category: protocol.category, testType: protocol.label, date: raw.date, stroke, course,
    reps: protocol.reps, distance: protocol.distance, sendoff: text(raw.sendoff, 12) || protocol.sendOff || '',
    comment: text(raw.comment, 3000), source: 'athlete-entered', verification: 'athlete-entered-unverified',
  };
  if (out.sendoff && !/^(?:\d{1,2}:)?\d{1,2}$/.test(out.sendoff)) fail('Send-off must be seconds or m:ss.');
  if (protocol.category === 'race') {
    const distance = Number(raw.distance);
    if (!RACE_DISTANCES.has(distance)) fail('Race distance must be 25, 50, 100, 200, 400, 800 or 1500.');
    if (!course) fail('Choose a pool course for comparable race history.');
    out.distance = distance;
    out.meet = text(raw.meet);
    out.fixtureId = text(raw.fixtureId, 96);
    const q = raw.raceCheckIn || {};
    const checkIn = {};
    for (const key of ['plan', 'technique', 'pacing', 'ready']) { const v = text(q[key], 12); if (!CHECKIN.has(v)) fail('Race check-in answers are Yes, No, Partly or Not sure.'); if (v) checkIn[key] = v; }
    if (q.effort !== undefined && q.effort !== null && q.effort !== '') { const e = Number(q.effort); if (!Number.isInteger(e) || e < 1 || e > 7) fail('Race effort must be 1–7.'); checkIn.effort = e; }
    if (text(q.note, 3000)) checkIn.note = text(q.note, 3000);
    out.raceCheckIn = checkIn;
  }
  if (protocol.category === 'race' || protocol.category === 'max') {
    if (!isClock(raw.time)) fail('A valid positive time (seconds or m:ss.xx) is required.');
    out.time = text(raw.time, 12);
    const s = splitsChecked(raw.splits, text(raw.splitMode, 12), timeSeconds(out.time), 'Splits');
    out.splits = s.splits; out.splitMode = s.mode;
    out.strokes = strokesChecked(raw.strokes, s.splits.length, 'Strokes');
  } else {
    const times = asArray(raw.repTimes).map((v) => text(v, 12));
    if (times.length !== protocol.reps || times.some((v) => !isClock(v))) fail(`Enter all ${protocol.reps} repetition times (seconds or m:ss.xx).`);
    out.repTimes = times;
    out.strokes = strokesChecked(raw.strokes, times.length, 'Strokes');
    const secs = times.map((v) => timeSeconds(v));
    const mean = secs.reduce((a, b) => a + b, 0) / secs.length;
    out.statistics = { n: secs.length, mean: Math.round(mean * 100) / 100, best: Math.min(...secs), slowest: Math.max(...secs), spread: Math.round((Math.max(...secs) - Math.min(...secs)) * 100) / 100 };
  }
  // Amendment trail (Master v31): every edit of a saved entry records what changed, server-side.
  const tracked = ['date', 'protocolId', 'stroke', 'course', 'distance', 'sendoff', 'time', 'splits', 'splitMode', 'strokes', 'repTimes', 'meet', 'comment', 'raceCheckIn'];
  const prev = previous && typeof previous === 'object' ? previous : null;
  out.amendments = asArray(prev?.amendments).slice(-50);
  if (prev) {
    const changed = tracked.filter((k) => JSON.stringify(prev[k] ?? '') !== JSON.stringify(out[k] ?? '')).map((k) => ({ field: k, before: JSON.stringify(prev[k] ?? ''), after: JSON.stringify(out[k] ?? '') }));
    if (changed.length) out.amendments.push({ at: now, changed });
  }
  return out;
}
export { InvalidTest };

// ---------------- progress (self-reported, and club results read-only) ----------------
const raceRow = (t) => ({ distance: t.distance, stroke: t.stroke, resultValue: t.time, raw: { course: t.course } });
function pbSections(rows) {
  return personalBestsByCourse(rows).map((section) => ({
    course: section.course, events: section.events.map((e) => ({ event: e.eventLabel, distance: e.distance, time: e.best.time, date: e.best.row?.date || '', races: e.races })),
  }));
}
export function buildSelfReportedProgress(testRecords = []) {
  const tests = asArray(testRecords).filter((r) => r && !r.deleted && r.data).map((r) => ({ id: r.id, ...r.data }));
  const races = tests.filter((t) => t.category === 'race').map((t) => ({ ...raceRow(t), date: t.date }));
  return { label: 'Self-reported / Unverified', tests: tests.sort((a, b) => String(b.date).localeCompare(String(a.date))), personalBests: pbSections(races) };
}

const safeTest = (row) => ({
  id: text(row.id, 96), date: text(row.date, 10), testType: text(row.testType), distance: Number(row.distance) || null, stroke: text(row.stroke, 20),
  result: text(row.resultValue ?? '', 20), reps: asArray(row.repResults).map((r) => text(r?.time || r?.overallTime || r?.swimTime || r?.value || '', 12)).filter(Boolean).slice(0, 40),
});
const safeRace = (row) => ({
  id: text(row.id, 160), date: text(row.date, 10), competition: text(row.fixtureName), event: raceEventLabel(row, competitionCourse(row).unit),
  distance: Number(row.distance) || null, stroke: text(row.stroke, 20), course: competitionCourse(row).short || '', result: text(row.resultValue ?? '', 20), pb: row.pb === true,
});
// The linked swimmer's own club tests, races and PBs, read-only. Data scopes of the connection apply.
export function buildClubResults(db = {}, swimmerId = '', { tenantId = '', dataScopes = null } = {}) {
  if (!text(swimmerId)) return null;
  // A connection without listed scopes shares everything the club shares with the athlete; a list limits it.
  const allows = (scope) => !Array.isArray(dataScopes) || !dataScopes.length || dataScopes.includes(scope);
  const evidence = buildCanonicalSwimmerEvidence({ db, swimmerId, activeTenantId: tenantId });
  const tests = allows('tests') ? asArray(evidence.completedTests).map(safeTest).sort((a, b) => b.date.localeCompare(a.date)) : [];
  const competitions = allows('competition') ? asArray(evidence.completedCompetitions) : [];
  return {
    label: 'Validated club records (read-only)',
    tests, races: competitions.map(safeRace).sort((a, b) => b.date.localeCompare(a.date)),
    personalBests: competitions.length ? pbSections(competitions) : [],
    fixtures: allows('competition') ? clubFixturesForSwimmer(db, swimmerId) : [],
    scopes: { tests: allows('tests'), competition: allows('competition') },
  };
}
