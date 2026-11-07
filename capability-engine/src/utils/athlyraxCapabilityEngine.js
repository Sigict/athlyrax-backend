import { buildCanonicalSwimmerEvidence } from './canonicalSwimmerEvidence.js';
import { buildPlannerAuthoritativeSetRows, resolveIspPlannerSetVolume } from './ispPlannerSource.js';
import {
  SWIMMING_CV_STABILITY_ANCHORS,
  SWIMMING_STABILITY_CALIBRATION_VERSION,
} from './olympicCapabilityCalibration.js';
import { getCanonicalScheduleRows } from './canonicalScheduleRows.js';
import { canonicalBuiltInTestTemplate } from './testTemplateCatalog.js';
import { resolveCompetitionCourseKey, isYardCourseKey } from './competitionCourse.js';
import { buildEfficiencyAdaptabilityIndicators } from './efficiencyAdaptabilityIndicators.js';
import { worldAquaticsScore, WORLD_AQUATICS_BASE_TIMES } from './worldAquaticsPoints.js';
import { resolvePushOffAllowance } from '../data/efficiencyReference.js';
import { resolveRecordedProgramSplitLength } from './recordedRaceResultDisplay.js';
import { buildSwimmerScheduleDeliveryRatios } from './swimmerTrainingDeliveryRatios.js';

// v1.4: duplicate metrics removed, first-break = reps held / reps, test sets not
// read as training, confidence no longer weights squad scores. Baselines saved
// under v1.3 are therefore reported as not comparable (never as a change).
// v1.5: timed training sprint sets add Power & Speed sprint stability (same
// definition as the test metric); v1.4 baselines are not comparable.
// v1.6: training results are not read from a session the swimmer's recorded
// attendance marks as absent; v1.5 baselines are not comparable.
// v1.7 (26-10-2026): Efficiency vs elite Stroke Index, Adaptability on the 0.4 %
// scale, World Aquatics points for speed. Baselines saved under v1.6 are not
// compared numerically with v1.7 scores.
// v1.8 (26-10-2026): one scale for every level, 100 = world-record level and
// not a ceiling (World Aquatics points / 10 can exceed 100); consistency
// metrics are weighted by the swimmer's speed level (fraction of world-record
// speed of their best timed swim), so steady but slow swimming no longer
// scores like elite swimming. v1.7 baselines are not comparable.
export const ATHLYRAX_FULL_ENGINE_VERSION = 'AthlyraX Full V6 Axis Engine v1.8';
export const ATHLYRAX_FULL_ENGINE_CALIBRATION = 'Swimming Capability Calibration v1.3 · ' + SWIMMING_STABILITY_CALIBRATION_VERSION;

export const ATHLYRAX_AXIS_DEFINITIONS = [
  {
    key: 'technical_control',
    label: 'Technical Control',
    exposureTarget: 6,
    metrics: {
      stroke_count_stability: 0.40,
      pace_stability: 0.30,
      turn_consistency: 0.20,
      underwater_consistency: 0.10,
    },
  },
  {
    key: 'efficiency',
    label: 'Efficiency',
    exposureTarget: 6,
    metrics: {
      speed_per_stroke: 0.40,
      cost_per_pace: 0.30,
      heart_rate_efficiency: 0.20,
      stroke_count_economy: 0.10,
    },
  },
  {
    key: 'robustness_of_efficiency',
    label: 'Robustness of Efficiency',
    exposureTarget: 6,
    metrics: {
      efficiency_decay: 0.40,
      stroke_drift: 0.30,
      cost_drift: 0.20,
      fatigue_efficiency_index: 0.10,
    },
  },
  {
    key: 'aerobic_capacity',
    label: 'Aerobic Capacity',
    exposureTarget: 4,
    metrics: {
      threshold_pace: 0.40,
      heart_rate_stability: 0.30,
      pace_stability: 0.20,
      repeatability: 0.10,
    },
  },
  {
    key: 'anaerobic_capacity',
    label: 'Anaerobic Capacity',
    exposureTarget: 4,
    metrics: {
      peak_output: 0.40,
      repeatability: 0.30,
      fatigue_resistance: 0.20,
      recovery_index: 0.10,
    },
  },
  {
    key: 'power_speed_expression',
    label: 'Power & Speed Expression',
    exposureTarget: 4,
    metrics: {
      maximum_velocity: 0.40,
      acceleration: 0.30,
      breakout_quality: 0.20,
      sprint_stability: 0.10,
    },
  },
  {
    key: 'adaptability',
    label: 'Adaptability',
    exposureTarget: 3,
    longitudinal: true,
    metrics: {
      transfer_success: 0.40,
      stabilisation_speed: 0.30,
      learning_rate: 0.20,
      regression_resistance: 0.10,
    },
  },
  {
    key: 'durability',
    label: 'Durability',
    exposureTarget: 4,
    longitudinal: true,
    metrics: {
      first_break_index: 0.40,
      fatigue_resistance: 0.30,
      decay_curve: 0.20,
      late_set_stability: 0.10,
    },
  },
];

const STABILITY_ANCHORS = SWIMMING_CV_STABILITY_ANCHORS;

const SOURCE_WEIGHTS = {
  default: { training: 0.30, testing: 0.50, competition: 0.20 },
  aerobic: { training: 0.35, testing: 0.50, competition: 0.15 },
  race: { training: 0.25, testing: 0.45, competition: 0.30 },
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, min = 0, max = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

// 100 = world-record level is the edge of every radar and the cap (owner
// decision 26-10-2026): an Olympic finalist sits around 90, and when a record
// falls the weekly world-record update makes it the new 100.
export const RADAR_SCORE_CAP = 100;
function atLeastZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(RADAR_SCORE_CAP, numeric)) : 0;
}

// Metrics already measured against world-class swimming (World Aquatics
// points); every other bounded metric stays on its 0-100 scale.
const WORLD_LEVEL_METHODS = new Set(['world-class-time-reference', 'competition-world-class-time-reference']);

// Consistency metrics (variation, drift, decay, fatigue): weighted by the
// swimmer's speed level. Speed-referenced metrics (World Aquatics points,
// elite Stroke Index) and Adaptability (change over time) are not.
const SPEED_WEIGHTED_METRICS = new Set([
  'technical_control|stroke_count_stability', 'technical_control|pace_stability',
  'technical_control|turn_consistency', 'technical_control|underwater_consistency',
  'robustness_of_efficiency|efficiency_decay', 'robustness_of_efficiency|stroke_drift',
  'robustness_of_efficiency|cost_drift', 'robustness_of_efficiency|fatigue_efficiency_index',
  'aerobic_capacity|heart_rate_stability', 'aerobic_capacity|pace_stability', 'aerobic_capacity|repeatability',
  'anaerobic_capacity|repeatability', 'anaerobic_capacity|fatigue_resistance', 'anaerobic_capacity|recovery_index',
  'power_speed_expression|sprint_stability',
]);
const isSpeedWeightedMetric = (record) => record?.kind !== 'trend'
  && (record?.axis === 'durability' || SPEED_WEIGHTED_METRICS.has(`${record?.axis}|${record?.metric}`));

/**
 * The swimmer's speed level: fraction of world-record speed of their best
 * timed test or race in the window, from World Aquatics points
 * (P = 1000·(B/T)³, so B/T = (P/1000)^(1/3) = (score/100)^(1/3)).
 * Null when no timed swim has a World Aquatics reference.
 */
export function swimmerSpeedLevel(records = []) {
  const best = asArray(records)
    .filter((record) => WORLD_LEVEL_METHODS.has(record?.method) && Number.isFinite(Number(record?.score)) && Number(record.score) > 0)
    .sort((a, b) => Number(b.score) - Number(a.score))[0];
  if (!best) return null;
  return { ratio: Math.cbrt(Number(best.score) / 100), points: Number(best.score) * 10, evidenceId: best.evidenceId || '', date: best.date || '' };
}

export const SPEED_LEVEL_NEEDED_REASON = 'Needs a timed test or race: consistency is placed on the world-record scale by the swimmer\'s speed.';

export function applySpeedLevel(records = [], speedLevel = null) {
  if (!speedLevel) return records;
  return records.map((record) => (isSpeedWeightedMetric(record) && Number.isFinite(Number(record.score))
    ? { ...record, consistencyScore: record.score, speedLevel: speedLevel.ratio, score: record.score * speedLevel.ratio }
    : record));
}

function toNumber(value, fallback = Number.NaN) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (/^\d{1,2}:\d{1,2}(?:\.\d+)?$/.test(raw)) {
    const [minutes, seconds] = raw.split(':').map(Number);
    const total = (minutes * 60) + seconds;
    return Number.isFinite(total) ? total : fallback;
  }
  if (/^\d{1,2}:\d{2}:\d{1,2}(?:\.\d+)?$/.test(raw)) {
    const [hours, minutes, seconds] = raw.split(':').map(Number);
    const total = (hours * 3600) + (minutes * 60) + seconds;
    return Number.isFinite(total) ? total : fallback;
  }
  const numeric = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function dateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const dmy = raw.match(/^(\d{2})-(\d{2})-(\d{2,4})$/);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${year}-${dmy[2]}-${dmy[1]}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  const startTs = Date.parse(`${dateKey(start)}T00:00:00Z`);
  const endTs = Date.parse(`${dateKey(end)}T00:00:00Z`);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return 0;
  return Math.max(0, Math.round((endTs - startTs) / 86400000));
}

