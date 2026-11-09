// Efficiency reference settings, in one place so they are easy to change.
//
// PUSH_OFF_ALLOWANCE_METRES_PER_WALL: when a swim has no recorded underwater
// distance (coach entry or sensor), this many metres per wall (start and each
// turn) are treated as push-off / glide, not stroked, before distance per
// stroke is calculated. A recorded underwater distance always replaces it.
// Swims using it are labelled "estimated push-off". Owner decision 26-10-2026.
// A club can override it with db.efficiencyCalibration.pushOffMetresPerWall.
export const PUSH_OFF_ALLOWANCE_METRES_PER_WALL = 5;

export function resolvePushOffAllowance(db) {
  const configured = Number(db?.efficiencyCalibration?.pushOffMetresPerWall);
  return Number.isFinite(configured) && configured >= 0 && configured <= 15 ? configured : PUSH_OFF_ALLOWANCE_METRES_PER_WALL;
}

// ---------------------------------------------------------------------------
// Elite Stroke Index reference (Efficiency axis). Reviewed 2026-11-09.
//
// Stroke Index (SI, Costill et al. 1985) = speed × distance per stroke cycle.
// It is a stroke-economy INDICATOR from time and stroke counts. It is NOT
// propelling efficiency (ηp = useful work ÷ total work; Toussaint & Hollander
// 1994), which needs force or energy measurement that AthlyraX does not record.
//
// Reference SI = v² × 60 ÷ SR, with
//   v  = event distance ÷ the current WORLD RECORD of the same stroke, distance,
//        sex and pool course (src/data/worldRecordBaseTimes.js, updated weekly);
//   SR = elite stroke rate in cycles per minute (table below).
// Both sides use whole-race average speed and stroke cycles over the stroked
// (surface) distance, so the swimmer's SI = v × DPC is on the same basis
// (v × DPC = v² × 60 ÷ SR when stroking time is taken at the race-average speed).
// No reference (and no elite score) where a world record or a stroke rate is
// not available: 25 m swims, 800/1500 m, yards and medley. Those swims are
// still measured and tracked as within-swimmer change.
//
// Stroke-rate sources (reviewed 2026-11-09/10). 200 m entries use PRIMARY data:
//   Gonjo T, Polach M, et al. Differences in race characteristics between world-class
//   individual-medley and stroke-specialist swimmers. Int J Environ Res Public Health
//   2022;19(20):13578. doi:10.3390/ijerph192013578. 2021 European long-course
//   championships, 200 m finals, stroke-specialist finalists (n = 8 per event and sex),
//   clean-swimming stroke rate in cycles/min (mean of 15 m and 35 m marks) in one lap:
//   butterfly lap 1, backstroke lap 2, breaststroke lap 3, freestyle lap 4.
//   Caveats: one lap per event, European finalists (FINA points ~880–906), long course.
// All other entries (50, 100, 400 m) remain PROVISIONAL: no accessible primary source
// with event means was found (the 2019 European short-course freestyle study,
// doi:10.3389/fspor.2025.1656633, reports correlations, not mean stroke rates).
// A world-class reference is not a ceiling: a valid measurement above it is
// recognised (after coach verification) and its % of reference is kept uncapped.
import { WORLD_RECORD_BASE_TIMES } from './worldRecordBaseTimes.js';

// Values in cycles/min. PRIMARY_200M entries replace the earlier provisional 200 m values
// (free F45 M43, back F44 M42, breast F40 M38, fly F48 M46).
export const ELITE_STROKE_RATE_PROVISIONAL = Object.freeze({
  free: { female: { 50: 60, 100: 52, 200: 44.16, 400: 42 }, male: { 50: 60, 100: 50, 200: 45.84, 400: 39 } },
  back: { female: { 50: 54, 100: 50, 200: 39.06 }, male: { 50: 54, 100: 49, 200: 39.40 } },
  breast: { female: { 50: 58, 100: 54, 200: 34.67 }, male: { 50: 58, 100: 52, 200: 34.62 } },
  fly: { female: { 50: 58, 100: 54, 200: 51.71 }, male: { 50: 58, 100: 52, 200: 50.85 } },
});
export const ELITE_STROKE_RATE_SOURCES = Object.freeze({
  primary200m: 'Gonjo et al. 2022, doi:10.3390/ijerph192013578 (2021 European LC 200 m finals, stroke specialists, one lap)',
});
// 'primary' when the stroke rate for this stroke and distance comes from the cited primary source.
export const eliteStrokeRateBasis = (stroke, distance) => (efficiencyStrokeFamily(stroke) && Number(distance) === 200 ? 'primary' : 'provisional');
export const EFFICIENCY_REFERENCE_STATUS = 'provisional (200 m stroke rates from a primary source; 50/100/400 m provisional)';

export function efficiencyStrokeFamily(stroke) {
  const token = String(stroke || '').trim().toLowerCase();
  if (/medley|\bim\b|choice|mixed|drill|kick/.test(token)) return null;
  if (/breast/.test(token)) return 'breast';
  if (/back/.test(token)) return 'back';
  if (/fly|butter/.test(token)) return 'fly';
  if (/free|crawl|^fr$|^$/.test(token)) return 'free';
  return null;
}
const sexOf = (value) => {
  const token = String(value || '').trim().toLowerCase();
  if (/female|wom[ae]n|girls?|ladies|\bf\b/.test(token)) return 'female';
  if (/male|\bm[ae]n\b|boys?|\bm\b/.test(token)) return 'male';
  return 'open';
};
// Pool course of a swim: 'LC' for a 50 m pool, 'SC' for a 25 m pool, null for yards / other.
export function efficiencyCourse({ unit = 'm', poolLength = 25 } = {}) {
  if (String(unit).toLowerCase().startsWith('y')) return null;
  const pool = Number(poolLength);
  return pool === 50 ? 'LC' : pool === 25 ? 'SC' : null;
}

// Reference SI in m²/s, or null when no validated inputs exist for this swim.
export function eliteStrokeIndexReference({ distance, stroke, sex, course = 'LC' }) {
  const family = efficiencyStrokeFamily(stroke);
  const d = Number(distance);
  if (!family || !(d > 0) || !WORLD_RECORD_BASE_TIMES[course]) return null;
  // Sex not recorded: the mean of the women's and men's world records with the mean stroke rate.
  const sexes = sexOf(sex) === 'open' ? ['female', 'male'] : [sexOf(sex)];
  const records = sexes.map((s) => Number(WORLD_RECORD_BASE_TIMES[course]?.[s]?.[family]?.[d]));
  const rates = sexes.map((s) => Number(ELITE_STROKE_RATE_PROVISIONAL[family]?.[s]?.[d]));
  if (records.some((v) => !(v > 0)) || rates.some((v) => !(v > 0))) return null;
  const record = records.reduce((a, b) => a + b, 0) / records.length;
  const rate = rates.reduce((a, b) => a + b, 0) / rates.length;
  return ((d / record) ** 2 * 60) / rate;
}
