// Personal training for the Athlete App: the athlete's own timetable (planned sessions, weekly series)
// and training days (what was actually done: sets, repetition times, splits, stroke counts, check-in).
// Functional reference: AthlyraX Athlete Master v31 (timetable, training day, poolside stopwatch).
//
// Ownership: the store belongs to the athlete's account, never to a club, so it survives club changes
// and never modifies a coach's plan. Coach sessions are only referenced (coachSessionId).
// Self-reported: every result recorded here is athlete-entered and unverified; it is never mixed with
// the club's validated evidence.
//
// Offline sync: each record carries a server revision. A change must name the revision it was based
// on; a change based on an older revision is refused as a conflict and the server copy is returned,
// so nothing is silently overwritten. Repeating an already applied change is harmless (idempotent).
// Deletions are kept as tombstones so a device that was offline cannot bring a deleted record back.
import crypto from 'node:crypto';
import path from 'node:path';
import { normalizeTest, InvalidTest } from './athlete-tests-races.mjs';
import { normalizeFixture, normalizeReflection, InvalidCompetitionRecord } from './athlete-competitions.mjs';
import { normalizeDiary, normalizeGoal, normalizeWeekPlan, InvalidDevelopmentRecord } from './athlete-development.mjs';

export const PERSONAL_TRAINING_KINDS = Object.freeze(['plan', 'day', 'test', 'fixture', 'reflection', 'diary', 'goal', 'week']);
export const PERSONAL_TRAINING_LIMITS = Object.freeze({
  plans: 3000, days: 5000, tests: 10000, fixtures: 1000, reflections: 2000, diary: 10000, goals: 150, weeks: 600, changesPerSync: 200,
  sessionsPerDay: 12, setsPerSession: 60, setsPerPlan: 60,
  rounds: 20, reps: 100, distance: 3000, splitsPerRep: 120, text: 3000, shortText: 160,
});
const STROKES = new Set(['free', 'back', 'breast', 'fly', 'im', 'choice', 'kick', 'pull', 'drill', 'mixed', '']);
const YES_NO = new Set(['', 'Yes', 'No', 'Not sure']);
const COMPLETED = new Set(['Full', 'Partial', 'Missed']);
const FEEL = new Set(['Easy', 'Moderate', 'Hard', 'Very hard']);
const ACTIVITY = new Set(['Swim', 'Land', 'Competition', 'Recovery']);
const POOLS = new Set(['SCM', 'LCM', 'SCY', '']);

const text = (value, max = PERSONAL_TRAINING_LIMITS.shortText) => String(value ?? '').trim().slice(0, max);
const asArray = (value) => (Array.isArray(value) ? value : []);
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
const isTime = (value) => value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value));
const isClock = (value) => value === '' || /^(?:\d{1,3}:)?\d{1,2}(?:\.\d{1,2})?$/.test(String(value));
const isId = (value) => /^[A-Za-z0-9_.:@-]{4,96}$/.test(String(value || ''));
const intIn = (value, min, max) => Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;

class InvalidRecord extends Error {}
const fail = (message) => { throw new InvalidRecord(message); };