function mean(values) {
  const valid = asArray(values).filter(Number.isFinite);
  if (!valid.length) return Number.NaN;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function sampleStandardDeviation(values) {
  const valid = asArray(values).filter(Number.isFinite);
  if (valid.length < 2) return Number.NaN;
  const avg = mean(valid);
  const variance = valid.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (valid.length - 1);
  return Math.sqrt(variance);
}

export function coefficientOfVariation(values) {
  const valid = asArray(values).filter((value) => Number.isFinite(value) && value > 0);
  if (valid.length < 2) return Number.NaN;
  const avg = mean(valid);
  if (!Number.isFinite(avg) || avg <= 0) return Number.NaN;
  const sd = sampleStandardDeviation(valid);
  return Number.isFinite(sd) ? (sd / avg) * 100 : Number.NaN;
}

export function calibratedStabilityScore(rawVariability) {
  const value = Math.max(0, toNumber(rawVariability, Number.NaN));
  if (!Number.isFinite(value)) return null;
  if (value <= STABILITY_ANCHORS[0][0]) return STABILITY_ANCHORS[0][1];
  for (let index = 1; index < STABILITY_ANCHORS.length; index += 1) {
    const [upperX, upperY] = STABILITY_ANCHORS[index];
    const [lowerX, lowerY] = STABILITY_ANCHORS[index - 1];
    if (value <= upperX) {
      const t = (value - lowerX) / Math.max(0.0001, upperX - lowerX);
      return clamp(lowerY + ((upperY - lowerY) * t));
    }
  }
  return STABILITY_ANCHORS[STABILITY_ANCHORS.length - 1][1];
}

// Stroke counts and stroke cycles are different measurements. No conversion
// rule is defined, so a series is only usable when every count shares a unit.
function strokeCountUnit(row) {
  return String(row?.strokeCountUnit || '').trim().toLowerCase() === 'cycles' ? 'cycles' : 'strokes';
}

function uniformStrokeUnit(rows) {
  const units = new Set(asArray(rows).map(strokeCountUnit));
  return units.size === 1 ? [...units][0] : (units.size === 0 ? 'strokes' : 'mixed');
}

// The canonical protocol, not the free-text label, defines the stroke and
// distance of a built-in test. Recorded values always take precedence.
const BUILT_IN_SWIM_TEST_PROTOCOLS = new Map(
  ['Max', 'Repeatability', 'Aerobic / Durability Check']
    .flatMap((name) => asArray(canonicalBuiltInTestTemplate(name)?.rows))
    .map((row) => [String(row?.label || row?.description || '').trim().toLowerCase(), row])
    .filter(([key]) => Boolean(key)),
);

function builtInTestProtocol(test, raw) {
  for (const candidate of [raw?.testItemKey, raw?.itemLabel, test?.testName, raw?.testName]) {
    const protocol = BUILT_IN_SWIM_TEST_PROTOCOLS.get(String(candidate || '').trim().toLowerCase());
    if (protocol) return protocol;
  }
  return null;
}

function parseRep(rep, expectedDistance = 0) {
  const splits = asArray(rep?.splits);
  const splitTimes = splits.map((split) => parseResultTime(split?.time));
  const splitStrokes = splits.map((split) => toNumber(split?.strokeCount, Number.NaN));
  const recordedDistance = toNumber(splits[splits.length - 1]?.distance ?? splits[splits.length - 1]?.distanceLabel, 0);
  const completeDistance = expectedDistance <= 0 || recordedDistance === expectedDistance;
  const overallTime = parseResultTime(rep?.overallTime);
  const overallStrokeCount = toNumber(rep?.overallStrokeCount, Number.NaN);
  // Do not infer a complete rep from a partially measured set of splits.
  const allTimes = completeDistance && splitTimes.length > 0 && splitTimes.every((value) => Number.isFinite(value) && value > 0);
  const splitStrokeUnit = uniformStrokeUnit(splits.filter((split) => String(split?.strokeCount ?? '').trim() !== ''));
  const allStrokes = completeDistance && splits.length > 0 && splitStrokeUnit !== 'mixed' && splits.every((split) =>
    String(split?.strokeCount ?? '').trim() !== '' && Number.isFinite(toNumber(split.strokeCount, Number.NaN)) && Number(split.strokeCount) > 0);
  const hasOverallStrokes = Number.isFinite(overallStrokeCount) && overallStrokeCount > 0;
  return {
    time: Number.isFinite(overallTime) && overallTime > 0
      ? overallTime
      : (allTimes ? splitTimes.reduce((sum, value) => sum + value, 0) : Number.NaN),
    strokeCount: hasOverallStrokes
      ? overallStrokeCount
      : (allStrokes ? splitStrokes.reduce((sum, value) => sum + value, 0) : Number.NaN),
    strokeUnit: hasOverallStrokes ? strokeCountUnit(rep) : splitStrokeUnit,
    splitTimes: splitTimes.filter((value) => Number.isFinite(value) && value > 0),
    splitStrokes: splitStrokeUnit === 'mixed' ? [] : splitStrokes.filter((value) => Number.isFinite(value) && value > 0),
    turnTimes: splits.map((split) => toNumber(split?.turnTime)).filter((value) => Number.isFinite(value) && value > 0),
    underwaterDistances: splits.map((split) => toNumber(split?.underwaterDistance)).filter((value) => Number.isFinite(value) && value > 0),
  };
}

function parseResultTime(value) {
  if (value === null || value === undefined || String(value).trim() === '') return Number.NaN;
  const token = String(value).trim().replace(',', '.');
  if (/^\d+(?::[0-5]?\d){1,2}(?:\.\d+)?$/.test(token)) {
    const parts = token.split(':').map(Number);
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : Number.NaN;
  }
  const parsed = Number(token);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN;
}

// Long course freestyle world records (refreshed automatically with the
// World Aquatics base times); 25 m from the 50 m with the former world-class
// 25/50 ratio; 'open' = mean of women and men.
const lcFree = (sex) => WORLD_AQUATICS_BASE_TIMES.LC[sex].free;
const withDerived25 = (table, ratio) => ({ 25: table[50] * ratio, ...table });
const WORLD_CLASS_FREESTYLE_SECONDS = (() => {
  const female = withDerived25(lcFree('female'), 10.7 / 23.6);
  const male = withDerived25(lcFree('male'), 9.5 / 20.9);
  const open = Object.fromEntries(Object.keys(female).filter((d) => d in male).map((d) => [d, (female[d] + male[d]) / 2]));
  return { female, male, open };
})();

function resolveSex(value) {
  const token = String(value || '').trim().toLowerCase();
  // 'women' and 'men' are checked explicitly: neither contains 'woman' / 'man'.
  if (/female|wom[ae]n|girls?|ladies|\bf\b/.test(token)) return 'female';
  if (/male|\bm[ae]n\b|boys?|\bm\b/.test(token)) return 'male';
  return 'open';
}

function interpolateReferenceTime(distance, table) {
  const exact = table?.[distance];
  if (Number.isFinite(exact)) return exact;
  const distances = Object.keys(table || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!distances.length || !Number.isFinite(distance) || distance <= 0) return Number.NaN;
  const lower = [...distances].reverse().find((candidate) => candidate <= distance);
  const upper = distances.find((candidate) => candidate >= distance);
  if (!lower) return table[upper] * (distance / upper);
  if (!upper) return table[lower] * (distance / lower);
  if (lower === upper) return table[lower];
  const ratio = (distance - lower) / (upper - lower);
  return table[lower] + ((table[upper] - table[lower]) * ratio);
}

// Speed-based metrics (maximum velocity, peak output, threshold pace) are
// scored as World Aquatics points / 10 (owner decision 26-10-2026): the cubic
// scale separates age-group, club and Olympic swimmers, where the former
// linear time ratio placed a club swimmer close to world class.
function performanceReferenceScore({ time, distance, sex, stroke, course }) {
  return worldAquaticsScore({ time, distance, stroke, sex, course });
}

// Efficiency reference (D-6, owner decision 25-10-2026: elite table).
// Elite speed = the world-class reference above; elite distance per stroke
// cycle = speed × 60 / elite stroke rate (cycles/min), so elite Stroke Index =
// speed² × 60 / stroke rate. PROVISIONAL stroke rates (typical elite race
// values) pending owner confirmation of the table.
const ELITE_STROKE_RATE = {
  free: { female: { 25: 62, 50: 60, 100: 52, 200: 45, 400: 42 }, male: { 25: 62, 50: 60, 100: 50, 200: 43, 400: 39 } },
  back: { female: { 50: 54, 100: 50, 200: 44 }, male: { 50: 54, 100: 49, 200: 42 } },
  breast: { female: { 50: 58, 100: 54, 200: 40 }, male: { 50: 58, 100: 52, 200: 38 } },
  fly: { female: { 50: 58, 100: 54, 200: 48 }, male: { 50: 58, 100: 52, 200: 46 } },
};
export const EFFICIENCY_REFERENCE_NOTE = 'Efficiency 0–100 = swimmer Stroke Index ÷ elite Stroke Index × 100 (elite speed from the world-class reference, elite stroke rate from a provisional table pending owner confirmation).';
function strokeFamily(stroke) {
  const token = String(stroke || '').trim().toLowerCase();
  if (/breast/.test(token)) return 'breast';
  if (/back/.test(token)) return 'back';
  if (/fly|butter/.test(token)) return 'fly';
  if (/medley|\bim\b|choice|mixed/.test(token)) return null;
  if (/free|crawl|^fr$|^$/.test(token)) return 'free';
  return null;
}
export function eliteStrokeIndex({ distance, stroke, sex }) {
  const family = strokeFamily(stroke);
  const resolvedSex = resolveSex(sex) === 'male' ? 'male' : 'female';
  if (!family || !(distance > 0)) return null;
  const factor = family === 'breast' ? 1.22 : family === 'back' ? 1.10 : family === 'fly' ? 1.06 : 1;
  const sexTable = resolveSex(sex) === 'open' ? WORLD_CLASS_FREESTYLE_SECONDS.open : WORLD_CLASS_FREESTYLE_SECONDS[resolvedSex];
  const reference = interpolateReferenceTime(distance, sexTable) * factor;
  // Sex not recorded: the open world-class time with the mean of the women's
  // and men's elite stroke rates.
  const rateFor = (key) => interpolateReferenceTime(distance, ELITE_STROKE_RATE[family][key] || {});
  const strokeRate = resolveSex(sex) === 'open' ? (rateFor('female') + rateFor('male')) / 2 : rateFor(resolvedSex);
  if (!(reference > 0) || !(strokeRate > 0)) return null;
  const speed = distance / reference;
  return (speed * speed * 60) / strokeRate;
}

// Adaptability scale (D-7, owner decision 25-10-2026): 50 = no change; each
// 0.4 % of performance (the smallest worthwhile change in competitive swimming
// performance, Pyne et al. 2004) moves the score 10 points; bounded 0–100.
export const ADAPTABILITY_SMALLEST_WORTHWHILE_CHANGE_PCT = 0.4;
export const adaptabilityScoreFromImprovement = (improvementPct) => (Number.isFinite(improvementPct)
  ? clamp(50 + 10 * (improvementPct / ADAPTABILITY_SMALLEST_WORTHWHILE_CHANGE_PCT)) : null);

// Efficiency and Adaptability scored records from the same measured indicators
// shown in Analysis and the ISP (no target stroke counts).
function buildEfficiencyAdaptabilityRecords({ canonicalTests, completedCompetitions, canonicalSets, swimmerId, swimmer, absentScheduleIds, pushOffMetresPerWall }) {
  const records = [];
  const sets = asArray(canonicalSets).map((set) => ({ ...set, __ispSwimmerResult: set?.resultsBySwimmer?.[swimmerId] || null }));
  const deliveryBySchedule = new Map([...(absentScheduleIds || [])].map((id) => [String(id), { attended: false }]));
  const indicators = buildEfficiencyAdaptabilityIndicators({ tests: canonicalTests, competitions: completedCompetitions, sets, deliveryBySchedule, pushOffMetresPerWall });
  const sourceOf = { test: 'testing', competition: 'competition', training: 'training' };
  const sex = swimmer?.gender || swimmer?.sex;
  for (const row of indicators.efficiency.measurements) {
    if (row.unit === 'yd') continue; // the elite reference is in metres
    const elite = eliteStrokeIndex({ distance: row.distance, stroke: row.stroke, sex });
    if (!(elite > 0)) continue;
    addMetric(records, { axis: 'efficiency', metric: 'speed_per_stroke', score: clamp((row.si / elite) * 100),
      source: sourceOf[row.source], date: row.date, evidenceId: row.id, signal: 1, rawValue: row.si,
      method: 'stroke-index-vs-elite-reference' });
  }
  for (const row of indicators.adaptability.retests) {
    addMetric(records, { axis: 'adaptability', metric: 'learning_rate', score: adaptabilityScoreFromImprovement(-row.timeChangePct),
      source: 'testing', date: row.latest.date, evidenceId: row.latest.id, signal: 1, rawValue: row.timeChangePct,
      method: 'retest-response-vs-smallest-worthwhile-change' });
  }
  for (const row of indicators.adaptability.recoveryResponses) {
    if (!(row.sendOffChangeSeconds < 0)) continue; // a tighter send-off is the increased demand
    addMetric(records, { axis: 'adaptability', metric: 'transfer_success', score: adaptabilityScoreFromImprovement(-row.paceChangePct),
      source: 'training', date: row.to.date, evidenceId: row.to.id, signal: 1, rawValue: row.paceChangePct,
      method: 'tighter-send-off-pace-response-vs-smallest-worthwhile-change' });
  }
  return records;
}

function collectTestRepRows(test, raw) {
  const pools = [raw?.repResults, raw?.testRepResults, test?.repResults, test?.testRepResults];
  const seen = new Set();
  const rows = [];
  pools.forEach((pool) => asArray(pool).forEach((row, index) => {
    if (!row || typeof row !== 'object') return;
    const signature = String(row?.id || [row?.overallTime, row?.time, row?.overallStrokeCount, index].join('|'));
    if (seen.has(signature)) return;
    seen.add(signature);
    rows.push(row);
  }));
  if (!rows.length) {
    const resultTime = test?.resultValue || raw?.resultValue || raw?.resultTime || raw?.time || raw?.value;
    if (String(resultTime || '').trim()) {
      rows.push({ overallTime: resultTime, overallStrokeCount: raw?.overallStrokeCount || raw?.strokeCount, splits: asArray(raw?.splits) });
    }
  }
  return rows;
}

function inferDistance(set, test) {
  const direct = toNumber(
    set?.distance
    ?? set?.repDistance
    ?? set?.distancePerRep
    ?? test?.distance
    ?? test?.distancePerRep,
  );
  if (Number.isFinite(direct) && direct > 0) return direct;
  const text = [
    set?.setName,
    set?.partName,
    set?.description,
    set?.structure,
    test?.testType,
    test?.testName,
    test?.metric,
    test?.name,
    test?.setSwam,
    test?.actualSet,
  ].filter(Boolean).join(' ');
  const match = text.match(/(?:\d+\s*[xX]\s*)?(\d{2,4})\b/);
  return match ? Math.max(0, Number(match[1])) : 0;
}

function resolvePhaseContext(scope = {}) {
  const token = String(scope?.phase || scope?.cyclePhase || '').trim().toLowerCase();
  if (/race|taper|gara|scarico/.test(token)) return 'race';
  if (/aerobic|foundation|aerobico|base/.test(token)) return 'aerobic';
  return 'default';
}

function resolveSourceWeight(source, phaseContext) {
  const profile = SOURCE_WEIGHTS[phaseContext] || SOURCE_WEIGHTS.default;
  return profile[source] ?? 0;
}

function recencyWeight(recordDate, calculationDate) {
  const recordKey = dateKey(recordDate);
  const calculationKey = dateKey(calculationDate);
  if (!recordKey || !calculationKey) return 0;
  const ageDays = daysBetween(recordKey, calculationKey);
  if (ageDays <= 14) return 1;
  if (ageDays <= 28) return 0.75;
  if (ageDays <= 56) return 0.50;
  return 0.25;
}

function signalWeight({ values = [], secondaryValues = [], explicit = false } = {}) {
  const primary = asArray(values).filter(Number.isFinite).length;
  const secondary = asArray(secondaryValues).filter(Number.isFinite).length;
  if (primary >= 3 && secondary >= 3) return 1;
  if (primary >= 2 && (secondary >= 2 || explicit)) return 0.85;
  if (primary >= 2) return 0.70;
  if (explicit) return 0.60;
  return 0.35;
}

// Wf = min(1, E / Et) (Mathematical Engine Specification). No minimum floor.
function frequencyWeight(count, target) {
  return Math.min(1, Math.max(0, count) / Math.max(1, target));
}

function firstDefinedNumber(...values) {
  for (const value of values) {
    const numeric = toNumber(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return Number.NaN;
}

function addMetric(records, {
  axis,
  metric,
  score,
  source = 'testing',
  date = '',
  evidenceId = '',
  signal = 1,
  rawValue = null,
  method = '',
  context = null,
}) {
  if (!axis || !metric || !Number.isFinite(Number(score))) return;
  const resolvedDate = dateKey(date);
  if (!resolvedDate) return;
  records.push({
    axis,
    metric,
    score: WORLD_LEVEL_METHODS.has(method) ? atLeastZero(score) : clamp(score),
    source,
    date: resolvedDate,
    evidenceId: String(evidenceId || ''),
    // Signal weight in [0, 1]; no undocumented 0.25 floor.
    signal: Math.max(0, Math.min(1, Number(signal))),
    rawValue,
    method,
    // Measurement identity (distance, stroke, course, repetitions) used by the
    // decision engine; never used for scoring.
    ...(context ? { context } : {}),
  });
}

// A within-swimmer change relative to that swimmer's own earlier measurement
// is a TREND, not an absolute 0-100 capability level. No framework rule maps
// a percentage change onto the capability scale, so trend records carry the
// observed change only and are excluded from axis scores.
function addTrend(records, { axis, metric, changePct, source = 'testing', date = '', evidenceId = '',
  baselineValue = null, observedValue = null, method = '' }) {
  const resolvedDate = dateKey(date);
  if (!axis || !metric || !Number.isFinite(Number(changePct)) || !resolvedDate) return;
  records.push({
    kind: 'trend', axis, metric, score: Number.NaN, changePct: Number(changePct), source,
    date: resolvedDate, evidenceId: String(evidenceId || ''), baselineValue, observedValue,
    rawValue: observedValue, method,
  });
}

function readExplicitMetricScores(payload, records, source, date, evidenceId) {
  if (!payload || typeof payload !== 'object') return;
  const containers = [
    payload.metricScores,
    payload.capabilityMetricScores,
    payload.normalisedMetrics,
    payload.normalizedMetrics,
  ].filter((value) => value && typeof value === 'object');
  for (const container of containers) {
    for (const axis of ATHLYRAX_AXIS_DEFINITIONS) {
      const axisPayload = container?.[axis.key];
      if (!axisPayload || typeof axisPayload !== 'object') continue;
      for (const metric of Object.keys(axis.metrics)) {
        const score = firstDefinedNumber(axisPayload?.[metric], axisPayload?.[`${metric}Score`]);
        if (!Number.isFinite(score)) continue;
        addMetric(records, {
          axis: axis.key,
          metric,
          score,
          source,
          date,
          evidenceId,
          signal: 1,
          rawValue: score,
          method: 'explicit-versioned-normalised-metric',
        });
      }
    }
  }
}

function buildTestMetricRecords({ canonicalTests, setById, swimmer }) {
  const records = [];
  // Compare like-for-like performances in date order; an earlier recorded
  // personal measurement is a valid longitudinal baseline, not an invented target.
  const personalBaselines = new Map();
  const orderedTests = [...asArray(canonicalTests)].sort((left, right) =>
    dateKey(left?.date || left?.raw?.date).localeCompare(dateKey(right?.date || right?.raw?.date)));
  for (const test of orderedTests) {
    if (!test?.completed) continue;
    const raw = test?.raw && typeof test.raw === 'object' ? test.raw : {};
    const set = setById.get(String(test?.setId || test?.linkedSetId || '')) || {};
    const protocol = builtInTestProtocol(test, raw);

    const distance = inferDistance(set, {
      ...raw,
      distance: test?.distance || raw?.distance || protocol?.distance,
      testType: test?.testType || raw?.testType,
      testName: test?.testName || raw?.testName,
    });
    const reps = collectTestRepRows(test, raw).map((rep) => parseRep(rep, distance));
    const times = reps.map((rep) => rep.time).filter((value) => Number.isFinite(value) && value > 0);
    const countedReps = reps.filter((rep) => Number.isFinite(rep.strokeCount) && rep.strokeCount > 0);
    const strokeUnits = new Set(countedReps.map((rep) => rep.strokeUnit));
    const strokeUnit = strokeUnits.size === 1 ? [...strokeUnits][0] : (strokeUnits.size ? 'mixed' : 'strokes');
    const unitSafeReps = strokeUnit === 'mixed' || strokeUnits.has('mixed')
      ? reps.map((rep) => ({ ...rep, strokeCount: Number.NaN }))
      : reps;
    const strokes = unitSafeReps.map((rep) => rep.strokeCount).filter((value) => Number.isFinite(value) && value > 0);
    const comparablePairs = unitSafeReps.filter((rep) => Number.isFinite(rep.time) && rep.time > 0 && Number.isFinite(rep.strokeCount) && rep.strokeCount > 0);
    const text = [
      raw?.testType,
      raw?.testName,
      test?.testName,
      raw?.metric,
      raw?.name,
      raw?.setSwam,
      raw?.actualSet,
      set?.setName,
      set?.partName,
      set?.description,
      set?.structure,
      set?.energy,
      set?.energySystem,
      set?.stroke,
    ].filter(Boolean).join(' ').toLowerCase();
    const date = test?.date || raw?.date || raw?.testDate || raw?.updatedAt;
    const evidenceId = test?.id || raw?.id;
    const paceCv = coefficientOfVariation(times);
    const strokeCv = coefficientOfVariation(strokes);
    const paceScore = calibratedStabilityScore(paceCv);
    const strokeScore = calibratedStabilityScore(strokeCv);
    const repeated = times.length >= 2;
    // Energy codes are whole tokens: a bare "lt" would match "result", "multi", etc.
    const highIntensity = /sprint|speed|power|max|race\s*pace|broken|anaerobic|lactate|\ben3\b|\blt\b|\bsp\b/.test(text)
      || (distance > 0 && distance <= 200);
    const aerobic = /threshold|aerobic|endurance|distance|\ben1\b|\ben2\b/.test(text)
      || distance >= 400;
    const sprint = /sprint|speed|power|max|start|\bsp\b/.test(text)
      || (distance > 0 && distance <= 50);
    const testSignal = signalWeight({ values: times, secondaryValues: strokes, explicit: true });
    // Free-text swimming test names may be the only stroke information for
    // manually recorded tests. Use a recognised stroke token, never guess.
    const strokeName = String(test?.testName || raw?.testName || '').trim();
    const namedStroke = strokeName.match(/\b(freestyle|free|front crawl|fr|backstroke|back|breaststroke|breast|butterfly|fly|medley|im)\b/i)?.[1] || '';
    const measuredStroke = test?.stroke || raw?.stroke || set?.stroke || namedStroke || protocol?.stroke || '';
    const performanceScore = times.length
      ? performanceReferenceScore({ time: Math.min(...times), distance, sex: raw?.gender || raw?.sex || swimmer?.gender || swimmer?.sex, stroke: measuredStroke,
        course: test?.course || raw?.course || set?.course || test?.poolLength || raw?.poolLength })
      : null;

    readExplicitMetricScores(raw, records, 'testing', date, evidenceId);

    const testContext = {
      distance,
      stroke: String(measuredStroke || '').trim().toLowerCase(),
      course: String(test?.course || raw?.course || set?.course || '').trim().toUpperCase(),
      repCount: times.length,
    };
    if (performanceScore !== null) {
      if (distance <= 50) addMetric(records, { axis: 'power_speed_expression', metric: 'maximum_velocity', score: performanceScore, date, evidenceId, signal: testSignal, rawValue: Math.min(...times), method: 'world-class-time-reference', context: testContext });
      if (distance <= 200) addMetric(records, { axis: 'anaerobic_capacity', metric: 'peak_output', score: performanceScore, date, evidenceId, signal: testSignal, rawValue: Math.min(...times), method: 'world-class-time-reference', context: testContext });
      if (distance >= 200) addMetric(records, { axis: 'aerobic_capacity', metric: 'threshold_pace', score: performanceScore, date, evidenceId, signal: testSignal, rawValue: Math.min(...times), method: 'world-class-time-reference', context: testContext });
    }

    if (strokeScore !== null) {
      addMetric(records, {
        axis: 'technical_control',
        metric: 'stroke_count_stability',
        score: strokeScore,
        date,
        evidenceId,
        signal: testSignal,
        rawValue: strokeCv,
        method: 'cv-stability-calibration',
      });
    }
    if (paceScore !== null) {
      addMetric(records, {
        axis: 'technical_control',
        metric: 'pace_stability',
        score: paceScore,
        date,
        evidenceId,
        signal: testSignal,
        rawValue: paceCv,
        method: 'cv-stability-calibration',
      });
    }

    const turnTimes = reps.flatMap((rep) => rep.turnTimes);
    const turnCv = coefficientOfVariation(turnTimes);
    const turnScore = calibratedStabilityScore(turnCv);
    if (turnScore !== null) {
      addMetric(records, {
        axis: 'technical_control',
        metric: 'turn_consistency',
        score: turnScore,
        date,
        evidenceId,
        signal: signalWeight({ values: turnTimes, explicit: true }),
        rawValue: turnCv,
        method: 'cv-stability-calibration',
      });
    }

    const underwater = reps.flatMap((rep) => rep.underwaterDistances);
    const underwaterCv = coefficientOfVariation(underwater);
    const underwaterScore = calibratedStabilityScore(underwaterCv);
    if (underwaterScore !== null) {
      addMetric(records, {
        axis: 'technical_control',
        metric: 'underwater_consistency',
        score: underwaterScore,
        date,
        evidenceId,
        signal: signalWeight({ values: underwater, explicit: true }),
        rawValue: underwaterCv,
        method: 'cv-stability-calibration',
      });
    }

    // A target-free repeated test can still measure *relative* changes in the
    // swimmer's observed pace and stroke economy. Only the same distance,
    // stroke, test format and a strictly later test date may be compared.
    // The baseline-index midpoint (50) is an estimated trend indicator, NOT
    // an externally calibrated measure of absolute swimming efficiency.
    const firstPaired = comparablePairs.length > 0 && distance > 0;
    const sameTestFormat = String(test?.templateId || raw?.templateId || test?.testType || raw?.testType || 'unknown')
      .trim().toLowerCase();
    const sameStroke = String(test?.stroke || raw?.stroke || set?.stroke || 'unspecified')
      .trim().toLowerCase();
    const personalKey = `${Math.round(distance)}|${sameStroke}|${sameTestFormat}|${comparablePairs.length > 1 ? 'repeat' : 'single'}|${strokeUnit}`;
    const testDateKey = dateKey(date);
    if (firstPaired && testDateKey) {
      const meanPace = mean(comparablePairs.map(rep => rep.time));
      const meanStrokeCount = mean(comparablePairs.map(rep => rep.strokeCount));
      const observedPacePerStroke = distance / (meanPace * meanStrokeCount);
      const original = personalBaselines.get(personalKey);
      if (original && testDateKey > original.date && observedPacePerStroke > 0) {
        addTrend(records, {
          axis: 'efficiency', metric: 'speed_per_stroke',
          changePct: 100 * (observedPacePerStroke / original.pacePerStroke - 1),
          date, evidenceId, baselineValue: original.pacePerStroke, observedValue: observedPacePerStroke,
          method: 'within-swimmer-retest-pace-per-stroke-change-vs-first-test',
        });
        addTrend(records, {
          axis: 'efficiency', metric: 'stroke_count_economy',
          // Fewer strokes for the same test is a positive change.
          changePct: 100 * (original.meanStrokes / meanStrokeCount - 1),
          date, evidenceId, baselineValue: original.meanStrokes, observedValue: meanStrokeCount,
          method: 'within-swimmer-retest-stroke-count-change-vs-first-test',
        });
      }
      if (!original && Number.isFinite(observedPacePerStroke) && observedPacePerStroke > 0) {
        personalBaselines.set(personalKey, {
          date: testDateKey, pacePerStroke: observedPacePerStroke, meanStrokes: meanStrokeCount,
        });
      }
    }

    // Efficiency (D-6): no target stroke count is used. Absolute Efficiency
    // needs a validated reference; measured speed, distance per cycle and
    // Stroke Index are reported by efficiencyAdaptabilityIndicators.js.

    if (comparablePairs.length >= 2 && distance > 0) {
      const efficiencySeries = comparablePairs.map((rep) => distance / (rep.time * rep.strokeCount));
      const firstEfficiency = efficiencySeries[0];
      const finalEfficiency = efficiencySeries[efficiencySeries.length - 1];
      if (firstEfficiency > 0 && finalEfficiency > 0) {
        const efficiencyLoss = Math.max(0, ((firstEfficiency - finalEfficiency) / firstEfficiency) * 100);
        const efficiencyDecayScore = calibratedStabilityScore(efficiencyLoss);
        if (efficiencyDecayScore !== null) {
          addMetric(records, {
            axis: 'robustness_of_efficiency',
            metric: 'efficiency_decay',
            score: efficiencyDecayScore,
            date,
            evidenceId,
            signal: testSignal,
            rawValue: efficiencyLoss,
            method: 'endpoint-efficiency-retention',
          });
          // fatigue_efficiency_index is not written from this value: it used
          // the same score as efficiency_decay (one measurement counted twice).
        }
      }
      const firstStroke = comparablePairs[0].strokeCount;
      const finalStroke = comparablePairs[comparablePairs.length - 1].strokeCount;
      if (firstStroke > 0 && finalStroke > 0) {
        const strokeDrift = Math.max(0, ((finalStroke - firstStroke) / firstStroke) * 100);
        const strokeDriftScore = calibratedStabilityScore(strokeDrift);
        if (strokeDriftScore !== null) {
          addMetric(records, {
            axis: 'robustness_of_efficiency',
            metric: 'stroke_drift',
            score: strokeDriftScore,
            date,
            evidenceId,
            signal: testSignal,
            rawValue: strokeDrift,
            method: 'relative-stroke-drift',
          });
        }
      }
    }

    if (repeated && aerobic && paceScore !== null) {
      addMetric(records, {
        axis: 'aerobic_capacity',
        metric: 'pace_stability',
        score: paceScore,
        date,
        evidenceId,
        signal: testSignal,
        rawValue: paceCv,
        method: 'aerobic-pace-cv',
      });
      // Aerobic 'repeatability' is not written from the same pace CV: it was
      // an exact copy of pace_stability (one measurement counted twice).
    }

    const thresholdReference = firstDefinedNumber(set?.thresholdReferenceTime, raw?.thresholdReferenceTime, raw?.referenceTime);
    if (aerobic && distance > 0 && times.length > 0 && Number.isFinite(thresholdReference) && thresholdReference > 0) {
      addMetric(records, {
        axis: 'aerobic_capacity',
        metric: 'threshold_pace',
        score: clamp((thresholdReference / mean(times)) * 100),
        date,
        evidenceId,
        signal: testSignal,
        rawValue: mean(times),
        method: 'reference-threshold-time',
      });
    }

    if (repeated && highIntensity && paceScore !== null) {
      addMetric(records, {
        axis: 'anaerobic_capacity',
        metric: 'repeatability',
        score: paceScore,
        date,
        evidenceId,
        signal: testSignal,
        rawValue: paceCv,
        method: 'high-intensity-repeatability-cv',
      });
      const best = Math.min(...times);
      const worst = Math.max(...times);
      const fatigueLoss = best > 0 ? ((worst - best) / best) * 100 : Number.NaN;
      const fatigueScore = calibratedStabilityScore(fatigueLoss);
      if (fatigueScore !== null) {
        addMetric(records, {
          axis: 'anaerobic_capacity',
          metric: 'fatigue_resistance',
          score: fatigueScore,
          date,
          evidenceId,
          signal: testSignal,
          rawValue: fatigueLoss,
          method: 'high-intensity-fatigue-loss',
        });
      }
    }

    const outputReferenceTime = firstDefinedNumber(set?.referenceTime, set?.benchmarkTime, raw?.referenceTime, raw?.benchmarkTime);
    if (highIntensity && times.length > 0 && Number.isFinite(outputReferenceTime) && outputReferenceTime > 0) {
      addMetric(records, {
        axis: 'anaerobic_capacity',
        metric: 'peak_output',
        score: clamp((outputReferenceTime / Math.min(...times)) * 100),
        date,
        evidenceId,
        signal: testSignal,
        rawValue: Math.min(...times),
        method: 'reference-normalised-peak-time',
      });
    }

    if (sprint && repeated && paceScore !== null) {
      addMetric(records, {
        axis: 'power_speed_expression',
        metric: 'sprint_stability',
        score: paceScore,
        date,
        evidenceId,
        signal: testSignal,
        rawValue: paceCv,
        method: 'sprint-stability-cv',
      });
    }
    const velocityReference = firstDefinedNumber(set?.referenceVelocity, raw?.referenceVelocity);
    if (sprint && distance > 0 && times.length > 0 && Number.isFinite(velocityReference) && velocityReference > 0) {
      const maximumVelocity = distance / Math.min(...times);
      addMetric(records, {
        axis: 'power_speed_expression',
        metric: 'maximum_velocity',
        score: clamp((maximumVelocity / velocityReference) * 100),
        date,
        evidenceId,
        signal: testSignal,
        rawValue: maximumVelocity,
        method: 'reference-normalised-maximum-velocity',
      });
    }

    const plannedVolume = Math.max(0, resolveIspPlannerSetVolume(set));
    // The canonical repeated protocols (8x25/8x50/8x100 repeatability and the
    // 5x400 check) are the framework's first-break / decay tests, whatever
    // words the coach used in the label.
    const repeatedProtocol = Number(protocol?.reps) > 1;
    const durabilityEligible = times.length >= 3
      && (repeatedProtocol || plannedVolume >= 2000 || distance >= 200 || /durability|sustain|endurance|fatigue|broken/.test(text));
    if (durabilityEligible) {
      const baseline = times[0];
      const breakIndex = baseline > 0
        ? times.findIndex((time, index) => index > 0 && ((time - baseline) / baseline) * 100 > 10)
        : -1;
      // Proportion of reps held before the first break (reps before the break
      // ÷ reps in the set). The former ÷ (n − 1) scored a break on the final
      // rep as 100, identical to no break.
      const firstBreakScore = breakIndex < 0
        ? 100
        : clamp((breakIndex / times.length) * 100);
      addMetric(records, {
        axis: 'durability',
        metric: 'first_break_index',
        score: firstBreakScore,
        date,
        evidenceId,
        signal: testSignal,
        rawValue: breakIndex,
        method: 'sequential-10-percent-break-threshold',
        context: { repCount: times.length },
      });
      const best = Math.min(...times);
      const final = times[times.length - 1];
      const fatigueLoss = best > 0 ? Math.max(0, ((final - best) / best) * 100) : Number.NaN;
      const fatigueScore = calibratedStabilityScore(fatigueLoss);
      if (fatigueScore !== null) {
        addMetric(records, {
          axis: 'durability',
          metric: 'fatigue_resistance',
          score: fatigueScore,
          date,
          evidenceId,
          signal: testSignal,
          rawValue: fatigueLoss,
          method: 'late-set-fatigue-loss',
        });
        // decay_curve is not written from this value: it was an exact copy of
        // fatigue_resistance, double-weighting one measurement.
      }
      const lateStart = Math.max(0, Math.floor(times.length * 0.67));
      const lateTimes = times.slice(lateStart);
      const lateCv = coefficientOfVariation(lateTimes);
      const lateScore = calibratedStabilityScore(lateCv);
      if (lateScore !== null) {
        addMetric(records, {
          axis: 'durability',
          metric: 'late_set_stability',
          score: lateScore,
          date,
          evidenceId,
          signal: signalWeight({ values: lateTimes, explicit: true }),
          rawValue: lateCv,
          method: 'late-set-cv-stability',
        });
      }
    }
  }
  return records;
}

// A competition console may store splits as cumulative race-clock stamps.
// Pacing metrics must use the duration of each length, not elapsed time since start.
function competitionSegments(result, officialTime = Number.NaN) {
  const direct = asArray(result?.segmentTimes).map(parseResultTime).filter(Number.isFinite);
  if (direct.length) return direct;
  const splitRows = asArray(result?.splits);
  if (!splitRows.length) return [];
  const actualSegments = splitRows.map(row => parseResultTime(
    row && typeof row === 'object' ? (row.segmentTime ?? row.lengthTime) : undefined,
  ));
  if (actualSegments.every(Number.isFinite)) return actualSegments;
  const splitTimes = splitRows.map(row => parseResultTime(row?.time ?? row));
  if (!splitTimes.every(Number.isFinite)) return [];
  const cumulativeFlag = result?.splitTimeMode === 'cumulative'
    || result?.splitsCumulative === true;
  // Where official race time is known, exact equality of the final cumulative
  // timestamp to the race result gives positive evidence of cumulative mode.
  const finalSplit = splitTimes[splitTimes.length - 1];
  const matchesOfficial = Number.isFinite(officialTime) && officialTime > 0
    && Math.abs(finalSplit - officialTime) <= Math.max(0.06, officialTime * 0.001);
  const increasing = splitTimes.every((value, index) =>
    index === 0 || value > splitTimes[index - 1]);
  if ((cumulativeFlag || matchesOfficial) && increasing && splitTimes.length >= 2) {
    return splitTimes.map((value, index) =>
      index === 0 ? value : value - splitTimes[index - 1]);
  }
  return splitTimes;
}

export function buildCompetitionMetricRecords({ completedCompetitions, swimmer }) {
  const records = [];
  const history = new Map();
  const measuredStrokeBaselines = new Map();
  const ordered = [...asArray(completedCompetitions)].sort((a, b) => dateKey(a?.date).localeCompare(dateKey(b?.date)));
  for (const competition of ordered) {
    const result = competition?.raw?.result || competition?.raw || competition;
    const fixture = competition?.raw?.fixture || null;
    const eventItem = competition?.raw?.eventItem || null;
    const courseKey = resolveCompetitionCourseKey({
      fixture, eventItem, legacyRow: fixture || eventItem ? null : competition?.raw,
    });
    const explicitTime = parseResultTime(competition?.resultValue || result?.totalTime || result?.officialTime || result?.result || result?.time);
    const segments = competitionSegments(result, explicitTime);
    // Use the same split length the competition console records results with.
    const splitDistance = Number(result?.splitLength)
      || (eventItem ? resolveRecordedProgramSplitLength(eventItem) : 0);
    const raceDistance = toNumber(competition?.distance || result?.distance);
    // Only sum split-only results when the recorded segments cover the full race.
    const expectedSplits = splitDistance > 0 && raceDistance > 0 && raceDistance % splitDistance === 0
      ? raceDistance / splitDistance : 0;
    const time = Number.isFinite(explicitTime) ? explicitTime
      : expectedSplits > 0 && segments.length === expectedSplits
        ? segments.reduce((sum, seconds) => sum + seconds, 0)
        : Number.NaN;
    const distance = toNumber(competition?.distance || result?.distance);
    const stroke = competition?.stroke || result?.stroke;
    const date = competition?.date;
    const evidenceId = competition?.id;
    if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(distance) || distance <= 0) continue;

    // Any pool course: a yard race is scored at the same pace over the matching
    // short course metre event (worldAquaticsPoints, labelled approximate).
    const performanceScore = performanceReferenceScore({ time, distance, sex: result?.gender || result?.sex || swimmer?.gender || swimmer?.sex, stroke, course: courseKey });
    if (performanceScore !== null) {
      // Race time relative to an elite reference measures performance level,
      // not stroke efficiency. Do not invent speed-per-stroke without an
      // independently measured stroke count and its calibrated comparison.
      if (distance <= 50) addMetric(records, { axis: 'power_speed_expression', metric: 'maximum_velocity', score: performanceScore, source: 'competition', date, evidenceId, signal: 1, rawValue: distance / time, method: 'competition-world-class-time-reference' });
      if (distance <= 200) addMetric(records, { axis: 'anaerobic_capacity', metric: 'peak_output', score: performanceScore, source: 'competition', date, evidenceId, signal: 1, rawValue: time, method: 'competition-world-class-time-reference' });
      if (distance >= 200) addMetric(records, { axis: 'aerobic_capacity', metric: 'threshold_pace', score: performanceScore, source: 'competition', date, evidenceId, signal: 1, rawValue: time, method: 'competition-world-class-time-reference' });
    }

    const segmentCv = coefficientOfVariation(segments);
    const segmentScore = calibratedStabilityScore(segmentCv);
    if (segmentScore !== null) {
      addMetric(records, { axis: 'technical_control', metric: 'pace_stability', score: segmentScore, source: 'competition', date, evidenceId, signal: signalWeight({ values: segments, explicit: true }), rawValue: segmentCv, method: 'competition-segment-cv' });
      if (distance >= 200) addMetric(records, { axis: 'durability', metric: 'late_set_stability', score: segmentScore, source: 'competition', date, evidenceId, signal: signalWeight({ values: segments, explicit: true }), rawValue: segmentCv, method: 'competition-segment-cv' });
    }

    // Robustness of Efficiency in a race: stroke drift from the second to the
    // last recorded segment (the first segment includes the dive start). Uses
    // the finest recorded per-length split stroke counts; same calibration as
    // the stroke drift of tests and training.
    {
      const splitSets = [asArray(result?.splits), ...Object.values(result?.splitRecordsByLength || {}).map(asArray)];
      const strokesOf = (rows) => rows.map((row) => (row?.strokeCountUnit === 'cycles' ? NaN : Number(row?.strokeCount ?? row?.overallStrokeCount)));
      const usable = splitSets.map(strokesOf).filter((counts) => counts.length >= 3 && counts.every((n) => Number.isFinite(n) && n > 0))
        .sort((a, b) => b.length - a.length)[0];
      if (usable) {
        const second = usable[1];
        const last = usable[usable.length - 1];
        const drift = Math.max(0, 100 * (last / second - 1));
        const driftScore = calibratedStabilityScore(drift);
        if (driftScore !== null) addMetric(records, { axis: 'robustness_of_efficiency', metric: 'stroke_drift', score: driftScore,
          source: 'competition', date, evidenceId, signal: 1, rawValue: drift, method: 'race-stroke-drift-second-to-last-segment' });
      }
    }

    // Same-event comparisons require the same recorded pool course. A race
    // without a recorded course cannot be compared with any other race.
    const signature = courseKey
      ? `${Math.round(distance)}|${String(stroke || '').trim().toLowerCase()}|${courseKey}`
      : '';
    // Race-time improvement alone is not stroke efficiency. A separate,
    // actual stroke count AND an earlier race at the same distance/stroke
    // are required for a longitudinal pace/stroke efficiency estimate.
    const raceStrokes = firstDefinedNumber(result?.strokeCount,
      result?.overallStrokeCount, competition?.strokeCount, competition?.raw?.strokeCount);
    const raceStrokeUnit = result?.strokeCountUnit
      ? strokeCountUnit(result)
      : uniformStrokeUnit(asArray(result?.splits).filter((split) => split && typeof split === 'object'
        && String(split?.strokeCount ?? '').trim() !== ''));
    const strokeSignature = signature && raceStrokeUnit !== 'mixed' ? `${signature}|${raceStrokeUnit}` : '';
    const previousStrokeBaseline = strokeSignature ? measuredStrokeBaselines.get(strokeSignature) : null;
    if (strokeSignature && Number.isFinite(raceStrokes) && raceStrokes > 0) {
      const speedPerStroke = distance / (time * raceStrokes);
      if (previousStrokeBaseline && dateKey(date) > previousStrokeBaseline.date) {
        addTrend(records, {
          axis:'efficiency', metric:'speed_per_stroke', source:'competition', date, evidenceId,
          changePct: 100 * (speedPerStroke / previousStrokeBaseline.speedPerStroke - 1),
          baselineValue: previousStrokeBaseline.speedPerStroke, observedValue: speedPerStroke,
          method:'within-swimmer-same-event-race-pace-per-stroke-change',
        });
        addTrend(records, {
          axis:'efficiency', metric:'stroke_count_economy', source:'competition', date, evidenceId,
          changePct: 100 * (previousStrokeBaseline.strokeCount / raceStrokes - 1),
          baselineValue: previousStrokeBaseline.strokeCount, observedValue: raceStrokes,
          method:'within-swimmer-same-event-race-stroke-count-change',
        });
      } else if (!previousStrokeBaseline) {
        measuredStrokeBaselines.set(strokeSignature, {
          date:dateKey(date), speedPerStroke, strokeCount:raceStrokes,
        });
      }
    }
    const previousTime = signature ? history.get(signature) : Number.NaN;
    if (Number.isFinite(previousTime) && previousTime > 0) {
      // Same-event, same-course race progression, scored on the owner-approved
      // Adaptability scale (50 = no change, 10 points per 0.4 %).
      const improvementPct = ((previousTime - time) / previousTime) * 100;
      addMetric(records, { axis: 'adaptability', metric: 'transfer_success', score: adaptabilityScoreFromImprovement(improvementPct),
        source: 'competition', date, evidenceId, signal: 1, rawValue: improvementPct,
        method: 'same-event-same-course-race-time-change-vs-smallest-worthwhile-change' });
    }
    if (signature) history.set(signature, time);
  }
  return records;
}

// Which recorded training sets can measure which axis (Training radar). One
// rule set, used by the reader below and by the per-axis explanations.
const TRAINING_AEROBIC_CODES = /^(a1|a2|en1|en2|en3)$/;
const TRAINING_INTENSIVE_CODES = /^(en3|lt|lp|b1|b2|c1|c2|c3|rg)$/;
// Sprint intent is read from the prescription (energy code SP or the set name),
// not from distance alone: an easy 8x50 drill is not a sprint.
const TRAINING_SPRINT_INTENT = /sprint|speed|power|max|start|\bsp\b/;
const trainingEnergyCode = (set) => String(set?.energy || set?.energySystem || set?.trainingZone || set?.zone || '').trim().toLowerCase();
const isTrainingTestSet = (set) => set?.isTestSet === true || /^test$/i.test(String(set?.setType || '').trim());
export const isTrainingSprintSet = (set) => TRAINING_SPRINT_INTENT
  .test(`${String(set?.setName || set?.name || '').toLowerCase()} ${trainingEnergyCode(set)}`);
export function trainingSetKinds(set) {
  const code = trainingEnergyCode(set);
  return {
    aerobic: TRAINING_AEROBIC_CODES.test(code),
    intensive: TRAINING_INTENSIVE_CODES.test(code),
    sprint: isTrainingSprintSet(set),
  };
}
// What each axis needs from recorded training (null: no training measurement
// is defined for the axis, so it stays unscored in the Training radar).
export const TRAINING_AXIS_MEASUREMENT = Object.freeze({
  technical_control: 'pace and stroke-count stability (CV) of a set with at least 3 timed repetitions',
  efficiency: null,
  robustness_of_efficiency: 'early-to-late stroke-count / pace drift of a set with at least 4 repetitions timed and stroke-counted',
  aerobic_capacity: 'repeatability (CV) of an aerobic set (EN1/EN2/EN3, A1/A2) with at least 3 timed repetitions',
  anaerobic_capacity: 'repeatability (CV) of an intensive set (EN3, LT, LP, B1/B2, C1-C3, RG) with at least 3 timed repetitions',
  power_speed_expression: 'sprint stability (CV) of a sprint set (energy code SP, or sprint/speed/power/max/start in the set name) with at least 3 timed repetitions',
  adaptability: null,
  durability: 'early-to-late pace deterioration of a set with at least 6 timed repetitions',
});
export const TRAINING_AXIS_UNDEFINED_REASON = Object.freeze({
  efficiency: 'Efficiency is scored in Capability (decision D-6): Stroke Index from tests, races and stroke-counted training repetitions against the elite Stroke Index reference. No target stroke counts are used.',
  adaptability: 'Adaptability is scored in Capability (decision D-7): response to changed demand (repeated tests, the same set on a tighter send-off; actual rest = send-off − swimming time), 50 = no change.',
});

function buildTrainingMeasurementRecords({ canonicalSets, swimmerId, absentScheduleIds = new Set() }) {
  const records = [];
  for (const set of asArray(canonicalSets)) {
    // A swimmer recorded as absent from the session cannot have swum its
    // sets; results stored for them there are contradictory and not read.
    // Without an attendance record, the recorded repetitions are the evidence.
    const setScheduleId = String(set?.trainingScheduleId || set?.scheduleId || '').trim();
    if (setScheduleId && absentScheduleIds.has(setScheduleId)) continue;
    // Planner metadata alone is stimulus, not measured capability. The
    // swimmer's recorded repetition times and stroke counts are required.
    // A test set is the Testing layer: group test results are copied into the
    // linked set, so reading it here would count the same swim twice.
    if (isTrainingTestSet(set)) continue;
    const swimmerResult = set?.resultsBySwimmer?.[swimmerId];
    const repetitions = asArray(swimmerResult?.reps);
    if (repetitions.length < 2) continue;
    const date = dateKey(set?.scheduleDate || set?.sessionDate || set?.date);
    const evidenceId = String(set?.id || '');
    const kinds = trainingSetKinds(set);
    const parsed = repetitions.map(rep => {
      const splitEvidence = parseRep(rep);
      const explicitTime = parseResultTime(rep?.overallTime ?? rep?.time);
      const explicitStrokes = toNumber(rep?.overallStrokeCount ?? rep?.strokeCount);
      const hasExplicitStrokes = Number.isFinite(explicitStrokes) && explicitStrokes > 0;
      return {
        time: Number.isFinite(explicitTime) && explicitTime > 0 ? explicitTime : splitEvidence.time,
        strokes: hasExplicitStrokes ? explicitStrokes : splitEvidence.strokeCount,
        strokeUnit: hasExplicitStrokes ? strokeCountUnit(rep) : splitEvidence.strokeUnit,
      };
    });
    const repStrokeUnits = new Set(parsed.filter(rep => Number.isFinite(rep.strokes) && rep.strokes > 0)
      .map(rep => rep.strokeUnit));
    if (repStrokeUnits.size > 1 || repStrokeUnits.has('mixed')) {
      parsed.forEach(rep => { rep.strokes = Number.NaN; });
    }
    const times = parsed.map(rep => rep.time).filter(value => Number.isFinite(value) && value > 0);
    const strokeCounts = parsed.map(rep => rep.strokes).filter(value => Number.isFinite(value) && value > 0);
    if (times.length >= 3) {
      const variation = coefficientOfVariation(times);
      const score = calibratedStabilityScore(variation);
      if (score !== null) {
        addMetric(records, { axis:'technical_control', metric:'pace_stability', score,
          source:'training', date, evidenceId, rawValue:variation, method:'measured-training-repetition-time-cv' });
        // An aerobic-labelled set is exposure alone. Only *measured*
        // repeated pace stability contributes an aerobic repeatability metric.
        if (kinds.aerobic) {
          addMetric(records, { axis:'aerobic_capacity', metric:'repeatability', score,
            source:'training', date, evidenceId, rawValue:variation, method:'measured-aerobic-training-repeatability-cv' });
        }
        if (kinds.intensive) {
          addMetric(records, { axis:'anaerobic_capacity', metric:'repeatability', score,
            source:'training', date, evidenceId, rawValue:variation, method:'measured-intensive-training-repeatability-cv' });
        }
        // Same definition as the Testing sprint_stability metric (rep-time CV
        // through the same stability curve), from a prescribed sprint set.
        if (kinds.sprint) {
          addMetric(records, { axis:'power_speed_expression', metric:'sprint_stability', score,
            source:'training', date, evidenceId, rawValue:variation, method:'measured-training-sprint-repetition-time-cv' });
        }
        if (times.length >= 6) {
          // Late-set durability is about deterioration from early to late reps,
          // not variation across the entire series. Keep the observed order.
          const windowSize = Math.max(2, Math.floor(times.length / 3));
          const earlyPace = mean(times.slice(0, windowSize));
          const latePace = mean(times.slice(-windowSize));
          if (earlyPace > 0) {
            const deteriorationPct = Math.max(0, 100 * (latePace / earlyPace - 1));
            const durabilityScore = calibratedStabilityScore(deteriorationPct);
            if (durabilityScore !== null) {
              addMetric(records, { axis:'durability', metric:'late_set_stability', score:durabilityScore,
                source:'training', date, evidenceId, rawValue:deteriorationPct,
                method:'measured-training-early-to-late-pace-deterioration-pct' });
            }
          }
        }
      }
    }
    // Efficiency (D-6): no target stroke count is used or needed; training
    // stroke counts feed the measured indicators, not a target-referenced score.
    if (strokeCounts.length >= 3) {
      const variation = coefficientOfVariation(strokeCounts);
      const score = calibratedStabilityScore(variation);
      if (score !== null) {
        addMetric(records, { axis:'technical_control', metric:'stroke_count_stability', score,
          source:'training', date, evidenceId, rawValue:variation, method:'measured-training-stroke-count-cv' });
        if (times.length >= 3) {
          const paired = parsed.filter(rep => Number.isFinite(rep.time) && rep.time > 0 && Number.isFinite(rep.strokes) && rep.strokes > 0);
          if (paired.length >= 4) {
            const n = Math.max(2, Math.floor(paired.length / 3));
            const early = paired.slice(0, n);
            const late = paired.slice(-n);
            const earlyStrokes = mean(early.map(rep => rep.strokes));
            const lateStrokes = mean(late.map(rep => rep.strokes));
            const earlyTime = mean(early.map(rep => rep.time));
            const lateTime = mean(late.map(rep => rep.time));
            const deterioration = Math.max(0, 100 * (lateStrokes / earlyStrokes - 1), 100 * (lateTime / earlyTime - 1));
            const driftScore = calibratedStabilityScore(deterioration);
            if (driftScore !== null) addMetric(records, { axis:'robustness_of_efficiency', metric:'stroke_drift', score:driftScore,
              source:'training', date, evidenceId, rawValue:deterioration, method:'measured-training-late-set-deterioration' });
          }
        }
      }
    }
  }
  return records;
}

// Delivery evidence is reported independently from capability scoring. Completing
// prescribed repetitions is meaningful, but is not itself a 0-100 efficiency
// measurement. No stroke count is required to recognise a timed completion.
export function buildMeasuredTrainingCompletionSummary({ canonicalSets = [], swimmerId = '' } = {}) {
  const selected = String(swimmerId || '').trim();
  let setsWithRecordedReps = 0;
  let plannedRepetitions = 0;
  let recordedRepetitions = 0;
  let setsFullyRecorded = 0;
  let repsWithinPrescribedSendOff = 0;
  let comparableSendOffReps = 0;
  for (const set of asArray(canonicalSets)) {
    const planned = Math.max(0, Math.floor(toNumber(set?.reps ?? set?.numReps, 0))
      * Math.max(1, Math.floor(toNumber(set?.rounds ?? set?.numRounds, 1))));
    const measured = asArray(set?.resultsBySwimmer?.[selected]?.reps)
      .map(rep => parseResultTime(rep?.overallTime ?? rep?.time))
      .filter(time => Number.isFinite(time) && time > 0);
    plannedRepetitions += planned;
    recordedRepetitions += measured.length;
    if (measured.length) setsWithRecordedReps += 1;
    if (planned > 0 && measured.length >= planned) setsFullyRecorded += 1;
    // Only compare with an explicitly named send-off. Generic set duration
    // and target pace fields do not establish the prescribed departure clock.
    const sendOff = parseResultTime(set?.sendOff ?? set?.sendoff ?? set?.sendOffSeconds);
    if (Number.isFinite(sendOff) && sendOff > 0) {
      comparableSendOffReps += measured.length;
      repsWithinPrescribedSendOff += measured.filter(time => time <= sendOff).length;
    }
  }
  return {
    plannedRepetitions, recordedRepetitions, setsWithRecordedReps,
    setsFullyRecorded, comparableSendOffReps, repsWithinPrescribedSendOff,
    // Not a capability axis. Null means that the available records do not
    // prove a complete delivery ratio for all prescribed repetitions.
    recordingCoveragePct: plannedRepetitions > 0
      ? Math.min(100, Math.round(100 * recordedRepetitions / plannedRepetitions)) : null,
    sendOffAchievementPct: comparableSendOffReps > 0
      ? Math.round(100 * repsWithinPrescribedSendOff / comparableSendOffReps) : null,
  };
}

function buildExplicitSourceMetricRecords(db, source, rangeStart, rangeEnd, selectedSwimmerId) {
  const records = [];
  const selected = String(selectedSwimmerId || '').trim();
  const pools = [
    ...asArray(db?.capabilityMetricRecords),
    ...asArray(db?.metricResults),
    ...asArray(db?.capabilityMetrics),
  ];
  for (const row of pools) {
    // Even callers that bypass the scoped-DB wrapper must never attribute a
    // different swimmer's explicit metric to the requested athlete.
    const subject = String(row?.swimmerId || row?.athleteId || row?.participantId || row?.subjectId || row?.profileId || row?.metadata?.swimmerId || row?.meta?.swimmerId || '').trim();
    if (!selected || subject !== selected) continue;
    const rowDate = dateKey(row?.date || row?.recordedAt || row?.updatedAt);
    if (rangeStart && rowDate && rowDate < rangeStart) continue;
    if (rangeEnd && rowDate && rowDate > rangeEnd) continue;
    readExplicitMetricScores(row, records, source, rowDate, row?.id);
  }
  return records;
}

function sourceAgreementScore(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.source)) groups.set(record.source, []);
    groups.get(record.source).push(record.score);
  }
  const sourceMeans = Array.from(groups.values()).map(mean).filter(Number.isFinite);
  if (!sourceMeans.length) return 0;
  if (sourceMeans.length === 1) return 33;
  const spread = Math.max(...sourceMeans) - Math.min(...sourceMeans);
  return clamp(100 - (spread * 2.5));
}

