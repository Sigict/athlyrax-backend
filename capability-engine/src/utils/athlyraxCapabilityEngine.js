import { buildCanonicalSwimmerEvidence } from './canonicalSwimmerEvidence.js';
import { buildPlannerAuthoritativeSetRows, resolveIspPlannerSetVolume } from './ispPlannerSource.js';
import {
  SWIMMING_CV_STABILITY_ANCHORS,
  SWIMMING_STABILITY_CALIBRATION_VERSION,
} from './olympicCapabilityCalibration.js';
import { getCanonicalScheduleRows } from './canonicalScheduleRows.js';
import { canonicalBuiltInTestTemplate } from './testTemplateCatalog.js';
import { resolveCompetitionCourseKey, isYardCourseKey } from './competitionCourse.js';
import { buildEfficiencyAdaptabilityIndicators, latestArmSpanCm } from './efficiencyAdaptabilityIndicators.js';
import { worldAquaticsScore, WORLD_AQUATICS_BASE_TIMES } from './worldAquaticsPoints.js';
import { resolvePushOffAllowance, eliteStrokeIndexReference, eliteDistancePerCycleReference, efficiencyStrokeFamily, EFFICIENCY_REFERENCE_STATUS } from '../data/efficiencyReference.js';
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
// A single timed swim implying more than this much higher speed than every other timed swim is
// treated as unconfirmed for the speed level (owner item 14): one implausible result must not lift
// every consistency axis. It still counts as its own evidence; with no such outlier nothing changes.
export const SPEED_LEVEL_OUTLIER_RATIO = 1.10;
export function swimmerSpeedLevel(records = []) {
  const ranked = asArray(records)
    .filter((record) => WORLD_LEVEL_METHODS.has(record?.method) && Number.isFinite(Number(record?.score)) && Number(record.score) > 0)
    .sort((a, b) => Number(b.score) - Number(a.score));
  const ratioOf = (record) => Math.cbrt(Number(record.score) / 100);
  // One swim can yield several records (test row and its repetition): compare with the best record
  // of a DIFFERENT piece of evidence.
  const evidenceOf = (record) => String(record?.evidenceId || record?.date || '');
  const excludedIds = new Set();
  let best = null;
  for (const record of ranked) {
    if (excludedIds.has(evidenceOf(record))) continue;
    const next = ranked.find((other) => evidenceOf(other) !== evidenceOf(record) && !excludedIds.has(evidenceOf(other)));
    if (next && ratioOf(record) > ratioOf(next) * SPEED_LEVEL_OUTLIER_RATIO) { excludedIds.add(evidenceOf(record)); continue; }
    best = record; break;
  }
  if (!best) return null;
  const excluded = [...excludedIds].filter(Boolean);
  return { ratio: ratioOf(best), points: Number(best.score) * 10, evidenceId: best.evidenceId || '', date: best.date || '', ...(excluded.length ? { unconfirmedOutliers: excluded } : {}) };
}

export const SPEED_LEVEL_NEEDED_REASON = 'Needs a timed test or race: consistency is weighted by how fast each set was swum relative to the swimmer\'s own best.';

// ============================================================================================
// EVIDENCE MODEL (owner decisions 16-11-2026, Stage 3; docs/verification/capability-audit-20261116/
// stage2-revised-design.md). Raw swim → derived measurement → capability interpretation.
//  * No speed-level or relative-demand multiplier: every measurement is scored as measured.
//  * One swim may inform several axes through DIFFERENT measurements; the same derived measurement
//    (same calculated value) is scored on ONE axis only (resolveSingleHome), enforced by
//    assertSingleHome, which fails the calculation on a duplicate.
//  * Relative speed (same-event best ÷ recorded time; same stroke, distance and course only) is
//    stored as CONTEXT on records and never changes a score.
//  * Efficiency is Not Calibrated: measured indicators and speed–stroke profiles are reported; no
//    0–100 score until a calibration is validated and approved.
//  * Adaptability is scored only from ≥ 2 comparable longitudinal comparisons.
// ============================================================================================
export const EVIDENCE_MODEL_VERSION = 'evidence-model-v1 (16-11-2026, draft)';
const SPEED_METHODS = new Set(['world-class-time-reference', 'competition-world-class-time-reference',
  'reference-normalised-maximum-velocity', 'reference-normalised-peak-time', 'reference-threshold-time']);
const REP_TIME_CV_METHODS = new Set(['aerobic-pace-cv', 'high-intensity-repeatability-cv', 'sprint-stability-cv',
  'measured-training-repetition-time-cv', 'measured-aerobic-training-repeatability-cv',
  'measured-intensive-training-repeatability-cv', 'measured-training-sprint-repetition-time-cv']);
const FATIGUE_LOSS_METHODS = new Set(['high-intensity-fatigue-loss', 'late-set-fatigue-loss']);
// Speed results are scored on Power & Speed for the World Aquatics event distances (validated base
// times). 25 m uses a derived base (not validated) and is kept as context only.
export const VALIDATED_SPEED_DISTANCES = Object.freeze([50, 100, 200, 400, 800, 1500]);
export const AEROBIC_REPEATABILITY_MIN_REPS = 6;
export const ADAPTABILITY_MIN_COMPARISONS = 2;
export const NOT_CALIBRATED = 'Not Calibrated';
// Calibration status (owner decision 16-11-2026): only the World Aquatics speed scale (single men's
// reference) and the Adaptability smallest-worthwhile-change scale (D-7) are owner-approved. Every other
// 0–100 mapping (CV/deterioration anchors, % of own best) is PROVISIONAL until validated on measured data.
const APPROVED_CALIBRATION_METHODS = new Set(['world-class-time-reference', 'competition-world-class-time-reference',
  'retest-response-vs-smallest-worthwhile-change', 'same-event-same-course-race-time-change-vs-smallest-worthwhile-change']);
export const PROVISIONAL_CALIBRATION_NOTE = 'Provisional calibration: this score uses a 0–100 mapping (variation/deterioration anchors or % of own best) that has not yet been validated on measured swimming data.';
export const INSUFFICIENT_EVIDENCE = 'Not Scored — Insufficient Evidence';
export const EFFICIENCY_NOT_CALIBRATED_REASON = 'Efficiency is Not Calibrated: measured stroke length, stroke rate, speed and stroke index are shown, but no validated 0–100 calibration has been approved (provisional elite references are not used for scoring).';

// The derived measurement a record holds. Records with the same (source, evidence, measure) are the
// same calculated value.
export function measureOf(record) {
  if (record?.measure) return record.measure;
  if (SPEED_METHODS.has(record?.method)) return 'speed-result';
  if (REP_TIME_CV_METHODS.has(record?.method)
    || (record?.method === 'cv-stability-calibration' && record?.metric === 'pace_stability')) return 'repetition-time-cv';
  if (FATIGUE_LOSS_METHODS.has(record?.method)) return 'fatigue-loss';
  if (record?.method === 'measured-training-early-to-late-pace-deterioration-pct') return 'pace-decay';
  return `${record?.axis}|${record?.metric}|${record?.method || 'explicit'}`;
}
export const measurementIdOf = (record) => `${record?.source || ''}|${record?.evidenceId || ''}|${measureOf(record)}`;