function plannedSet(raw = {}, where) {
  if (!isId(raw.id)) fail(`${where}: set id is missing or invalid.`);
  const rounds = raw.rounds === undefined || raw.rounds === null || raw.rounds === '' ? 1 : Number(raw.rounds);
  if (!intIn(rounds, 1, PERSONAL_TRAINING_LIMITS.rounds)) fail(`${where}: rounds must be 1–${PERSONAL_TRAINING_LIMITS.rounds}.`);
  if (!intIn(raw.reps, 1, PERSONAL_TRAINING_LIMITS.reps)) fail(`${where}: repetitions must be 1–${PERSONAL_TRAINING_LIMITS.reps}.`);
  if (!intIn(raw.distance, 1, PERSONAL_TRAINING_LIMITS.distance)) fail(`${where}: distance must be 1–${PERSONAL_TRAINING_LIMITS.distance} m.`);
  const stroke = text(raw.stroke).toLowerCase();
  if (!STROKES.has(stroke)) fail(`${where}: unknown stroke.`);
  for (const key of ['sendoff', 'rest', 'pace']) if (!isClock(text(raw[key]))) fail(`${where}: ${key} must be seconds or m:ss.`);
  const stagger = raw.stagger === undefined || raw.stagger === null || raw.stagger === '' ? 0 : Number(raw.stagger);
  if (!intIn(stagger, 0, 600)) fail(`${where}: stagger must be 0–600 seconds.`);
  return {
    id: String(raw.id), order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
    type: text(raw.type) || 'General training set', rounds, reps: Number(raw.reps), distance: Number(raw.distance), stroke,
    sendoff: text(raw.sendoff), rest: text(raw.rest), pace: text(raw.pace), stagger,
    energy: text(raw.energy, 20), notes: text(raw.notes, PERSONAL_TRAINING_LIMITS.text),
  };
}

function repResult(raw = {}, set, where) {
  if (!intIn(raw.rep, 1, set.reps * set.rounds)) fail(`${where}: repetition number out of range.`);
  const swimTime = text(raw.swimTime);
  if (!swimTime || !isClock(swimTime)) fail(`${where}: repetition time must be seconds or m:ss.xx.`);
  const splits = asArray(raw.cumulativeSplits).map((v) => text(v));
  if (splits.length > PERSONAL_TRAINING_LIMITS.splitsPerRep || splits.some((v) => !v || !isClock(v))) fail(`${where}: invalid splits.`);
  const strokes = raw.strokes === null || raw.strokes === undefined || raw.strokes === '' ? null : Number(raw.strokes);
  if (strokes !== null && !intIn(strokes, 1, 999)) fail(`${where}: stroke count must be 1–999.`);
  const poolLength = raw.poolLength === undefined || raw.poolLength === null ? null : Number(raw.poolLength);
  if (poolLength !== null && ![25, 50, 22.86, 45.72].includes(poolLength)) fail(`${where}: pool length must be 25 or 50.`);
  return {
    rep: Number(raw.rep), swimTime, strokes, cumulativeSplits: splits, poolLength,
    startOffsetSeconds: Number.isFinite(Number(raw.startOffsetSeconds)) ? Math.max(0, Number(raw.startOffsetSeconds)) : null,
    source: text(raw.source) || 'athlete-entered', verification: 'athlete-entered-unverified',
    capturedAt: text(raw.capturedAt, 40),
  };
}

export function normalizePlan(raw = {}) {
  if (!isDate(raw.date)) fail('Plan: a valid date is required.');
  const repeat = raw.repeat === 'weekly' ? 'weekly' : 'none';
  const until = repeat === 'weekly' ? text(raw.until) : '';
  if (repeat === 'weekly' && (!isDate(until) || until < raw.date || Date.parse(until) - Date.parse(raw.date) > 366 * 86400000)) fail('Plan: weekly recurrence needs an end date within one year.');
  if (!isTime(text(raw.start)) || !isTime(text(raw.end))) fail('Plan: times must be HH:MM.');
  if (text(raw.start) && text(raw.end) && text(raw.end) <= text(raw.start)) fail('Plan: end time must be later than start time.');
  const pool = text(raw.pool).toUpperCase();
  if (!POOLS.has(pool)) fail('Plan: pool must be SCM, LCM or SCY.');
  const sets = asArray(raw.sets);
  if (sets.length > PERSONAL_TRAINING_LIMITS.setsPerPlan) fail('Plan: too many sets.');
  const excludedDates = [...new Set(asArray(raw.excludedDates).filter(isDate))].slice(0, 60);
  return {
    kind: raw.kind === 'extra' ? 'extra' : 'personal', date: raw.date, start: text(raw.start), end: text(raw.end), pool,
    title: text(raw.title) || 'Personal Training', venue: text(raw.venue), phase: text(raw.phase), cycle: text(raw.cycle),
    focus: text(raw.focus), secondary: text(raw.secondary), repeat, until, excludedDates, note: text(raw.note, PERSONAL_TRAINING_LIMITS.text),
    sets: sets.map((set, i) => plannedSet(set, `Plan set ${i + 1}`)),
  };
}