// The documents define no formula for an axis confidence class (S14), so the
// axis label states only whether it was scored and how many of its metrics
// were measured.
function validationLabel(availableCount, definedCount) {
  return availableCount >= definedCount ? 'Scored' : `Scored (${availableCount} of ${definedCount} metrics)`;
}

export function calibrateTechnicalControlScore(rawScore, completeness) {
  const raw = Number(rawScore);
  if (!Number.isFinite(raw)) return null;
  const coverage = clamp(Number(completeness), 0, 100);
  const coverageRatio = coverage / 100;
  return clamp(
    50 + ((clamp(raw) - 50) * coverageRatio),
    0,
    coverage >= 99.5 ? 100 : 95,
  );
}

// AthlyraX Decision & Validation Engine §6 / Formal Decision Model §2.
// Sufficiency is a property of the evidence, never of the score: it counts
// eligible records and does not depend on how well the swimmer performed.
export const EVIDENCE_SUFFICIENCY_RULE = Object.freeze({
  minimumStructuredTests: 1,
  minimumTrainingSessions: 6,
  minimumAdditionalSources: 1,
  source: 'AthlyraX Decision & Validation Engine §6.1–6.3; Formal Decision Model §2.1–2.3',
});

// Display wording for the specification rule (owner decision D-17): meeting
// it means the minimum evidence is available, never that adaptation is
// reliably demonstrated or that confidence is high.
export const EVIDENCE_SUFFICIENCY_LABELS = Object.freeze({
  sufficient: 'Minimum evidence available',
  limited: 'Limited evidence',
  insufficient: 'Insufficient evidence',
});
export const EVIDENCE_SUFFICIENCY_MEANING = 'Minimum evidence available = at least 1 structured test, 6 attended training sessions and 1 further source (competition or coach observation). It is not proof of reliable adaptation or high confidence.';
export const evidenceSufficiencyLabel = (status) => EVIDENCE_SUFFICIENCY_LABELS[String(status || '').trim().toLowerCase()] || 'Not assessed';

