import { WORLD_RECORD_BASE_TIMES, WORLD_RECORD_META } from '../data/worldRecordBaseTimes.js';
// World Aquatics (formerly FINA) points: P = 1000 × (B / T)³, where B is the
// base time of the event (the world record, by course, sex, stroke and
// distance) and T the swim time. The cubic scale spreads swimmers from age
// group to Olympic level; the radar shows P / 10 (world record = 100, not a ceiling).
//
// Base times are the current world records (long and short course metres),
// kept in src/data/worldRecordBaseTimes.js and refreshed automatically by the
// weekly world-records workflow.
// A 25 m swim is not a World Aquatics event: its base is derived from the 50 m
// base with the former world-class 25/50 ratio (labelled as derived).
const BASE = WORLD_RECORD_BASE_TIMES;
export const WORLD_AQUATICS_BASE_TIMES = BASE;
export const WORLD_AQUATICS_BASE_META = WORLD_RECORD_META;
const DERIVED_25_OVER_50 = { female: 10.7 / 23.6, male: 9.5 / 20.9 };

export function strokeKey(stroke) {
  const token = String(stroke || '').trim().toLowerCase();
  if (/medley|\bim\b|individual/.test(token)) return 'medley';
  if (/breast/.test(token)) return 'breast';
  if (/back/.test(token)) return 'back';
  if (/fly|butter/.test(token)) return 'fly';
  if (/freestyle|free|front\s*crawl|crawl|^fr$/.test(token)) return 'free';
  return null; // choice, mixed or unrecorded: no event, no points
}
// Any pool: a yard pool is 'SCY'; a metre pool of 45 m or more is long
// course, any shorter metre pool (20, 25, 33⅓ m) short course.
export function courseKey(course) {
  const token = String(course ?? '').trim().toLowerCase();
  if (['50', '50m', 'lc', 'lcm', 'long', 'long course'].includes(token)) return 'LC';
  if (['25', '25m', 'sc', 'scm', 'short', 'short course'].includes(token)) return 'SC';
  if (/^(scy|lcy|\d+(\.\d+)?\s*(y|yd|yds|yards?))$/.test(token)) return 'SCY';
  const metres = token.match(/^(\d+(?:\.\d+)?)\s*m?$/);
  if (metres) return Number(metres[1]) >= 45 ? 'LC' : Number(metres[1]) > 0 ? 'SC' : null;
  return null;
}
// Yard swims: no World Aquatics event, so they are scored at the same pace
// over the matching short course metre event (same number of turns for
// 50/100/200; 500 → 400, 1000 → 800, 1650 → 1500): equivalent time =
// time × metre distance ÷ (yards × 0.9144). Approximate and labelled.
const YARD_TO_METRE_EVENT = { 500: 400, 1000: 800, 1650: 1500 };
function sexKey(sex) {
  const token = String(sex || '').trim().toLowerCase();
  if (/female|wom[ae]n|girls?|ladies|^f$/.test(token)) return 'female';
  if (/male|\bm[ae]n\b|boys?|^m$/.test(token)) return 'male';
  return null;
}

function baseFor(course, sex, stroke, distance) {
  const events = BASE[course]?.[sex]?.[stroke];
  if (!events) return null;
  if (Number.isFinite(events[distance])) return { base: events[distance], derived: false };
  if (distance === 25 && Number.isFinite(events[50])) return { base: events[50] * DERIVED_25_OVER_50[sex], derived: true };
  return null;
}

/**
 * World Aquatics points of one swim, or null when the swim is not an event the
 * table covers. An unrecorded course uses short course base times (faster, so
 * never inflating); an unrecorded sex uses the mean of the women's and men's
 * base times.
 */
export function worldAquaticsPoints({ time, distance, stroke, sex, course }) {
  const seconds = Number(time);
  const metres = Number(distance);
  const family = strokeKey(stroke);
  if (!(seconds > 0) || !(metres > 0) || !family) return null;
  const recordedPool = courseKey(course);
  const yards = recordedPool === 'SCY';
  const pool = yards ? 'SC' : recordedPool || 'SC';
  const eventMetres = yards ? (YARD_TO_METRE_EVENT[metres] || metres) : metres;
  const equivalentSeconds = yards ? seconds * eventMetres / (metres * 0.9144) : seconds;
  const resolvedSex = sexKey(sex);
  const bases = (resolvedSex ? [resolvedSex] : ['female', 'male']).map((key) => baseFor(pool, key, family, eventMetres));
  if (bases.some((row) => !row)) return null;
  const base = bases.reduce((sum, row) => sum + row.base, 0) / bases.length;
  return { points: 1000 * (base / equivalentSeconds) ** 3, base, course: pool, courseRecorded: Boolean(recordedPool),
    convertedFromYards: yards, equivalentSeconds, derivedBase: bases.some((row) => row.derived), sexRecorded: Boolean(resolvedSex) };
}

/**
 * Radar score = World Aquatics points / 10: world record = 100, which is a
 * reference, not a ceiling (a swim faster than the base time scores above 100).
 */
export const worldAquaticsScore = (args) => {
  const result = worldAquaticsPoints(args);
  return result ? Math.max(0, result.points / 10) : null;
};