export function normalizeDay(raw = {}) {
  if (!isDate(raw.date)) fail('Training day: a valid date is required.');
  const sessions = asArray(raw.sessions);
  if (!sessions.length || sessions.length > PERSONAL_TRAINING_LIMITS.sessionsPerDay) fail(`Training day: 1–${PERSONAL_TRAINING_LIMITS.sessionsPerDay} sessions.`);
  return {
    date: raw.date,
    sessions: sessions.map((session, i) => {
      const where = `Session ${i + 1}`;
      if (!isId(session.id)) fail(`${where}: id is missing or invalid.`);
      const sets = asArray(session.sets);
      if (sets.length > PERSONAL_TRAINING_LIMITS.setsPerSession) fail(`${where}: too many sets.`);
      const questionnaire = {};
      for (const key of ['planned', 'recovered', 'technique', 'discomfort', 'coach']) {
        const v = text(session.questionnaire?.[key]);
        if (!YES_NO.has(v)) fail(`${where}: check-in answers are Yes, No or Not sure.`);
        if (v) questionnaire[key] = v;
      }
      const effort = session.effort === '' || session.effort === null || session.effort === undefined ? null : Number(session.effort);
      if (effort !== null && !intIn(effort, 1, 10)) fail(`${where}: effort (RPE) must be 1–10.`);
      const pool = text(session.pool).toUpperCase();
      if (!POOLS.has(pool)) fail(`${where}: pool must be SCM, LCM or SCY.`);
      return {
        id: String(session.id), label: text(session.label) || `Session ${i + 1}`,
        type: ACTIVITY.has(session.type) ? session.type : 'Swim',
        completed: COMPLETED.has(session.completed) ? session.completed : 'Full',
        feel: FEEL.has(session.feel) ? session.feel : 'Moderate', pool,
        planId: isId(session.planId) ? String(session.planId) : '', occurrenceDate: isDate(session.occurrenceDate) ? session.occurrenceDate : '',
        coachSessionId: isId(session.coachSessionId) ? String(session.coachSessionId) : '',
        coachTitle: text(session.coachTitle),
        questionnaire, effort, reflection: text(session.reflection, PERSONAL_TRAINING_LIMITS.text),
        sets: sets.map((raw, j) => {
          const set = plannedSet(raw, `${where} set ${j + 1}`);
          const results = asArray(raw.results).map((r, k) => repResult(r, set, `${where} set ${j + 1} rep ${k + 1}`));
          if (new Set(results.map((r) => r.rep)).size !== results.length) fail(`${where} set ${j + 1}: a repetition is recorded twice.`);
          return { ...set, results: results.sort((a, b) => a.rep - b.rep) };
        }),
      };
    }),
  };
}

const normalizers = { plan: (raw) => normalizePlan(raw), day: (raw) => normalizeDay(raw), test: (raw, previous, now) => normalizeTest(raw, previous, { now }), fixture: (raw) => normalizeFixture(raw), reflection: (raw) => normalizeReflection(raw), diary: (raw) => normalizeDiary(raw), goal: (raw) => normalizeGoal(raw), week: (raw) => normalizeWeekPlan(raw) };
const COLLECTIONS = { plan: 'plans', day: 'days', test: 'tests', fixture: 'fixtures', reflection: 'reflections', diary: 'diary', goal: 'goals', week: 'weeks' };
const collection = (kind) => COLLECTIONS[kind];

export function emptyPersonalTraining() {
  return { version: 1, plans: {}, days: {}, tests: {}, fixtures: {}, reflections: {}, diary: {}, goals: {}, weeks: {}, updatedAt: '' };
}