export function assessEvidenceSufficiency({
  structuredTestCount = 0,
  trainingSessionCount = 0,
  competitionCount = 0,
  coachObservationCount = 0,
} = {}) {
  const count = (value) => Math.max(0, Math.floor(Number(value) || 0));
  const tests = count(structuredTestCount);
  const sessions = count(trainingSessionCount);
  const additional = count(competitionCount) + count(coachObservationCount);
  const criteria = {
    structuredTest: { required: EVIDENCE_SUFFICIENCY_RULE.minimumStructuredTests, recorded: tests,
      met: tests >= EVIDENCE_SUFFICIENCY_RULE.minimumStructuredTests },
    trainingSessions: { required: EVIDENCE_SUFFICIENCY_RULE.minimumTrainingSessions, recorded: sessions,
      met: sessions >= EVIDENCE_SUFFICIENCY_RULE.minimumTrainingSessions },
    additionalSource: { required: EVIDENCE_SUFFICIENCY_RULE.minimumAdditionalSources,
      recorded: additional, competitions: count(competitionCount), coachObservations: count(coachObservationCount),
      met: additional >= EVIDENCE_SUFFICIENCY_RULE.minimumAdditionalSources },
  };
  const reasons = [];
  if (!criteria.structuredTest.met) reasons.push('No structured test in the evidence window.');
  if (!criteria.trainingSessions.met) reasons.push(`${sessions} of ${EVIDENCE_SUFFICIENCY_RULE.minimumTrainingSessions} required training sessions attended.`);
  if (!criteria.additionalSource.met) reasons.push('No competition result or coach observation in the evidence window.');
  // Both documents classify a missing structured test as Insufficient. No
  // attended training at all is "very low training volume". Any other single
  // shortfall (borderline sessions, missing additional source) is Limited.
  const status = criteria.structuredTest.met && criteria.trainingSessions.met && criteria.additionalSource.met
    ? 'sufficient'
    : (!criteria.structuredTest.met || sessions === 0 ? 'insufficient' : 'limited');
  return {
    status,
    interpretationAllowed: status !== 'insufficient',
    criteria,
    reasons,
    // Undefined in the specification text available in the repository; these
    // conditions are not evaluated and must not be reported as satisfied.
    unevaluatedCriteria: ['No missing critical metrics', 'Missing baseline', 'Noise dominant / signal ratio R'],
    rule: EVIDENCE_SUFFICIENCY_RULE.source,
  };
}