const courseClass = (course) => {
  const token = String(course ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (/^(50|50M|LC|LCM)$/.test(token)) return 'LC';
  if (/^(25|25M|SC|SCM)$/.test(token)) return 'SC';
  if (/Y/.test(token)) return 'SCY';
  return 'unrecorded';
};
const eventKey = (demand) => {
  const family = efficiencyStrokeFamily(demand?.stroke || 'freestyle') || 'other';
  return `${family}|${Number(demand?.distance) || 0}|${courseClass(demand?.course)}`;
};

// Repeat-set protocol classification (owner decision 16-11-2026): from the recorded EFFORT (intent
// in the prescription or test name), REPETITION DURATION and RECORDED RECOVERY, never from distance
// alone. Thresholds are PROVISIONAL (to be validated on real recorded sets).
// Software classification rules (owner decision 16-11-2026): provisional, NOT physiological boundaries.
// The recorded purpose of the set (name / energy code) remains the primary input.
export const PROTOCOL_THRESHOLDS = Object.freeze({
  sprintMaxRepSeconds: 30, sprintMinRestToWork: 2, highIntensityMaxRepSeconds: 120,
  status: 'provisional software classification rule, not a physiological boundary',
});
export function parseIntervalSeconds(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2}):(\d{2}(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(raw.replace(/s$/i, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function classifyRepeatProtocol({ sprintIntent = false, highIntensityIntent = false, aerobicIntent = false, meanRepSeconds = null, restSeconds = null } = {}) {
  if (restSeconds === null || restSeconds === undefined || !(Number(restSeconds) >= 0) || !(Number(meanRepSeconds) > 0)) return { protocolClass: 'unclassified', reason: 'no recorded recovery (send-off or rest)' };
  restSeconds = Number(restSeconds); meanRepSeconds = Number(meanRepSeconds);
  const t = PROTOCOL_THRESHOLDS;
  if (sprintIntent && meanRepSeconds <= t.sprintMaxRepSeconds && restSeconds >= t.sprintMinRestToWork * meanRepSeconds) return { protocolClass: 'sprint', reason: `sprint intent, ${meanRepSeconds.toFixed(1)} s reps, rest ${restSeconds.toFixed(0)} s` };
  if ((sprintIntent || highIntensityIntent) && meanRepSeconds <= t.highIntensityMaxRepSeconds) return { protocolClass: 'high-intensity', reason: `high-intensity intent, ${meanRepSeconds.toFixed(1)} s reps, rest ${restSeconds.toFixed(0)} s` };
  if (aerobicIntent) return { protocolClass: 'aerobic', reason: `aerobic intent, ${meanRepSeconds.toFixed(1)} s reps, rest ${restSeconds.toFixed(0)} s` };
  return { protocolClass: 'unclassified', reason: 'effort not recorded as sprint, high-intensity or aerobic' };
}
// Recovery provenance (owner decision 16-11-2026): send-off, swimming time and rest are separate.
//  1. recorded actual rest (pilot / console field; a recorded 0 s is real data, never "missing");
//  2. otherwise send-off − swimming time (0 when the swim used the whole send-off);
//  3. otherwise the prescribed rest (a prescribed 0:00 = continuous swimming, kept as 0).
// A prescribed rest is a plan: when a send-off is recorded the send-off governs the actual timing.
function protocolOf({ sendOff, rest, actualRest = null, times, sprintIntent, highIntensityIntent, aerobicIntent }) {
  const meanRep = times.length ? mean(times) : null;
  const recordedRest = actualRest === null || actualRest === undefined || actualRest === '' ? null : parseIntervalSeconds(actualRest) ?? (Number(actualRest) === 0 ? 0 : null);
  const prescribedRest = rest === null || rest === undefined || String(rest).trim() === '' ? null : (/^0+(:0+(\.0+)?)?$/.test(String(rest).trim()) ? 0 : parseIntervalSeconds(rest));
  const sendOffSeconds = parseIntervalSeconds(sendOff);
  const fromSendOff = sendOffSeconds !== null && meanRep > 0 ? Math.max(0, sendOffSeconds - meanRep) : null;
  let restSeconds = null; let restSource = 'not recorded';
  if (recordedRest !== null) { restSeconds = recordedRest; restSource = 'recorded actual rest'; }
  else if (fromSendOff !== null) { restSeconds = fromSendOff; restSource = 'send-off minus swimming time'; }
  else if (prescribedRest !== null) { restSeconds = prescribedRest; restSource = 'prescribed rest'; }
  return { ...classifyRepeatProtocol({ sprintIntent, highIntensityIntent, aerobicIntent, meanRepSeconds: meanRep, restSeconds }), restSeconds, restSource, meanRepSeconds: meanRep,
    sendOffSeconds, sendOffRecorded: restSeconds !== null };
}
const meanRecordedRest = (reps) => {
  const values = asArray(reps).map((rep) => rep?.actualRestSeconds ?? rep?.actualRest).filter((v) => v !== undefined && v !== null && v !== '')
    .map((v) => parseIntervalSeconds(v) ?? (Number(v) === 0 ? 0 : null)).filter((v) => v !== null);
  return values.length ? mean(values) : null;
};
// Race results that do not establish demonstrated speed (owner decision 16-11-2026: verified races only).
const UNVERIFIED_RACE = /\b(dq|dsq|disqualified|dnf|dns|unofficial|provisional|estimated|exhibition)\b/i;
export const isVerifiedRaceResult = (result) => !(result?.verified === false || UNVERIFIED_RACE.test(String(result?.status ?? result?.resultStatus ?? '')));

// Single-home resolution. Returns { records, excluded } where excluded lists records removed with a reason.
export function resolveSingleHome(records = []) {
  const groups = new Map();
  const passThrough = [];
  for (const record of records) {
    if (record?.kind === 'trend') { passThrough.push(record); continue; }
    const key = measurementIdOf(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const out = [...passThrough];
  const excluded = [];
  const exclude = (rows, reason) => rows.forEach((row) => excluded.push({ ...row, excludedReason: reason }));
  for (const rows of groups.values()) {
    const measure = measureOf(rows[0]);
    if (measure === 'speed-result') {
      // One speed result per swim, scored once on Power & Speed (validated event distances only).
      const preferred = rows.find((r) => WORLD_LEVEL_METHODS.has(r.method)) || rows[0];
      if (preferred?.demand && preferred.demand.maximal === false) { exclude(rows, 'not a maximal test, time trial or verified race: shown as context only'); continue; }
      const distance = Number(preferred?.context?.distance || preferred?.demand?.distance) || 0;
      if (!VALIDATED_SPEED_DISTANCES.includes(distance)) { exclude(rows, `speed result at ${distance || '?'} m: no validated reference distance; shown as context only`); continue; }
      out.push({ ...preferred, axis: 'power_speed_expression', metric: 'maximum_velocity', measure, homeRule: 'speed result → Power & Speed (single home)' });
      exclude(rows.filter((r) => r !== preferred), 'same speed result already scored on Power & Speed');
      continue;
    }
    if (measure === 'repetition-time-cv') {
      // Home by the recorded protocol class (effort, repetition duration, recorded recovery):
      // sprint → Power & Speed sprint stability; high-intensity → Anaerobic repeatability;
      // aerobic (≥ 6 reps) → Aerobic repeatability; unclassified → Technical Control pace stability.
      const demand = rows.find((r) => r.demand)?.demand || {};
      const cls = demand.protocolClass || 'unclassified';
      const base = rows.find((r) => r.axis === 'technical_control') || rows[0];
      let home = null; let rule = '';
      if (cls === 'sprint') { home = { axis: 'power_speed_expression', metric: 'sprint_stability' }; rule = `sprint protocol (${demand.reason}) → Power & Speed sprint stability`; }
      else if (cls === 'high-intensity') { home = { axis: 'anaerobic_capacity', metric: 'repeatability' }; rule = `high-intensity protocol (${demand.reason}) → Anaerobic repeatability`; }
      else if (cls === 'aerobic') {
        if (Number(demand.repCount) >= AEROBIC_REPEATABILITY_MIN_REPS) { home = { axis: 'aerobic_capacity', metric: 'repeatability' }; rule = `aerobic protocol (${demand.reason}) → Aerobic repeatability`; }
        else { exclude(rows, `aerobic repeatability needs a recorded send-off or rest and ≥ ${AEROBIC_REPEATABILITY_MIN_REPS} repetitions`); continue; }
      } else { home = { axis: 'technical_control', metric: 'pace_stability' }; rule = `protocol unclassified (${demand.reason || 'no recorded recovery'}) → Technical Control pace stability`; }
      const own = rows.find((r) => r.axis === home.axis && r.metric === home.metric) || base;
      out.push({ ...own, ...home, measure, homeRule: rule, protocolClass: cls });
      exclude(rows.filter((r) => r !== own), `same repetition-time variation already scored (${rule})`);
      continue;
    }
    if (measure === 'pace-decay') {
      // Early-to-late pace decay: Aerobic pace maintenance for an aerobic protocol, else Durability.
      const demand = rows[0].demand || {};
      const aerobicHome = demand.protocolClass === 'aerobic';
      out.push({ ...rows[0], ...(aerobicHome ? { axis: 'aerobic_capacity', metric: 'pace_stability' } : {}), measure,
        homeRule: aerobicHome ? 'aerobic protocol → Aerobic pace maintenance' : 'sustained set → Durability late-set stability' });
      continue;
    }
    if (measure === 'fatigue-loss') {
      const cls = rows.find((r) => r.demand)?.demand?.protocolClass;
      const anaerobicHome = cls === 'high-intensity' || cls === 'sprint';
      const home = (anaerobicHome ? rows.find((r) => r.axis === 'anaerobic_capacity') : rows.find((r) => r.axis === 'durability')) || rows[0];
      const target = anaerobicHome ? { axis: 'anaerobic_capacity', metric: 'fatigue_resistance' } : { axis: 'durability', metric: 'fatigue_resistance' };
      out.push({ ...home, ...target, measure, homeRule: anaerobicHome ? 'high-intensity repeats → Anaerobic fatigue loss' : 'sustained set → Durability fatigue loss' });
      exclude(rows.filter((r) => r !== home), 'same fatigue loss already scored');
      continue;
    }
    // Efficiency is Not Calibrated: its per-swim values are indicators, not scored records.
    if (rows[0].axis === 'efficiency' && rows[0].metric === 'speed_per_stroke') { exclude(rows, 'Efficiency indicator (Not Calibrated)'); continue; }
    // Within-session send-off response is an observation, not a longitudinal comparison.
    if (rows[0].method === 'tighter-send-off-pace-response-vs-smallest-worthwhile-change') { exclude(rows, 'within-session response: shown as an Adaptability observation, not a longitudinal comparison'); continue; }
    out.push(...rows.map((r) => ({ ...r, measure })));
  }
  return { records: out, excluded };
}

// Evidence carrying generated demonstration measurements (measurementSource 'synthetic-demo').
export function syntheticEvidenceIds(db = {}, swimmerId = '') {
  const ids = new Set();
  const marked = (value) => JSON.stringify(value ?? null).includes('synthetic-demo');
  for (const test of asArray(db?.tests)) if (String(test?.swimmerId) === swimmerId && marked(test)) ids.add(String(test.id));
  for (const set of asArray(db?.trainingSessionSets)) if (marked(set?.resultsBySwimmer?.[swimmerId])) ids.add(String(set.id));
  for (const fixture of asArray(db?.fixtures)) for (const event of asArray(fixture?.events)) {
    if (marked(event?.resultsBySwimmer?.[swimmerId])) ids.add(`${String(fixture?.id || '').trim()}:${String(event?.id || '').trim()}:${swimmerId}`);
  }
  return ids;
}

// Speed reserve at another pace (instruction §6): same-event best ÷ the given time. Context only.
export function speedReserveAtPace(sameEventBestsByKey = {}, { stroke = 'freestyle', distance, course, time }) {
  const key = eventKey({ stroke, distance, course });
  const best = sameEventBestsByKey?.[key];
  if (!best || !(Number(time) > 0)) return { status: 'unavailable', event: key, reason: 'no best for the same stroke, distance and course' };
  const relativeSpeed = best.time / Number(time);
  return { event: key, bestTime: best.time, time: Number(time), relativeSpeed, speedReserve: 1 - relativeSpeed,
    meaning: 'unused demonstrated speed against this event benchmark; not a physiological reserve' };
}

function efficiencySwims(measurements = [], syntheticIds = new Set()) {
  return asArray(measurements).filter((row) => row?.speed > 0 && row?.dpc > 0).map((row) => {
    const event = eventKey({ stroke: row.stroke, distance: row.distance, course: row.course });
    const time = Number(row.distance) / row.speed;
    return { id: row.id, source: row.source, date: row.date, event, family: event.split('|')[0], courseClass: event.split('|')[2],
      distance: Number(row.distance), speed: row.speed, dpc: row.dpc, strokeIndex: row.si,
      // Derived stroke rate (cycles per minute over the whole swim, push-off time included).
      strokeRate: Number(row.cycles) > 0 && time > 0 ? 60 * Number(row.cycles) / time : null, strokeRateDerived: true,
      synthetic: syntheticIds.has(String(row.id)) };
  });
}

// Efficiency analysis (Not Calibrated): indicators, speed–stroke profiles per stroke and course class,
// and the C3 candidate calibrations. Nothing here is a score.
export function buildEfficiencyAnalysis({ measurements = [], syntheticIds = new Set(), bests = {}, swimmer = null } = {}) {
  const swims = efficiencySwims(measurements, syntheticIds);
  const groups = new Map();
  for (const swim of swims) {
    const key = `${swim.family}|${swim.courseClass}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(swim);
  }
  const profiles = {};
  for (const [key, rows] of groups) {
    const [family, course] = key.split('|');
    // Fastest same-family, same-course event best, as a speed (for the "within 5 % of best" coverage rule).
    const bestSpeeds = Object.entries(bests).filter(([event]) => event.startsWith(`${family}|`) && event.endsWith(`|${course}`))
      .map(([event, best]) => Number(event.split('|')[1]) / best.time);
    const { predictStrokeLength, ...profile } = speedStrokeProfile(rows, { nearBestSpeed: bestSpeeds.length ? Math.max(...bestSpeeds) : null });
    void predictStrokeLength;
    profiles[key] = profile;
  }
  const mainKey = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length)[0];
  return {
    status: NOT_CALIBRATED,
    reason: EFFICIENCY_NOT_CALIBRATED_REASON,
    swims: swims.length,
    syntheticSwims: swims.filter((s) => s.synthetic).length,
    indicators: swims.map(({ id, source, date, event, speed, dpc, strokeRate, strokeIndex, synthetic }) => ({ id, source, date, event, speed, strokeLength: dpc, strokeRate, strokeIndex, synthetic })),
    profiles,
    candidates: efficiencyCalibrationCandidates({ swims: mainKey ? groups.get(mainKey) : [], armSpanCm: latestArmSpanCm(swimmer), profile: mainKey ? profiles[mainKey] : null }),
    calibrationNote: 'Synthetic demonstration measurements must not be used to choose a calibration.',
  };
}

// Adaptability investigations (owner priority 16-11-2026: recovery and technique adaptation).
// Observations only: never scored.
export function buildAdaptabilityInvestigations({ canonicalSets = [], swimmerId = '', efficiencyMeasurements = [], syntheticIds = new Set() } = {}) {
  // Recovery adaptation: the same set (name, distance, reps, send-off) repeated on different dates:
  // change in repetition-time variation and fatigue loss from the first to the last occurrence.
  const bySignature = new Map();
  for (const set of asArray(canonicalSets)) {
    const reps = asArray(set?.resultsBySwimmer?.[swimmerId]?.reps).map((rep) => parseResultTime(rep?.overallTime ?? rep?.time)).filter((t) => t > 0);
    const sendOff = String(set?.sendOff ?? set?.interval ?? '').trim();
    if (reps.length < 3 || !sendOff) continue;
    const signature = [String(set?.setName || '').trim().toLowerCase(), inferDistance(set, {}), reps.length, sendOff].join('|');
    const date = dateKey(set?.scheduleDate || set?.sessionDate || set?.date);
    if (!date) continue;
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature).push({ id: String(set.id), date, cv: coefficientOfVariation(reps), fatiguePct: 100 * (Math.max(...reps) / Math.min(...reps) - 1), synthetic: syntheticIds.has(String(set.id)) });
  }
  const recovery = [...bySignature].filter(([, rows]) => new Set(rows.map((r) => r.date)).size >= 2).map(([signature, rows]) => {
    const ordered = rows.sort((a, b) => a.date.localeCompare(b.date)); const first = ordered[0]; const last = ordered[ordered.length - 1];
    return { set: signature, occurrences: ordered.length, from: first.date, to: last.date, cvChange: last.cv - first.cv, fatigueLossChangePct: last.fatiguePct - first.fatiguePct, synthetic: ordered.some((r) => r.synthetic) };
  });
  // Technique adaptation: stroke length at comparable speed (±2 %), same stroke, distance and course,
  // earliest vs latest swim.
  const swims = efficiencySwims(efficiencyMeasurements, syntheticIds).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const technique = [];
  for (let i = 0; i < swims.length; i += 1) for (let j = swims.length - 1; j > i; j -= 1) {
    const a = swims[i]; const b = swims[j];
    if (a.event === b.event && a.date < b.date && Math.abs(b.speed / a.speed - 1) <= 0.02) { technique.push({ event: a.event, from: a.id, to: b.id, fromDate: a.date, toDate: b.date, strokeLengthChangePct: 100 * (b.dpc / a.dpc - 1), synthetic: a.synthetic || b.synthetic }); break; }
  }
  return {
    status: 'Investigation (not scored)',
    recoveryAdaptation: recovery.length ? recovery : { status: 'Insufficient Evidence', reason: 'no identical set with a recorded send-off repeated on two dates' },
    techniqueAdaptation: technique.length ? { comparisons: technique.length, meanStrokeLengthChangePct: mean(technique.map((t) => t.strokeLengthChangePct)), pairs: technique.slice(0, 20) } : { status: 'Insufficient Evidence', reason: 'no comparable-speed swims of the same event on two dates' },
  };
}

// Fails the calculation if one derived measurement is scored on two axes.
export function assertSingleHome(records = []) {
  const seen = new Map();
  for (const record of records) {
    if (record?.kind === 'trend') continue;
    const id = measurementIdOf(record);
    const place = `${record.axis}|${record.metric}`;
    if (seen.has(id) && seen.get(id) !== place) {
      throw new Error(`Duplicate scoring: measurement ${id} on ${seen.get(id)} and ${place}`);
    }
    seen.set(id, place);
  }
  return true;
}

// Relative speed as context: the swimmer's best time for the SAME stroke, distance and course class
// (recorded courses never mixed with unrecorded) ÷ the recorded time. Unavailable otherwise.
export function sameEventBests(records = []) {
  const bests = new Map();
  for (const record of records) {
    if (record?.measure !== 'speed-result' && !SPEED_METHODS.has(record?.method)) continue;
    const d = record.demand; if (!d || d.maximal === false) continue;
    const time = Number(d.bestTime || d.time); if (!(time > 0)) continue;
    const key = eventKey(d);
    if (!bests.has(key) || time < bests.get(key).time) bests.set(key, { time, evidenceId: record.evidenceId, date: record.date });
  }
  return bests;
}
export function addRelativeSpeedContext(records = []) {
  const bests = sameEventBests(records);
  const out = records.map((record) => {
    if (!record?.demand || record.kind === 'trend') return record;
    const best = bests.get(eventKey(record.demand));
    const time = Number(record.demand.time);
    const relativeSpeed = best && time > 0 ? best.time / time : null;
    return { ...record, relativeSpeed: relativeSpeed === null ? 'unavailable' : relativeSpeed,
      relativeSpeedReference: best ? { ...best, event: eventKey(record.demand) } : null };
  });
  // Dedicated measures that need a same-event best (16-11-2026, provisional linear scale: 100 = the
  // swimmer's own best pace). Aerobic sustainable pace: mean pace of an aerobic set (≥ 6 reps, recorded
  // recovery). Anaerobic repeat output: mean of the first two reps of a high-intensity set. Each is a
  // separate measurement of the set, never the speed result again; unavailable without a same-event best.
  const added = [];
  const seen = new Set();
  for (const record of out) {
    const d = record?.demand; if (!d || record.kind === 'trend' || seen.has(record.evidenceId + record.source)) continue;
    const best = bests.get(eventKey(d)); if (!best) continue;
    if (record.measure === 'repetition-time-cv' && d.protocolClass === 'aerobic' && Number(d.repCount) >= AEROBIC_REPEATABILITY_MIN_REPS && d.time > 0) {
      seen.add(record.evidenceId + record.source);
      added.push({ ...record, axis: 'aerobic_capacity', metric: 'threshold_pace', score: clamp(100 * best.time / d.time), rawValue: d.time,
        method: 'sustained-pace-vs-own-best', measure: 'sustained-pace', homeRule: 'aerobic set mean pace vs own same-event best (provisional linear scale)', relativeSpeed: best.time / d.time, relativeSpeedReference: { ...best, event: eventKey(d) } });
    } else if (record.measure === 'repetition-time-cv' && ['high-intensity', 'sprint'].includes(d.protocolClass) && d.firstRepsTime > 0) {
      seen.add(record.evidenceId + record.source);
      added.push({ ...record, axis: 'anaerobic_capacity', metric: 'peak_output', score: clamp(100 * best.time / d.firstRepsTime), rawValue: d.firstRepsTime,
        method: 'repeat-output-vs-own-best', measure: 'repeat-output', homeRule: 'first two reps of a high-intensity set vs own same-event best (provisional linear scale)', relativeSpeed: best.time / d.firstRepsTime, relativeSpeedReference: { ...best, event: eventKey(d) } });
    }
  }
  return { records: [...out, ...added], bests: Object.fromEntries([...bests].map(([k, v]) => [k, v])) };
}

// Speed–stroke profile (C2): per stroke family and course class, from stroke-counted swims. No forced
// slope sign; outliers beyond 3 median absolute deviations of the stroke-length residual are excluded
// and listed; no prediction outside the observed speed range; Insufficient Evidence when coverage is thin.
export const PROFILE_MIN_SWIMS = 5;
export const PROFILE_MIN_SPEED_SPAN = 0.10;
export const PROFILE_NEAR_BEST = 0.95;
function linearFit(points) {
  const n = points.length; const mx = mean(points.map((p) => p.x)); const my = mean(points.map((p) => p.y));
  const sxx = points.reduce((t, p) => t + (p.x - mx) ** 2, 0);
  if (!(sxx > 0)) return null;
  const slope = points.reduce((t, p) => t + (p.x - mx) * (p.y - my), 0) / sxx;
  const intercept = my - slope * mx;
  const residualSd = Math.sqrt(points.reduce((t, p) => t + (p.y - (intercept + slope * p.x)) ** 2, 0) / Math.max(1, n - 2));
  return { slope, intercept, residualSd, n };
}
const median = (values) => { const v = [...values].sort((a, b) => a - b); const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
export function speedStrokeProfile(swims = [], { nearBestSpeed = null } = {}) {
  const rows = asArray(swims).filter((s) => Number(s.speed) > 0 && Number(s.dpc) > 0);
  const base = { swims: rows.length, synthetic: rows.filter((s) => s.synthetic).length };
  if (rows.length < PROFILE_MIN_SWIMS) return { status: 'Insufficient Evidence', reason: `needs ≥ ${PROFILE_MIN_SWIMS} stroke-counted swims (${rows.length})`, ...base };
  const first = linearFit(rows.map((s) => ({ x: s.speed, y: s.dpc })));
  if (!first) return { status: 'Insufficient Evidence', reason: 'no speed variation', ...base };
  const residuals = rows.map((s) => s.dpc - (first.intercept + first.slope * s.speed));
  const med = median(residuals); const mad = median(residuals.map((r) => Math.abs(r - med)));
  const keep = []; const outliers = [];
  rows.forEach((s, i) => ((mad > 0 && Math.abs(residuals[i] - med) > 3 * mad) ? outliers : keep).push(s));
  const speeds = keep.map((s) => s.speed); const lo = Math.min(...speeds); const hi = Math.max(...speeds);
  const span = (hi - lo) / hi;
  if (keep.length < PROFILE_MIN_SWIMS || span < PROFILE_MIN_SPEED_SPAN) return { status: 'Insufficient Evidence', reason: `needs ≥ ${PROFILE_MIN_SWIMS} swims spanning ≥ ${100 * PROFILE_MIN_SPEED_SPAN} % of speed (span ${(100 * span).toFixed(1)} %)`, outliers: outliers.map((s) => s.id), ...base };
  if (nearBestSpeed > 0 && hi < PROFILE_NEAR_BEST * nearBestSpeed) return { status: 'Insufficient Evidence', reason: `no swim within ${100 - 100 * PROFILE_NEAR_BEST} % of the same-event best speed`, outliers: outliers.map((s) => s.id), ...base };
  const dpcFit = linearFit(keep.map((s) => ({ x: s.speed, y: s.dpc })));
  const rateRows = keep.filter((s) => Number(s.strokeRate) > 0);
  const rateFit = rateRows.length >= PROFILE_MIN_SWIMS ? linearFit(rateRows.map((s) => ({ x: s.speed, y: s.strokeRate }))) : null;
  const direction = Math.abs(dpcFit.slope) * (hi - lo) < dpcFit.residualSd ? 'approximately flat' : dpcFit.slope > 0 ? 'stroke length increases with speed' : 'stroke length decreases with speed';
  return { status: 'Profile', speedRange: [lo, hi], strokeLength: dpcFit, strokeRate: rateFit, direction, outliers: outliers.map((s) => s.id),
    measured: keep.length - keep.filter((s) => s.synthetic).length, ...base,
    // Prediction only inside the observed speed range; labelled estimated by the caller.
    predictStrokeLength: (speed) => (speed >= lo && speed <= hi ? dpcFit.intercept + dpcFit.slope * speed : null) };
}

// C3 candidate calibrations: computed for analysis and testing; none is used as a score.
export function efficiencyCalibrationCandidates({ swims = [], armSpanCm = null, profile = null } = {}) {
  const rows = asArray(swims).filter((s) => s.speed > 0 && s.dpc > 0).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  // (a) Same swimmer, comparable speed (±2 %), same stroke, distance and course: stroke-length change first → last.
  const comparable = [];
  for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
    const a = rows[i]; const b = rows[j];
    if (a.event === b.event && a.date < b.date && Math.abs(b.speed / a.speed - 1) <= 0.02) comparable.push({ from: a.id, to: b.id, dpcChangePct: 100 * (b.dpc / a.dpc - 1) });
  }
  // (b) Stroke length relative to arm span (context; arm span alone is not propulsive efficiency).
  const span = Number(armSpanCm) > 0 ? Number(armSpanCm) / 100 : null;
  return {
    withinSwimmerComparableSpeed: comparable.length ? { comparisons: comparable.length, meanDpcChangePct: mean(comparable.map((c) => c.dpcChangePct)), pairs: comparable.slice(0, 20) } : { status: 'Insufficient Evidence' },
    strokeLengthPerArmSpan: span ? { meanRatio: mean(rows.map((s) => s.dpc / span)), armSpanM: span } : { status: 'Insufficient Evidence', reason: 'no arm span recorded' },
    techniqueRetention: profile?.status === 'Profile' ? { strokeLengthSlopePerMs: profile.strokeLength.slope, direction: profile.direction } : { status: 'Insufficient Evidence' },
    normativeStrokeIndex: { status: 'Unavailable', reason: 'no sourced, peer-reviewed normative stroke-index dataset in the repository' },
    calibrationChosen: null,
  };
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
// ONE SPEED SCALE (owner decision 16-11-2026, option B): every swimmer's time is
// scored against the same reference (the men's base times), whatever the swimmer's
// sex, so a faster swimmer always scores higher and a slower one lower. The speed
// level that weights the consistency axes is derived from these scores and so uses
// the same scale. Displayed World Aquatics points (worldAquaticsPoints) stay sex-specific.
export const RADAR_SPEED_REFERENCE_SEX = 'male';
function performanceReferenceScore({ time, distance, stroke, course }) {
  return worldAquaticsScore({ time, distance, stroke, sex: RADAR_SPEED_REFERENCE_SEX, course });
}

// Efficiency reference (D-6, owner decision 25-10-2026: elite table).
// Elite speed = the world-class reference above; elite distance per stroke
// cycle = speed × 60 / elite stroke rate (cycles/min), so elite Stroke Index =
// speed² × 60 / stroke rate. PROVISIONAL stroke rates (typical elite race
// values) pending owner confirmation of the table.
// Elite Stroke Index reference: src/data/efficiencyReference.js (stroke-, sex- and
// course-specific world records; provisional elite stroke-rate table).
export const EFFICIENCY_REFERENCE_NOTE = 'Efficiency 0–100 = the swimmer\'s distance per stroke cycle at their own maximum effort ÷ elite distance per cycle × 100 (elite: world-record speed of the same stroke, distance, sex and pool course × 60 ÷ elite stroke rate, provisional table). Swims below 95 % of the swimmer\'s own best speed are moved to maximum effort along the swimmer\'s own speed–efficiency profile and marked estimated. Speed itself is not part of the efficiency score.';
export function eliteStrokeIndex({ distance, stroke, sex, course = 'LC' }) {
  return eliteStrokeIndexReference({ distance: Number(distance), stroke, sex, course });
}

// Adaptability scale (D-7, owner decision 25-10-2026): 50 = no change; each
// 0.4 % of performance (the smallest worthwhile change in competitive swimming
// performance, Pyne et al. 2004) moves the score 10 points; bounded 0–100.
export const ADAPTABILITY_SMALLEST_WORTHWHILE_CHANGE_PCT = 0.4;
export const EFFICIENCY_MIN_INDEPENDENT_SWIMS = 2;
export function efficiencyEvidenceReasons(status) {
  if (!status) return [];
  const out = [];
  if (status.validSwims < status.minimum) out.push(`Efficiency needs at least ${status.minimum} valid stroke-counted swims (tests, races or training sets); ${status.validSwims} recorded.`);
  if (status.flagged?.length) out.push(`${status.flagged.length} stroke measurement${status.flagged.length === 1 ? '' : 's'} above the elite reference ${status.flagged.length === 1 ? 'needs' : 'need'} coach verification before counting (check the stroke count, distance and pool course).`);
  return out;
}
export const adaptabilityScoreFromImprovement = (improvementPct) => (Number.isFinite(improvementPct)
  ? clamp(50 + 10 * (improvementPct / ADAPTABILITY_SMALLEST_WORTHWHILE_CHANGE_PCT)) : null);

// Efficiency and Adaptability scored records from the same measured indicators
// shown in Analysis and the ISP (no target stroke counts).
function buildEfficiencyAdaptabilityRecords({ canonicalTests, completedCompetitions, canonicalSets, swimmerId, swimmer, absentScheduleIds, pushOffMetresPerWall }) {
  const records = [];
  const sets = asArray(canonicalSets).map((set) => ({ ...set, __ispSwimmerResult: set?.resultsBySwimmer?.[swimmerId] || null }));
  const deliveryBySchedule = new Map([...(absentScheduleIds || [])].map((id) => [String(id), { attended: false }]));
  const sex = swimmer?.gender || swimmer?.sex;
  const indicators = buildEfficiencyAdaptabilityIndicators({ tests: canonicalTests, competitions: completedCompetitions, sets, deliveryBySchedule, pushOffMetresPerWall,
    eliteReference: (row) => eliteStrokeIndex({ distance: row.distance, stroke: row.stroke, sex, course: row.course }), armSpanCm: latestArmSpanCm(swimmer) });
  const sourceOf = { test: 'testing', competition: 'competition', training: 'training' };
  // Efficiency evidence rule (owner decision 08-11-2026, options A + B):
  // B. A stroke measurement above the elite reference Stroke Index is flagged for
  //    coach verification and does not count until verified (strokeMeasurementVerified
  //    on the test, race result or training result). Implausible counts are flagged,
  //    never silently capped; a verified one counts (shown within the radar's 0-100
  //    scale, RADAR_SCORE_CAP, as for every axis). Nothing is deleted or changed.
  // A. Efficiency is scored only from at least EFFICIENCY_MIN_INDEPENDENT_SWIMS valid
  //    swims (separate tests, races or training sets); otherwise Not Scored.
  const valid = []; const flagged = []; const noReference = [];
  for (const row of indicators.efficiency.measurements) {
    // No validated reference for this swim (25 m, 800/1500 m, yards, medley): measured and tracked, not scored.
    if (!(row.eliteSi > 0)) { noReference.push(row.id); continue; }
    const ratio = row.si / row.eliteSi;
    const entry = { id: row.id, source: row.source, date: row.date, label: row.label, ratioPct: Math.round(ratio * 1000) / 10, verifyTarget: row.verifyTarget };
    if (ratio > 1 && row.verified !== true) { flagged.push(entry); continue; }
    valid.push({ row, score: ratio * 100, entry: { ...entry, verified: row.verified === true } });
  }
  const independentSwims = new Set(valid.map(({ row }) => `${row.source}|${row.id}`)).size;
  if (independentSwims >= EFFICIENCY_MIN_INDEPENDENT_SWIMS) {
    for (const { row, score } of valid) {
      addMetric(records, { axis: 'efficiency', metric: 'speed_per_stroke', score,
        source: sourceOf[row.source], date: row.date, evidenceId: row.id, signal: 1, rawValue: row.si,
        method: 'stroke-index-vs-elite-reference',
        demand: row.speed > 0 && row.distance > 0 ? { distance: row.distance, time: row.distance / row.speed, stroke: row.stroke, course: row.course } : null,
        dpc: row.dpc, eliteDpc: eliteDistancePerCycleReference({ distance: row.distance, stroke: row.stroke, sex, course: row.course }),
        // The radar is 0–100; the % of the reference is kept uncapped for tracking beyond it.
        context: { referencePct: Math.round(score * 10) / 10, eliteSi: row.eliteSi, course: row.course, verified: row.verified === true } });
    }
  }
  const evidence = { validSwims: independentSwims, flagged, minimum: EFFICIENCY_MIN_INDEPENDENT_SWIMS,
    counted: valid.map(({ entry }) => entry), noReference: noReference.length, referenceStatus: EFFICIENCY_REFERENCE_STATUS,
    implausibleExcluded: Object.values(indicators.efficiency.excludedImplausible || {}).reduce((sum, n) => sum + (Number(n) || 0), 0) };
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
  return { records, efficiencyEvidence: evidence, indicatorMeasurements: indicators.efficiency.measurements, sex };
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
  demand = null,
  dpc = null,
  eliteDpc = null,
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
    // Pace of the swim behind the record (relative demand) and, for efficiency, its measured and
    // elite distance per stroke cycle. Used by applyRelativeDemand.
    ...(demand ? { demand } : {}),
    ...(Number(dpc) > 0 ? { dpc: Number(dpc) } : {}),
    ...(Number(eliteDpc) > 0 ? { eliteDpc: Number(eliteDpc) } : {}),
  });
}

// Attach the pace of each swim (distance, mean time, stroke, course) to the records it produced.
function annotateDemand(records, demandById) {
  return records.map((record) => (record.demand || !demandById.has(record.evidenceId) ? record
    : { ...record, demand: demandById.get(record.evidenceId) }));
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
  const demandById = new Map();
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
    // Sprint intent from the recorded protocol, not from distance alone (16-11-2026; same rule as training).
    const sprint = /sprint|speed|power|max|start|\bsp\b/.test(text);
    const testSignal = signalWeight({ values: times, secondaryValues: strokes, explicit: true });
    // Free-text swimming test names may be the only stroke information for
    // manually recorded tests. Use a recognised stroke token, never guess.
    const strokeName = String(test?.testName || raw?.testName || '').trim();
    const namedStroke = strokeName.match(/\b(freestyle|free|front crawl|fr|backstroke|back|breaststroke|breast|butterfly|fly|medley|im)\b/i)?.[1] || '';
    const measuredStroke = test?.stroke || raw?.stroke || set?.stroke || namedStroke || protocol?.stroke || '';
    // Speed results come from MAXIMAL efforts only (a single-rep max test or a test named max / time
    // trial); the fastest rep of a repeat set is submaximal and is not a maximum-speed result (16-11-2026).
    // Maximal test or time trial only (16-11-2026): a single repetition is not automatically maximal.
    const maximalTemplate = /builtin-test-max\b/.test(String(test?.templateId || raw?.templateId || '')) || /^max$/i.test(String(raw?.templateName || test?.templateName || '').trim());
    const maximalEffort = maximalTemplate || /\bmax\b|max effort|time trial|\btt\b/.test(text);
    // Effort from the recorded protocol only, never from distance (16-11-2026): the test name and the
    // energy code recorded on the test, its linked set or the canonical protocol (e.g. the Repeatability
    // battery is recorded as EN2, the Max battery as SP).
    const energyCode = String(raw?.energy ?? raw?.energySystem ?? set?.energy ?? set?.energySystem ?? protocol?.energy ?? '').trim().toLowerCase();
    const highIntensityIntent = /race\s*pace|broken|anaerobic|lactate|\ben3\b|\blt\b|\blp\b|high[\s-]*intensity/.test(text) || TRAINING_INTENSIVE_CODES.test(energyCode);
    const aerobicIntent = /threshold|aerobic|endurance|\ben1\b|\ben2\b|\ba1\b|\ba2\b/.test(text) || TRAINING_AEROBIC_CODES.test(energyCode);
    const protocolInfo = protocolOf({ sendOff: raw?.sendOff ?? raw?.interval ?? set?.sendOff ?? set?.interval ?? protocol?.sendOff,
      rest: raw?.rest ?? set?.rest, actualRest: raw?.actualRest ?? meanRecordedRest(collectTestRepRows(test, raw)),
      times, sprintIntent: sprint || energyCode === 'sp', highIntensityIntent, aerobicIntent });
    const performanceScore = times.length && maximalEffort
      ? performanceReferenceScore({ time: Math.min(...times), distance, sex: raw?.gender || raw?.sex || swimmer?.gender || swimmer?.sex, stroke: measuredStroke,
        course: test?.course || raw?.course || set?.course || test?.poolLength || raw?.poolLength })
      : null;

    readExplicitMetricScores(raw, records, 'testing', date, evidenceId);
    if (times.length && distance > 0) demandById.set(String(evidenceId || ''), { distance, time: mean(times), bestTime: Math.min(...times), stroke: measuredStroke,
      course: test?.course || raw?.course || set?.course || test?.poolLength || raw?.poolLength, repCount: times.length,
      firstRepsTime: times.length ? mean(times.slice(0, 2)) : null, maximal: maximalEffort,
      measurementSources: [...new Set(collectTestRepRows(test, raw).map((rep) => String(rep?.measurementSource || raw?.measurementSource || 'recorded')))],
      ...protocolInfo });

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
    // Anaerobic recovery-dependent output (16-11-2026): mean speed of reps 2..n ÷ rep 1, only under a
    // recorded recovery; scored on the provisional CV/deterioration anchors as % loss.
    if (times.length >= 3 && protocolInfo.restSeconds !== null && ['high-intensity', 'sprint'].includes(protocolInfo.protocolClass)) {
      const lossPct = Math.max(0, 100 * (mean(times.slice(1)) / times[0] - 1));
      const recoveryScore = calibratedStabilityScore(lossPct);
      if (recoveryScore !== null) addMetric(records, { axis: 'anaerobic_capacity', metric: 'recovery_index', score: recoveryScore, date, evidenceId,
        signal: testSignal, rawValue: lossPct, method: 'output-retention-under-recorded-recovery', context: { restSeconds: protocolInfo.restSeconds, repCount: times.length } });
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
  return annotateDemand(records, demandById);
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
  const demandById = new Map();
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
    demandById.set(String(evidenceId || ''), { distance, time, bestTime: time, stroke, course: courseKey, repCount: 1, race: true, maximal: isVerifiedRaceResult(result) });

    // Any pool course: a yard race is scored at the same pace over the matching
    // short course metre event (worldAquaticsPoints, labelled approximate).
    const performanceScore = isVerifiedRaceResult(result)
      ? performanceReferenceScore({ time, distance, sex: result?.gender || result?.sex || swimmer?.gender || swimmer?.sex, stroke, course: courseKey })
      : null;
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
      // Durability: late-race decay (a different measurement from the split CV above): mean of the last
      // third of segments ÷ mean of the first third, excluding the dive segment.
      const swumSegments = segments.slice(1);
      if (distance >= 200 && swumSegments.length >= 3) {
        const third = Math.max(1, Math.floor(swumSegments.length / 3));
        const decayPct = Math.max(0, 100 * (mean(swumSegments.slice(-third)) / mean(swumSegments.slice(0, third)) - 1));
        const decayScore = calibratedStabilityScore(decayPct);
        if (decayScore !== null) addMetric(records, { axis: 'durability', metric: 'late_set_stability', score: decayScore, source: 'competition', date, evidenceId, signal: signalWeight({ values: swumSegments, explicit: true }), rawValue: decayPct, method: 'competition-late-race-decay' });
      }
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
  return annotateDemand(records, demandById);
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
  aerobic_capacity: 'repeatability (CV) and pace maintenance of an aerobic set (EN1/EN2/EN3, A1/A2) with a recorded send-off or rest and at least 6 timed repetitions',
  anaerobic_capacity: 'repeatability (CV) and output after recorded recovery of a high-intensity set (EN3, LT, LP, B1/B2, C1-C3, RG, or sprint effort) with a recorded send-off or rest and at least 3 timed repetitions',
  power_speed_expression: 'sprint stability (CV) of a sprint set: sprint effort (energy code SP, or sprint/speed/power/max/start in the set name), repetitions of 30 s or less and recorded rest of at least twice the swimming time (provisional thresholds)',
  adaptability: null,
  durability: 'early-to-late pace deterioration of a set with at least 6 timed repetitions',
});
export const TRAINING_AXIS_UNDEFINED_REASON = Object.freeze({
  efficiency: 'Efficiency is scored in Capability (decision D-6): Stroke Index from tests, races and stroke-counted training repetitions against the elite Stroke Index reference. No target stroke counts are used.',
  adaptability: 'Adaptability is scored in Capability only from at least two comparable longitudinal comparisons (retests, same-event races), 50 = no change; a single within-session response is shown as an observation.',
});

function buildTrainingMeasurementRecords({ canonicalSets, swimmerId, absentScheduleIds = new Set() }) {
  const records = [];
  const demandById = new Map();
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
    const setDistance = inferDistance(set, {});
    const protocolInfo = protocolOf({ sendOff: set?.sendOff ?? set?.interval ?? swimmerResult?.sendOff, rest: set?.rest ?? swimmerResult?.rest,
      actualRest: swimmerResult?.actualRest ?? meanRecordedRest(repetitions), times,
      sprintIntent: kinds.sprint, highIntensityIntent: kinds.intensive, aerobicIntent: kinds.aerobic });
    if (times.length && setDistance > 0) demandById.set(evidenceId, { distance: setDistance, time: mean(times), bestTime: Math.min(...times), stroke: set?.stroke, course: set?.course || set?.poolLength,
      repCount: times.length, firstRepsTime: mean(times.slice(0, 2)), maximal: false,
      measurementSources: [...new Set(repetitions.map((rep) => String(rep?.measurementSource || swimmerResult?.measurementSource || 'recorded')))], ...protocolInfo });
    if (times.length >= 3 && protocolInfo.restSeconds !== null && ['high-intensity', 'sprint'].includes(protocolInfo.protocolClass)) {
      const lossPct = Math.max(0, 100 * (mean(times.slice(1)) / times[0] - 1));
      const recoveryScore = calibratedStabilityScore(lossPct);
      if (recoveryScore !== null) addMetric(records, { axis: 'anaerobic_capacity', metric: 'recovery_index', score: recoveryScore, source: 'training', date, evidenceId,
        rawValue: lossPct, method: 'output-retention-under-recorded-recovery', context: { restSeconds: protocolInfo.restSeconds, repCount: times.length } });
    }
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
            // Stroke maintenance only (owner decision 16-11-2026): the time change is Durability's own
            // early-to-late pace measurement and is not scored again here.
            const deterioration = Math.max(0, 100 * (lateStrokes / earlyStrokes - 1));
            void lateTime; void earlyTime;
            const driftScore = calibratedStabilityScore(deterioration);
            if (driftScore !== null) addMetric(records, { axis:'robustness_of_efficiency', metric:'stroke_drift', score:driftScore,
              source:'training', date, evidenceId, rawValue:deterioration, method:'measured-training-late-set-deterioration' });
          }
        }
      }
    }
  }
  return annotateDemand(records, demandById);
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
  // Agreement needs at least two independent sources; with one it is not awarded (null), not scored.
  if (sourceMeans.length < 2) return null;
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

// Confidence (16-11-2026): starting assumptions, not validated constants; tested for sensitivity.
// A component that cannot be assessed (agreement with one source) is left out and the remaining
// weights are rescaled, so it is never awarded by default.
export const CONFIDENCE_WEIGHTS = Object.freeze({ completeness: 0.30, exposure: 0.25, recency: 0.25, agreement: 0.20 });
export function combineConfidence(components, weights = CONFIDENCE_WEIGHTS) {
  const present = Object.entries(weights).filter(([key]) => Number.isFinite(components?.[key]));
  const total = present.reduce((sum, [, w]) => sum + w, 0);
  return total > 0 ? clamp(present.reduce((sum, [key, w]) => sum + w * components[key], 0) / total) : 0;
}

function scoreAxis(axis, records, calculationDate, phaseContext) {
  if (axis.key === 'efficiency') {
    return { ...buildNotScoredAxis(axis, EFFICIENCY_NOT_CALIBRATED_REASON), validation: NOT_CALIBRATED, notCalibrated: true,
      trendRecords: records.filter((record) => record.axis === 'efficiency' && record.kind === 'trend') };
  }
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

  // Evidence-neutral axis score (owner decision 16-11-2026; replaces the single-stage
  // Σ(Sm·Wm·Ws·Wr·Wf·Wsignal) / Σ(Wm·Ws·Wr·Wf·Wsignal)):
  //   1. per metric and source: S(m,s) = Σ(Sm·Wr·Wsignal) / Σ(Wr·Wsignal) over its records;
  //   2. per metric: S(m) = Σ_s Ws·S(m,s) / Σ_s Ws over the sources that measured it;
  //   3. per axis:   A = Σ_m Wm·S(m) / Σ_m Wm over the measured metrics.
  // Measurement weights (Wm, Ws) are therefore the same for every swimmer: how many records a
  // metric or source has, and how much evidence exists (Wf = min(1, E/Et)), no longer changes the
  // mix of measures inside the axis. Fewer records, older results and missing measures lower the
  // axis CONFIDENCE (exposure, recency, completeness), never the score itself. If one swimmer
  // scores at least as high as another on every measure both have within an axis, and both have
  // the same measures, the axis score cannot be lower.
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
    // Wf: evidence exposure of the metric. Reported for confidence only; not a score weight.
    const Wf = frequencyWeight(exposureByMetric.get(record.metric) || 0, axis.exposureTarget);
    const Wsignal = Math.max(0, Math.min(1, Number(record.signal)));
    const Wrec = Wr * (Number.isFinite(Wsignal) ? Wsignal : 0);
    // W: the record's within-metric-and-source weight (recency × signal), used only inside its own group.
    return { ...record, weights: { Wm, Ws, Wr, Wf, Wsignal, W: Wm > 0 && Ws > 0 ? Wrec : 0 } };
  });
  const contributing = weighted.filter((record) => record.weights.W > 0 && Number.isFinite(Number(record.score)));
  const weightedMean = (rows, weightOf, valueOf) => {
    const w = rows.reduce((sum, row) => sum + weightOf(row), 0);
    return w > 0 ? rows.reduce((sum, row) => sum + valueOf(row) * weightOf(row), 0) / w : null;
  };
  const metricSummaries = metricNames.map((metric) => {
    const metricRecords = contributing.filter((record) => record.metric === metric);
    if (!metricRecords.length) return null;
    const sourceScores = [...new Set(metricRecords.map((record) => record.source))].map((source) => {
      const rows = metricRecords.filter((record) => record.source === source);
      return { source, score: atLeastZero(weightedMean(rows, (r) => r.weights.W, (r) => Number(r.score))),
        weight: resolveSourceWeight(source, phaseContext), evidenceCount: rows.length };
    });
    const score = weightedMean(sourceScores, (row) => row.weight, (row) => row.score);
    if (!Number.isFinite(score)) return null;
    return {
      metric,
      score: atLeastZero(score),
      officialWeight: axis.metrics[metric] || 0,
      frequency: metricRecords[0].weights.Wf,
      effectiveWeight: axis.metrics[metric] || 0,
      evidenceCount: metricRecords.length,
      sourceScores,
    };
  }).filter(Boolean);

  if (!metricSummaries.length) {
    return buildNotScoredAxis(axis, 'No valid weighted metric contribution remained after validation.');
  }
  if (axis.key === 'adaptability') {
    const comparisons = new Set(contributing.map((record) => `${record.source}|${record.evidenceId}`)).size;
    if (comparisons < ADAPTABILITY_MIN_COMPARISONS) {
      return { ...buildNotScoredAxis(axis, `${INSUFFICIENT_EVIDENCE}: Adaptability needs ≥ ${ADAPTABILITY_MIN_COMPARISONS} comparable longitudinal comparisons (${comparisons} recorded); the observation is listed, not scored.`),
        validation: INSUFFICIENT_EVIDENCE, observations: contributing.map((record) => ({ evidenceId: record.evidenceId, metric: record.metric, value: record.score, method: record.method })), trendRecords: axisTrends };
    }
  }

  const rawScore = weightedMean(metricSummaries, (row) => row.officialWeight, (row) => row.score);
  const availableMetricNames = metricSummaries.map((metric) => metric.metric);
  const omittedMetrics = metricNames.filter((metric) => !availableMetricNames.includes(metric));
  const completeness = clamp(
    availableMetricNames.reduce((sum, metric) => sum + (axis.metrics[metric] || 0), 0) * 100,
  );
  // Capability is calculated from the available valid measurements; missing measures are
  // excluded with their weights rescaled. Completeness, exposure and recency set confidence only.
  const score = rawScore === null ? null : atLeastZero(rawScore);
  const recencyCoverage = clamp(
    mean(axisRecords.map((record) => recencyWeight(record.date, calculationDate))) * 100,
  );
  // Exposure: how much of each measured metric's evidence target is met (Wf), weighted by Wm.
  const exposureCoverage = clamp(100 * (weightedMean(metricSummaries, (row) => row.officialWeight, (row) => row.frequency) ?? 0));
  const agreement = sourceAgreementScore(axisRecords);
  const confidence = combineConfidence({ completeness, exposure: exposureCoverage, recency: recencyCoverage, agreement });
  const evidenceIds = new Set(axisRecords.map((record) => String(record.evidenceId || '').trim()).filter(Boolean));

  return {
    key: axis.key,
    label: axis.label,
    score,
    confidence,
    validation: score === null ? 'Not Scored' : validationLabel(availableMetricNames.length, availableMetricNames.length + omittedMetrics.length),
    evidenceCount: evidenceIds.size || axisRecords.length,
    completeness,
    exposureCoverage,
    recencyCoverage,
    sourceAgreement: agreement,
    availableMetrics: availableMetricNames,
    omittedMetrics,
    reasons: score === null
      ? ['No valid weighted metric contribution remained after validation.']
      : [
        ...(omittedMetrics.length ? [`Not measured in this window: ${omittedMetrics.join(', ')}.`] : []),
        ...(contributing.some((record) => !APPROVED_CALIBRATION_METHODS.has(record.method)) ? [PROVISIONAL_CALIBRATION_NOTE] : []),
        ...(contributing.some((record) => record.estimated)
          ? [`ESTIMATED: ${contributing.filter((record) => record.estimated).length} of ${contributing.filter((record) => record.method === 'distance-per-cycle-at-own-maximum-vs-elite').length} stroke-counted swims were below 95 % of the swimmer's own best speed; their stroke length at maximum effort is estimated from the swimmer's speed–efficiency profile.`]
          : []),
      ],
    estimatedRecords: contributing.filter((record) => record.estimated).length,
    calibrationStatus: contributing.some((record) => !APPROVED_CALIBRATION_METHODS.has(record.method)) ? 'provisional' : 'approved',
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
  const efficiencyAdaptability = selectedSingleSwimmer
    ? buildEfficiencyAdaptabilityRecords({ canonicalTests, completedCompetitions, canonicalSets, swimmerId: selectedSwimmerId, swimmer,
      pushOffMetresPerWall: resolvePushOffAllowance(db),
      absentScheduleIds: new Set([...buildSwimmerScheduleDeliveryRatios(db, selectedSwimmerId).entries()]
        .filter(([, attendance]) => attendance?.attended === false).map(([scheduleId]) => scheduleId)) })
    : { records: [], efficiencyEvidence: null };
  const efficiencyReasons = efficiencyEvidenceReasons(efficiencyAdaptability.efficiencyEvidence);
  const unweightedRecords = selectedSingleSwimmer
    ? [
      ...buildTestMetricRecords({ canonicalTests, setById, swimmer }),
      ...buildCompetitionMetricRecords({ completedCompetitions, swimmer }),
      ...efficiencyAdaptability.records,
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

  // Speed level: the best timed swim on the single scale. DISPLAY ONLY (no multiplier, 16-11-2026).
  const speedLevel = swimmerSpeedLevel(unweightedRecords) || fallbackSpeedLevel || null;
  void requireSpeedLevel;
  // Evidence model: single home per derived measurement, relative speed as context, demo labelling.
  const homed = resolveSingleHome(unweightedRecords);
  const withContext = addRelativeSpeedContext(homed.records);
  const syntheticIds = selectedSingleSwimmer ? syntheticEvidenceIds(db, selectedSwimmerId) : new Set();
  const records = withContext.records.map((record) => (syntheticIds.has(record.evidenceId) ? { ...record, synthetic: true } : record));
  assertSingleHome(records);
  const phaseContext = resolvePhaseContext(scope);
  const calculationKey = dateKey(calculationDate) || new Date().toISOString().slice(0, 10);
  const efficiencyAnalysis = selectedSingleSwimmer
    ? buildEfficiencyAnalysis({ measurements: efficiencyAdaptability.indicatorMeasurements, syntheticIds, bests: withContext.bests, swimmer })
    : null;
  const adaptabilityInvestigations = selectedSingleSwimmer
    ? buildAdaptabilityInvestigations({ canonicalSets, swimmerId: selectedSwimmerId, efficiencyMeasurements: efficiencyAdaptability.indicatorMeasurements, syntheticIds })
    : null;
  const axes = selectedSingleSwimmer
    ? ATHLYRAX_AXIS_DEFINITIONS.map((axis) => {
      const scored = scoreAxis(axis, records, calculationKey, phaseContext);
      const synthetic = asArray(scored.metricRecords).some((record) => record.synthetic);
      const labelled = synthetic ? { ...scored, demonstrationData: true, reasons: [...asArray(scored.reasons), 'Includes demonstration (synthetic) measurements: shows the software working, not scientific evidence.'] } : scored;
      return axis.key === 'efficiency'
        ? { ...labelled, reasons: [...efficiencyReasons, ...asArray(labelled.reasons)], efficiencyEvidence: efficiencyAdaptability.efficiencyEvidence, efficiencyAnalysis }
        : axis.key === 'adaptability' ? { ...labelled, investigations: adaptabilityInvestigations } : labelled;
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
    evidenceModel: EVIDENCE_MODEL_VERSION,
    // Same-event bests behind relative speed (context only), and every record removed by the single-home rule.
    sameEventBests: withContext.bests,
    excludedMeasurements: homed.excluded.map((r) => ({ axis: r.axis, metric: r.metric, method: r.method, source: r.source, evidenceId: r.evidenceId, reason: r.excludedReason })),
    efficiencyAnalysis,
    adaptabilityInvestigations,
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