// Applies a batch of offline changes. Returns the next store (or null when nothing changed) and, per
// change, applied / conflict / invalid. Never throws for a bad change: it is reported and skipped.
export function applyPersonalTrainingChanges(store = emptyPersonalTraining(), changes = [], { now = new Date().toISOString(), actor = '' } = {}) {
  const next = { ...emptyPersonalTraining(), ...store };
  for (const name of Object.values(COLLECTIONS)) next[name] = { ...(store[name] || {}) };
  const results = [];
  let changed = false;
  for (const change of asArray(changes).slice(0, PERSONAL_TRAINING_LIMITS.changesPerSync)) {
    const kind = String(change?.kind || '');
    const id = String(change?.id || '');
    if (!PERSONAL_TRAINING_KINDS.includes(kind) || !isId(id)) { results.push({ kind, id, status: 'invalid', error: 'Unknown record kind or invalid id.' }); continue; }
    const bucket = next[collection(kind)];
    const current = bucket[id] || null;
    const baseRev = Number(change.baseRev) || 0;
    const deleted = change.deleted === true;
    let data = null;
    if (!deleted) {
      try { data = normalizers[kind](change.data || {}, current && !current.deleted ? current.data : null, now); }
      catch (error) {
        if (error instanceof InvalidRecord || error instanceof InvalidTest || error instanceof InvalidCompetitionRecord || error instanceof InvalidDevelopmentRecord) { results.push({ kind, id, status: 'invalid', error: error.message }); continue; }
        throw error;
      }
    }
    // Server-owned fields (the amendment trail) do not count when deciding whether a change repeats.
    const comparable = (d) => (d && typeof d === 'object' ? { ...d, amendments: undefined } : d);
    const same = current && current.deleted === deleted && JSON.stringify(comparable(current.data)) === JSON.stringify(comparable(kind === 'test' && data ? normalizers.test(change.data || {}, null, now) : data));
    if (same) { results.push({ kind, id, status: 'applied', rev: current.rev, unchanged: true }); continue; }
    if ((current ? current.rev : 0) !== baseRev) { results.push({ kind, id, status: 'conflict', server: current }); continue; }
    if (!current && deleted) { results.push({ kind, id, status: 'applied', rev: 0, unchanged: true }); continue; }
    const limit = PERSONAL_TRAINING_LIMITS[collection(kind)];
    if (!current && Object.keys(bucket).length >= limit) { results.push({ kind, id, status: 'invalid', error: 'Storage limit reached for this record type.' }); continue; }
    const record = { kind, id, rev: (current ? current.rev : 0) + 1, deleted, data: deleted ? null : data, updatedAt: now, updatedBy: actor, createdAt: current?.createdAt || now };
    bucket[id] = record;
    changed = true;
    results.push({ kind, id, status: 'applied', rev: record.rev });
  }
  if (changed) next.updatedAt = now;
  return { store: changed ? next : null, results };
}

export function listPersonalTraining(store = emptyPersonalTraining()) {
  return {
    plans: Object.values(store.plans || {}),
    days: Object.values(store.days || {}),
    tests: Object.values(store.tests || {}),
    fixtures: Object.values(store.fixtures || {}),
    reflections: Object.values(store.reflections || {}),
    diary: Object.values(store.diary || {}),
    goals: Object.values(store.goals || {}),
    weeks: Object.values(store.weeks || {}),
    updatedAt: store.updatedAt || '',
  };
}

// One store file per account; the account key is hashed so it can never form a path.
export function personalTrainingPath(storageRoot, accountKey) {
  const key = String(accountKey || '').trim().toLowerCase();
  if (!key) throw new Error('Account key required.');
  const digest = crypto.createHash('sha256').update(`athlyrax-personal-training:${key}`).digest('hex').slice(0, 40);
  return path.join(storageRoot, 'athletes', digest, 'personal-training.json');
}