function buildNotScoredAxis(axis, reason) {
  return {
    key: axis.key,
    label: axis.label,
    score: null,
    confidence: 0,
    validation: 'Not Scored',
    evidenceCount: 0,
    completeness: 0,
    recencyCoverage: 0,
    sourceAgreement: 0,
    availableMetrics: [],
    omittedMetrics: Object.keys(axis.metrics),
    reasons: [reason || 'No valid calibrated metric records in the selected window.'],
    metricRecords: [],
    metricSummaries: [],
    trendRecords: [],
  };
}

function scoreAxis(axis, records, calculationDate, phaseContext) {
  // Evidence after the evaluation date cannot already be a measured adaptation.
  // In particular, a selected future target-meet window must not credit results
  // that have not yet happened at the snapshot's as-of date.
  const evaluationDay = dateKey(calculationDate);
  const axisRecords = records.filter((record) => record.axis === axis.key && record.kind !== 'trend'
    && (!evaluationDay || dateKey(record.date) <= evaluationDay));
  const axisTrends = records.filter((record) => record.axis === axis.key && record.kind === 'trend'
    && (!evaluationDay || dateKey(record.date) <= evaluationDay));
  if (!axisRecords.length) {
    const unscored = buildNotScoredAxis(
      axis,
      axisTrends.length
        ? 'Only within-swimmer change (trend) evidence exists; no framework rule converts a change into an absolute capability score.'
        : (axis.key === 'adaptability'
          ? 'No valid longitudinal intervention, transfer and stabilisation evidence.'
          : 'No valid calibrated metric records in the selected window.'),
    );
    return { ...unscored, trendRecords: axisTrends };
  }

  // Locked core calculation (Mathematical Engine Specification):
  //   Ai = Σ(Sm·Wm·Ws·Wr·Wf·Wsignal) / Σ(Wm·Ws·Wr·Wf·Wsignal)
  // over every eligible metric record of the axis, in one stage. Sm is the
  // record's normalised metric score; Wm the axis metric weight; Ws the source
  // weight for the phase context; Wr the recency weight; Wf = min(1, E/Et)
  // with E the evidence records of that metric and Et the axis exposure
  // target; Wsignal the record's signal weight. No floors, no extra
  // source-reliability factor and no intermediate averages.
  const metricNames = Object.keys(axis.metrics);
  const exposureByMetric = new Map(metricNames.map((metric) => {
    const ids = new Set(axisRecords.filter((record) => record.metric === metric)
      .map((record, index) => String(record.evidenceId || '').trim() || `record-${index}`));
    return [metric, ids.size];
  }));
  const weighted = axisRecords.map((record) => {
    const Wm = Number(axis.metrics[record.metric]) || 0;
    const Ws = resolveSourceWeight(record.source, phaseContext);
    const Wr = recencyWeight(record.date, calculationDate);
    const Wf = frequencyWeight(exposureByMetric.get(record.metric) || 0, axis.exposureTarget);
    const Wsignal = Math.max(0, Math.min(1, Number(record.signal)));
    const weight = Wm * Ws * Wr * Wf * (Number.isFinite(Wsignal) ? Wsignal : 0);
    return { ...record, weights: { Wm, Ws, Wr, Wf, Wsignal, W: weight } };
  });
  const contributing = weighted.filter((record) => record.weights.W > 0 && Number.isFinite(Number(record.score)));
  const metricSummaries = metricNames.map((metric) => {
    const metricRecords = contributing.filter((record) => record.metric === metric);
    if (!metricRecords.length) return null;
    const weightSum = metricRecords.reduce((sum, record) => sum + record.weights.W, 0);
    return {
      metric,
      // Display only: the weighted mean of this metric's records. The axis
      // score is the single-stage sum over records, not an average of these.
      score: atLeastZero(metricRecords.reduce((sum, record) => sum + record.score * record.weights.W, 0) / weightSum),
      officialWeight: axis.metrics[metric] || 0,
      frequency: metricRecords[0].weights.Wf,
      effectiveWeight: weightSum,
      evidenceCount: metricRecords.length,
      sourceScores: [...new Set(metricRecords.map((record) => record.source))].map((source) => {
        const rows = metricRecords.filter((record) => record.source === source);
        const w = rows.reduce((sum, record) => sum + record.weights.W, 0);
        return { source, score: atLeastZero(rows.reduce((sum, record) => sum + record.score * record.weights.W, 0) / w), weight: w };
      }),
    };
  }).filter(Boolean);

  if (!metricSummaries.length) {
    return buildNotScoredAxis(axis, 'No valid weighted metric contribution remained after validation.');
  }

  const axisDenominator = contributing.reduce((sum, record) => sum + record.weights.W, 0);
  const rawScore = axisDenominator > 0
    ? atLeastZero(contributing.reduce((sum, record) => sum + (record.score * record.weights.W), 0) / axisDenominator)
    : null;
  const availableMetricNames = metricSummaries.map((metric) => metric.metric);
  const omittedMetrics = metricNames.filter((metric) => !availableMetricNames.includes(metric));
  const completeness = clamp(
    availableMetricNames.reduce((sum, metric) => sum + (axis.metrics[metric] || 0), 0) * 100,
  );
  // Official rule: capability quality is calculated from the available valid
  // calibrated metrics. Missing metrics are excluded and their weights rescaled.
  // Completeness affects confidence/validation below; it must not alter the score.
  const score = rawScore;
  const recencyCoverage = clamp(
    mean(axisRecords.map((record) => recencyWeight(record.date, calculationDate))) * 100,
  );
  const agreement = sourceAgreementScore(axisRecords);
  const confidence = clamp((0.35 * completeness) + (0.35 * recencyCoverage) + (0.30 * agreement));
  const evidenceIds = new Set(axisRecords.map((record) => String(record.evidenceId || '').trim()).filter(Boolean));

  return {
    key: axis.key,
    label: axis.label,
    score,
    confidence,
    validation: score === null ? 'Not Scored' : validationLabel(availableMetricNames.length, availableMetricNames.length + omittedMetrics.length),
    evidenceCount: evidenceIds.size || axisRecords.length,
    completeness,
    recencyCoverage,
    sourceAgreement: agreement,
    availableMetrics: availableMetricNames,
    omittedMetrics,
    reasons: score === null
      ? ['No valid weighted metric contribution remained after validation.']
      : (omittedMetrics.length
        ? [`Not measured in this window: ${omittedMetrics.join(', ')}.`]
        : []),
    metricRecords: weighted,
    metricSummaries,
    trendRecords: axisTrends,
  };
}

function resolveDeliveredVolume(set, selectedSwimmerId = '') {
  // Set-level delivered fields describe the set, not a swimmer: they are only
  // attributed to a selected swimmer when the set belongs to that swimmer.
  const selected = String(selectedSwimmerId || '').trim();
  const owner = String(set?.swimmerId || '').trim();
  const setLevelAttributable = !selected || selected === 'all' || owner === selected;
  const candidates = !setLevelAttributable ? [] : [
    set?.volumeSwam,
    set?.deliveredVolume,
    set?.actualVolume,
    set?.completedVolume,
    set?.volumeDelivered,
    set?.swamVolume,
  ];
  for (const candidate of candidates) {
    const value = toNumber(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  // A completed repetition with a recorded elapsed time is direct evidence
  // of that distance having been swum. Do not infer delivered volume from a
  // programmed set or from a different swimmer's lane.
  const observed = set?.resultsBySwimmer?.[selectedSwimmerId];
  const distance = toNumber(set?.distance ?? set?.distancePerRep);
  if (distance > 0 && observed) {
    const timedCount = asArray(observed?.reps).filter(rep =>
      Number.isFinite(parseResultTime(rep?.overallTime ?? rep?.time))).length;
    if (timedCount > 0) return Math.round(distance * timedCount);
  }
  return 0;
}

function resolveScopedCanonicalSets(db, selectedSquadId, rangeStart, rangeEnd) {
  const sessions = asArray(db?.trainingSessions);
  const schedules = getCanonicalScheduleRows(db);
  const sessionById = new Map(
    sessions
      .flatMap((row) => [row?.id, row?.sessionId, row?.trainingSessionId].map((id) => [String(id || '').trim(), row]))
      .filter(([id]) => Boolean(id)),
  );
  const scheduleById = new Map(
    schedules
      .flatMap((row) => [row?.id, row?.scheduleId, row?.trainingScheduleId].map((id) => [String(id || '').trim(), row]))
      .filter(([id]) => Boolean(id)),
  );
  const seen = new Set();
  const rows = [];

  for (const set of buildPlannerAuthoritativeSetRows(db)) {
    const sessionId = String(set?.sessionId || set?.trainingSessionId || '').trim();
    const session = sessionId ? (sessionById.get(sessionId) || null) : null;
    const scheduleId = String(
      set?.scheduleId
      || set?.trainingScheduleId
      || session?.scheduleId
      || session?.trainingScheduleId
      || '',
    ).trim();
    const schedule = scheduleId ? (scheduleById.get(scheduleId) || null) : null;
    if (!session && !schedule) continue;

    const setDate = dateKey(
      set?.date
      || set?.scheduleDate
      || set?.plannedDate
      || session?.date
      || session?.scheduleDate
      || session?.sessionDate
      || schedule?.date
      || schedule?.scheduleDate
      || '',
    );
    if (!setDate) continue;
    if (rangeStart && setDate < rangeStart) continue;
    if (rangeEnd && setDate > rangeEnd) continue;

    const squadIds = Array.from(new Set([
      ...asArray(set?.squadIds),
      set?.squadId,
      ...asArray(session?.squadIds),
      session?.squadId,
      ...asArray(schedule?.squadIds),
      schedule?.squadId,
    ].map((value) => String(value || '').trim()).filter(Boolean)));
    if (selectedSquadId && selectedSquadId !== 'all' && !squadIds.includes(selectedSquadId)) continue;

    const id = String(set?.id || '').trim();
    const signature = id || [sessionId, scheduleId, setDate, set?.setOrder, set?.order, set?.partName, set?.setName].join('|');
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    rows.push({
      ...set,
      date: setDate,
      scheduleDate: setDate,
      sessionId,
      trainingSessionId: sessionId,
      scheduleId,
      trainingScheduleId: scheduleId,
      squadIds,
    });
  }

  return rows;
}

export function buildAthlyraxCapabilitySnapshot({
  db = {},
  scope = {},
  activeWindow = null,
  activeAccountId = '',
  activeTenantId = '',
  calculationDate = new Date().toISOString().slice(0, 10),
  fallbackSpeedLevel = null,
  requireSpeedLevel = false,
} = {}) {
  const selectedSwimmerId = String(scope?.swimmerId || scope?.swimmer || 'all').trim();
  const selectedSquadId = String(scope?.squadId || scope?.squad || 'all').trim();
  const rangeStart = dateKey(activeWindow?.start || scope?.startDate || '');
  const rangeEnd = dateKey(activeWindow?.end || scope?.endDate || '');
  const canonicalSets = resolveScopedCanonicalSets(db, selectedSquadId, rangeStart, rangeEnd);
  const setById = new Map(canonicalSets.map((set) => [String(set?.id || ''), set]).filter(([id]) => Boolean(id)));
  const evidence = buildCanonicalSwimmerEvidence({
    db,
    swimmerId: selectedSwimmerId,
    activeAccountId,
    activeTenantId,
    rangeStart,
    rangeEnd,
  });
  const canonicalTests = asArray(evidence?.completedTests);
  const completedCompetitions = asArray(evidence?.completedCompetitions);
  const swimmer = asArray(db?.swimmers).find((row) => String(row?.id || '').trim() === selectedSwimmerId) || null;
  const selectedSingleSwimmer = selectedSwimmerId && selectedSwimmerId !== 'all' && selectedSwimmerId !== '__all__';
  const unweightedRecords = selectedSingleSwimmer
    ? [
      ...buildTestMetricRecords({ canonicalTests, setById, swimmer }),
      ...buildCompetitionMetricRecords({ completedCompetitions, swimmer }),
      ...buildEfficiencyAdaptabilityRecords({ canonicalTests, completedCompetitions, canonicalSets, swimmerId: selectedSwimmerId, swimmer,
        pushOffMetresPerWall: resolvePushOffAllowance(db),
        absentScheduleIds: new Set([...buildSwimmerScheduleDeliveryRatios(db, selectedSwimmerId).entries()]
          .filter(([, attendance]) => attendance?.attended === false).map(([scheduleId]) => scheduleId)) }),
      ...buildTrainingMeasurementRecords({
        canonicalSets, swimmerId: selectedSwimmerId,
        absentScheduleIds: new Set([...buildSwimmerScheduleDeliveryRatios(db, selectedSwimmerId).entries()]
          .filter(([, attendance]) => attendance?.attended === false).map(([scheduleId]) => scheduleId)),
      }),
      ...buildExplicitSourceMetricRecords(db, 'training', rangeStart, rangeEnd, selectedSwimmerId),
    ]
    : [];

  if (selectedSingleSwimmer) {
    for (const competition of completedCompetitions) {
      readExplicitMetricScores(
        competition?.raw?.result || competition?.raw || competition,
        unweightedRecords,
        'competition',
        competition?.date,
        competition?.id,
      );
    }
  }

  // Speed level: the best timed swim in the window, else the swimmer's best
  // earlier one (fallbackSpeedLevel). With neither, consistency cannot be
  // placed on the world-record scale; with requireSpeedLevel (the canonical
  // radars) those measures are not scored, since unweighted they would read
  // near 100 for any steady swimmer.
  const speedLevel = swimmerSpeedLevel(unweightedRecords) || fallbackSpeedLevel || null;
  const records = speedLevel || !requireSpeedLevel
    ? applySpeedLevel(unweightedRecords, speedLevel)
    : unweightedRecords.filter((record) => !isSpeedWeightedMetric(record));
  const awaitingSpeedAxes = speedLevel || !requireSpeedLevel ? new Set()
    : new Set(unweightedRecords.filter((record) => isSpeedWeightedMetric(record)).map((record) => record.axis));
  const phaseContext = resolvePhaseContext(scope);
  const calculationKey = dateKey(calculationDate) || new Date().toISOString().slice(0, 10);
  const axes = selectedSingleSwimmer
    ? ATHLYRAX_AXIS_DEFINITIONS.map((axis) => {
      const scored = scoreAxis(axis, records, calculationKey, phaseContext);
      return !Number.isFinite(scored.score) && awaitingSpeedAxes.has(axis.key)
        ? { ...scored, reasons: [SPEED_LEVEL_NEEDED_REASON, ...asArray(scored.reasons)] }
        : scored;
    })
    : ATHLYRAX_AXIS_DEFINITIONS.map((axis) => buildNotScoredAxis(axis, 'Select one swimmer to calculate an individual capability profile.'));
  const validAxes = axes.filter((axis) => Number.isFinite(axis.score));
  const integratedScore = validAxes.length
    ? atLeastZero(validAxes.reduce((sum, axis) => sum + axis.score, 0) / validAxes.length)
    : null;
  const integratedConfidence = validAxes.length
    ? clamp(validAxes.reduce((sum, axis) => sum + axis.confidence, 0) / validAxes.length)
    : 0;
  const fullRadarAvailable = validAxes.length === ATHLYRAX_AXIS_DEFINITIONS.length;

  const observedCompletion = buildMeasuredTrainingCompletionSummary({ canonicalSets, swimmerId:selectedSwimmerId });
  const load = canonicalSets.reduce((acc, set) => {
    acc.planned += Math.max(0, resolveIspPlannerSetVolume(set));
    acc.delivered += Math.max(0, resolveDeliveredVolume(set, selectedSwimmerId));
    return acc;
  }, { planned: 0, delivered: 0 });

  return {
    engineVersion: ATHLYRAX_FULL_ENGINE_VERSION,
    calculationDate: calculationKey,
    calibrationVersion: ATHLYRAX_FULL_ENGINE_CALIBRATION,
    selectedSwimmerId,
    selectedSquadId,
    selectedSingleSwimmer,
    rangeStart,
    rangeEnd,
    phaseContext,
    axes,
    validAxisCount: validAxes.length,
    trendEvidence: records.filter((record) => record.kind === 'trend'),
    fullRadarAvailable,
    integratedScore,
    integratedConfidence,
    speedLevel,
    integratedLabel: fullRadarAvailable ? 'Integrated Capability' : 'Limited capability summary',
    // No interpretation label from an undocumented confidence cut-off (S14);
    // the neutral evidence reading lives in capabilityEvidenceReading.js.
    decision: 'See evidence reading',
    loadSummary: {
      canonicalSetCount: canonicalSets.length,
      plannedVolume: Math.round(load.planned),
      deliveredVolume: Math.round(load.delivered),
      completedTestCount: canonicalTests.length,
      completedCompetitionCount: completedCompetitions.length,
      metricRecordCount: records.length,
      observedCompletion,
    },
    audit: {
      missingAxesAreNotZero: true,
      missingMetricsExcludedAndWeightsRescaled: true,
      coachObservationsExcludedFromCapabilityMath: true,
      sourceWeights: SOURCE_WEIGHTS[phaseContext],
      stabilityCalibration: STABILITY_ANCHORS,
    },
  };
}


// Calibration §27 "Stability sensitivity — CV multiplier": a PREVIEW-only
// per-axis multiplier applied to measured coefficients of variation before the
// existing CV→score mapping. 1.0 reproduces the published score exactly. It
// never creates evidence and never affects non-CV metrics.
export function applyStabilitySensitivity(snapshot, axisFactors = {}) {
  const factors = Object.fromEntries(Object.entries(axisFactors || {})
    .map(([axis, value]) => [axis, Number(value)])
    .filter(([, value]) => Number.isFinite(value) && value >= 0.5 && value <= 1.5 && value !== 1));
  if (!snapshot || !Object.keys(factors).length) return snapshot;
  const rescore = (record) => {
    const factor = factors[record?.axis];
    if (!factor || record?.kind === 'trend' || !/(^|-)cv(-|$)/.test(String(record?.method || ''))) return record;
    const cv = Number(record?.rawValue);
    const score = calibratedStabilityScore(cv * factor);
    return Number.isFinite(cv) && score !== null ? { ...record, score: clamp(score), calibrationFactor: factor } : record;
  };
  return {
    ...snapshot,
    axes: asArray(snapshot.axes).map((axis) => ({ ...axis, metricRecords: asArray(axis?.metricRecords).map(rescore) })),
  };
}

/**
 * Re-score a completed capability snapshot using only metric records whose
 * source is eligible for the requested radar. All four radars must use the
 * same measured metric weights and calibration, not training-label counts.
 */
export function buildMeasuredCapabilityRadarSeries(snapshot, allowedSources = []) {
  const accepted = new Set(allowedSources);
  const allMeasuredRecords = [
    ...asArray(snapshot?.axes).flatMap(axis => asArray(axis?.metricRecords)),
    ...asArray(snapshot?.trendEvidence),
  ];
  const eligibleRecords = allMeasuredRecords.filter(record => accepted.has(record?.source));
  // Re-score each source at the same as-of date used for the measured snapshot.
  // The selected target-cycle end may be in the future and must not age evidence.
  const calculationDate = snapshot?.calculationDate || snapshot?.rangeEnd || new Date().toISOString().slice(0,10);
  const phaseContext = snapshot?.phaseContext || 'default';
  const axisResults = ATHLYRAX_AXIS_DEFINITIONS.map(axis =>
    scoreAxis(axis, eligibleRecords, calculationDate, phaseContext));
  const scores = Object.fromEntries(axisResults.map(axis => [
    axis.key, axis.score === null ? Number.NaN : axis.score,
  ]));
  const counts = Object.fromEntries(axisResults.map(axis => [axis.key, axis.evidenceCount]));
  const recordIds = Object.fromEntries(axisResults.map(axis => [axis.key,
    [...new Set(asArray(axis.metricRecords)
      .map(record => String(record.evidenceId || '').trim()).filter(Boolean))],
  ]));
  const trends = Object.fromEntries(axisResults.map(axis => [axis.key, asArray(axis.trendRecords)]));
  return { scores, counts, recordIds, axes: axisResults, trends };
}
