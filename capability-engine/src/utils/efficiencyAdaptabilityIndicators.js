// Efficiency (D-6) and Adaptability (D-7) measured indicators.
//
// Efficiency: speed, distance per stroke cycle (DPC) and Stroke Index
// (SI = speed × DPC) are calculated automatically wherever a time and a stroke
// count or cycle count were recorded: Tests, Competition and any Training
// repetition. No target stroke count is used or needed. Without a validated
// reference the 0–100 score is computed in the engine against the elite Stroke
// Index table; values and their within-swimmer change are reported here.
//
// Adaptability: the performance response when the demand changes.
//   - Retest response: the same test protocol repeated on a later date.
//   - Recovery response: the same set type (distance, stroke, energy system)
//     swum on a different send-off; the response is the change in pace and
//     in actual rest (= send-off − actual swimming time, both recorded). Repeatability within one set is NOT
//     adaptability and is not used here.
// The engine scores these responses: 50 = no change, 10 points per 0.4 %.
import { calculatedStrokeMetrics } from './swimmingStrokeMetrics.js';
import { parseRecordedSwimSeconds } from './recordedSetAverages.js';
import { resolveCompetitionCourseKey, isYardCourseKey } from './competitionCourse.js';
import { PUSH_OFF_ALLOWANCE_METRES_PER_WALL, efficiencyCourse } from '../data/efficiencyReference.js';

const asArray = (value) => (Array.isArray(value) ? value : []);
const text = (value) => String(value ?? '').trim();
const day = (value) => text(value).slice(0, 10);
const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);
const pct = (from, to) => (Number.isFinite(from) && from > 0 && Number.isFinite(to) ? 100 * (to / from - 1) : null);
const seconds = (value) => {
  const parsed = parseRecordedSwimSeconds(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const sendOffSeconds = (value) => {
  const raw = text(value);
  if (!raw) return null;
  const parts = raw.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const total = parts.reduce((sum, n) => sum * 60 + n, 0);
  return total > 0 ? total : null;
};

// One stroke-measured swim: speed, DPC and SI (pool-distance proxy unless an
// underwater distance was recorded, as in the result forms).
// Physically possible distance per stroke cycle, measured as pool distance
// (incl. dive / push-off) ÷ cycles. Elite swimmers reach about 2.5 m of surface
// stroke; the push-off weighs more on short swims, so the upper bound is
// 5.5 m (25 m), 4.5 m (50 m) and 3.5 m (100 m and longer). A count outside it
// was not recorded for the whole swim (e.g. a per-length count): such swims
// are excluded and listed, never scored.
export const PLAUSIBLE_DPC_RANGE = Object.freeze({ min: 0.8, max: 3.5 });
export const maxPlausibleDistancePerCycle = (distance) => (Number(distance) <= 25 ? 5.5 : Number(distance) <= 50 ? 4.5 : PLAUSIBLE_DPC_RANGE.max);
export const isPlausibleDistancePerCycle = (dpc, distance) => Number.isFinite(dpc)
  && dpc >= PLAUSIBLE_DPC_RANGE.min && dpc <= maxPlausibleDistancePerCycle(distance);
let implausibleSink = null;
// Push-off allowance (metres per wall) used while building; see src/data/efficiencyReference.js.
let pushOffAllowance = PUSH_OFF_ALLOWANCE_METRES_PER_WALL;
function strokeMeasurement({ time, strokeCount, strokeCycles, distance, stroke, unit = 'm', underwaterDistance, poolLength = 25 }) {
  // No recorded underwater distance: the push-off allowance per wall (start
  // and each turn), in the pool's unit, labelled as an estimate.
  const recordedUnderwater = underwaterDistance !== undefined && underwaterDistance !== null && String(underwaterDistance).trim() !== '';
  const walls = Math.max(1, Math.round((Number(distance) || 0) / (Number(poolLength) || 25)));
  const estimatedUnderwater = recordedUnderwater ? null : walls * pushOffAllowance / (unit === 'yd' ? 0.9144 : 1);
  const metrics = calculatedStrokeMetrics({ stroke, strokeCount, strokeCycles, time, distance, unit,
    underwaterDistance: recordedUnderwater ? underwaterDistance : estimatedUnderwater });
  if (!(metrics.speed > 0) || !(metrics.strokeLength > 0)) return null;
  if (!isPlausibleDistancePerCycle(metrics.strokeLength, distance)) {
    implausibleSink?.push({ distance: Number(distance), stroke, dpc: metrics.strokeLength, cycles: metrics.strokeCycles });
    return null;
  }
  return { speed: metrics.speed, dpc: metrics.strokeLength, si: metrics.speed * metrics.strokeLength, cycles: metrics.strokeCycles,
    poolProxy: Boolean(metrics.strokeLengthIsPoolProxy), pushOffEstimated: !recordedUnderwater && estimatedUnderwater > 0 };
}

function averageMeasurements(rows) {
  const valid = rows.filter(Boolean);
  if (!valid.length) return null;
  return { speed: mean(valid.map((r) => r.speed)), dpc: mean(valid.map((r) => r.dpc)), si: mean(valid.map((r) => r.si)),
    cycles: mean(valid.map((r) => r.cycles).filter(Number.isFinite)), poolProxy: valid.some((r) => r.poolProxy),
    pushOffEstimated: valid.some((r) => r.pushOffEstimated), repetitions: valid.length };
}

const repTime = (rep) => rep?.overallTime ?? rep?.time ?? rep?.resultTime;
// Underwater distance only when recorded (coach entry or a wearable), never
// assumed: the swim total, else the per-length values summed, else the
// per-wall breakout distance times the walls (start + turns) of the swim.
const recorded = (value) => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
export function recordedUnderwaterMetres(rep, distance, poolLength) {
  if (recorded(rep?.underwaterDistance)) return Number(rep.underwaterDistance);
  const lengths = [...asArray(rep?.lengths), ...asArray(rep?.splits)].filter((row) => recorded(row?.underwaterDistance));
  if (lengths.length) return lengths.reduce((sum, row) => sum + Number(row.underwaterDistance), 0);
  const pool = Number(poolLength);
  if (recorded(rep?.breakoutDistance) && pool > 0 && Number(distance) > 0) return Number(rep.breakoutDistance) * Math.max(1, Math.round(Number(distance) / pool));
  return undefined;
}
// Yard pools: distances and underwater are in yards (converted to metres).
const unitOf = (row) => (/y/i.test(String(row?.course ?? row?.poolLength ?? row?.courseUnit ?? '')) ? 'yd' : 'm');
// Pool length from a recorded length, else the course (LC = 50; SC / yards = 25).
const poolLengthOf = (row) => {
  const n = Number(String(row?.poolLength ?? '').replace(/[^\d.]/g, ''));
  if (n > 0) return n;
  const course = String(row?.course ?? '').trim().toLowerCase();
  const digits = Number(course.replace(/[^\d.]/g, ''));
  return digits > 0 ? digits : /^(lc|lcm|long)/.test(course) ? 50 : 25;
};
const repStrokes = (rep) => (rep?.strokeCountUnit === 'cycles' ? '' : (rep?.overallStrokeCount ?? rep?.strokeCount));
const repCycles = (rep) => rep?.strokeCycles ?? (rep?.strokeCountUnit === 'cycles' ? (rep?.overallStrokeCount ?? rep?.strokeCount) : '');

function testEfficiencyRows(tests) {
  return asArray(tests).map((test) => {
    const distance = Number(test?.distance) || 0;
    const stroke = text(test?.stroke) || 'Free';
    const reps = asArray(test?.repResults);
    const measured = averageMeasurements(reps.map((rep) => strokeMeasurement({ time: repTime(rep), strokeCount: repStrokes(rep),
      strokeCycles: repCycles(rep), distance, stroke, unit: unitOf(test), poolLength: poolLengthOf(test), underwaterDistance: recordedUnderwaterMetres(rep, distance, poolLengthOf(test)) })));
    if (!measured || !(distance > 0)) return null;
    const label = text(test?.testName || test?.testType) || `${distance} m ${stroke}`;
    return { source: 'test', id: text(test?.id), date: day(test?.date), label, key: `test|${label}|${distance}|${stroke.toLowerCase()}`,
      distance, stroke, unit: unitOf(test), poolLength: poolLengthOf(test), course: efficiencyCourse({ unit: unitOf(test), poolLength: poolLengthOf(test) }),
      ...measured, verified: (test?.strokeMeasurementVerified ?? test?.raw?.strokeMeasurementVerified) === true,
      verifyTarget: { kind: 'test', testId: text(test?.raw?.id || test?.id) } };
  }).filter(Boolean);
}

// A race result records the start breakout only: the turns take the push-off
// allowance (labelled), unless per-length underwater distances were recorded.
function raceUnderwater(result, distance, course) {
  const perLength = asArray(result?.splits).filter((row) => recorded(row?.underwaterDistance));
  if (perLength.length) return perLength.reduce((total, row) => total + Number(row.underwaterDistance), 0);
  if (!recorded(result?.breakoutDistance)) return undefined;
  const pool = course === '50' ? 50 : 25;
  const turns = Math.max(0, Math.round((Number(distance) || 0) / pool) - 1);
  return Number(result.breakoutDistance) + turns * pushOffAllowance / (isYardCourseKey(course) ? 0.9144 : 1);
}

function competitionEfficiencyRows(competitions) {
  return asArray(competitions).map((race) => {
    const result = race?.raw?.result || race?.raw || {};
    const fixture = race?.raw?.fixture || null;
    const eventItem = race?.raw?.eventItem || null;
    const course = resolveCompetitionCourseKey({ fixture, eventItem, legacyRow: fixture || eventItem ? null : race?.raw });
    const distance = Number(race?.distance || result?.distance) || 0;
    const stroke = text(race?.stroke || result?.stroke);
    const measured = strokeMeasurement({ time: result?.totalTime || result?.officialTime || result?.time || race?.resultValue,
      strokeCount: result?.overallStrokeCount ?? result?.strokeCount, strokeCycles: result?.strokeCycles,
      distance, stroke, unit: isYardCourseKey(course) ? 'yd' : 'm', poolLength: course === '50' ? 50 : 25, underwaterDistance: raceUnderwater(result, distance, course) });
    if (!measured || !(distance > 0)) return null;
    const unit = isYardCourseKey(course) ? 'yd' : 'm';
    return { source: 'competition', id: text(race?.id), date: day(race?.date), label: `${distance} ${unit} ${stroke}${course ? ` (${course === '25y' ? 'SCY' : course === '25' ? 'SC' : 'LC'})` : ''}`,
      key: `competition|${distance}|${stroke.toLowerCase()}|${course}`, distance, stroke, unit, poolLength: course === '50' ? 50 : 25,
      course: efficiencyCourse({ unit, poolLength: course === '50' ? 50 : 25 }), ...measured, repetitions: 1,
      verified: (result?.strokeMeasurementVerified ?? race?.raw?.strokeMeasurementVerified) === true,
      verifyTarget: { kind: 'competition', fixtureId: text(race?.fixtureId || fixture?.id), eventId: text(race?.eventId || eventItem?.id) } };
  }).filter(Boolean);
}

// Attended training sets with the selected swimmer's recorded repetitions.
function attendedTrainingSets(sets, deliveryBySchedule) {
  return asArray(sets).filter((set) => {
    const attendance = deliveryBySchedule?.get?.(text(set?.scheduleId || set?.trainingScheduleId));
    return attendance?.attended !== false && asArray(set?.__ispSwimmerResult?.reps).length > 0;
  });
}
const setSignature = (set) => `${Number(set?.distance) || 0}|${text(set?.stroke).toLowerCase()}|${text(set?.energy || set?.energySystem).toUpperCase()}`;
const setLabel = (set) => `${Number(set?.distance) || 0} m ${text(set?.stroke) || ''} ${text(set?.energy || set?.energySystem).toUpperCase()}`.replace(/\s+/g, ' ').trim();

function trainingEfficiencyRows(sets) {
  return sets.map((set) => {
    const distance = Number(set?.distance) || 0;
    const stroke = text(set?.stroke) || 'Free';
    const measured = averageMeasurements(asArray(set.__ispSwimmerResult.reps).map((rep) => strokeMeasurement({ time: repTime(rep),
      strokeCount: repStrokes(rep), strokeCycles: repCycles(rep), distance, stroke, unit: unitOf(set), poolLength: poolLengthOf(set), underwaterDistance: recordedUnderwaterMetres(rep, distance, poolLengthOf(set)) })));
    if (!measured || !(distance > 0)) return null;
    return { source: 'training', id: text(set?.id), date: day(set?.scheduleDate || set?.date), label: setLabel(set), key: `training|${setSignature(set)}`,
      distance, stroke, unit: unitOf(set), poolLength: poolLengthOf(set), course: efficiencyCourse({ unit: unitOf(set), poolLength: poolLengthOf(set) }),
      ...measured, verified: set?.__ispSwimmerResult?.strokeMeasurementVerified === true, verifyTarget: { kind: 'training', setId: text(set?.id) } };
  }).filter(Boolean);
}

// Earliest vs latest measurement of the same protocol inside the window.
function changesByKey(rows, valueKeys) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.key)) groups.set(row.key, []);
    groups.get(row.key).push(row);
  }
  const out = [];
  for (const list of groups.values()) {
    const ordered = list.slice().sort((a, b) => a.date.localeCompare(b.date));
    const first = ordered[0];
    const latest = ordered[ordered.length - 1];
    if (!first || !latest || first.date === latest.date) continue;
    const change = Object.fromEntries(valueKeys.map((k) => [`${k}ChangePct`, pct(first[k], latest[k])]));
    out.push({ source: first.source, label: first.label, key: first.key, first, latest, measurements: ordered.length, ...change });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.label.localeCompare(b.label));
}

function testPerformanceRows(tests) {
  return asArray(tests).map((test) => {
    const times = asArray(test?.repResults).map((rep) => seconds(repTime(rep))).filter(Boolean);
    const single = seconds(test?.resultValue);
    const values = times.length ? times : (single ? [single] : []);
    if (!values.length) return null;
    const label = text(test?.testName || test?.testType) || `${test?.distance} m`;
    return { source: 'test', id: text(test?.id), date: day(test?.date), label, key: `test|${label}|${Number(test?.distance) || 0}|${text(test?.stroke).toLowerCase()}`,
      seconds: mean(values), repetitions: values.length };
  }).filter(Boolean);
}

function recoveryResponses(sets) {
  const sessions = sets.map((set) => {
    const sendOff = sendOffSeconds(set?.sendOff);
    if (!sendOff) return null;
    const times = asArray(set.__ispSwimmerResult.reps).map((rep) => seconds(repTime(rep))).filter(Boolean);
    const rests = times.map((t) => sendOff - t);
    // Actual rest only where both are recorded and the send-off was achievable.
    if (times.length < 2 || rests.some((r) => r < 0)) return null;
    return { id: text(set?.id), date: day(set?.scheduleDate || set?.date), key: setSignature(set), label: setLabel(set),
      sendOff, meanPace: mean(times), meanRest: mean(rests), repetitions: times.length };
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
  const byKey = new Map();
  for (const row of sessions) {
    if (!byKey.has(row.key)) byKey.set(row.key, []);
    byKey.get(row.key).push(row);
  }
  const responses = [];
  for (const list of byKey.values()) {
    for (let i = 1; i < list.length; i += 1) {
      const from = list[i - 1];
      const to = list[i];
      // The demand change is the prescribed send-off. Actual rest also moves
      // when the swimmer swims slower, so it is the response, not the trigger.
      if (to.sendOff === from.sendOff) continue;
      responses.push({ label: to.label, key: to.key, from, to, sendOffChangeSeconds: to.sendOff - from.sendOff,
        restChangeSeconds: to.meanRest - from.meanRest, paceChangePct: pct(from.meanPace, to.meanPace) });
    }
  }
  return { sessions, responses };
}

// Latest recorded arm span (cm) from the swimmer's physical measurements, or null.
export function latestArmSpanCm(swimmer) {
  const rows = [...asArray(swimmer?.physicalMeasurements), ...asArray(swimmer?.isp?.physicalMeasurements)]
    .filter((row) => Number(row?.armSpanCm) >= 100 && Number(row?.armSpanCm) <= 250)
    .sort((a, b) => text(a?.date).localeCompare(text(b?.date)));
  return rows.length ? Number(rows[rows.length - 1].armSpanCm) : null;
}

export function buildEfficiencyAdaptabilityIndicators({ tests = [], competitions = [], sets = [], deliveryBySchedule = null,
  startDate = '', endDate = '', asOfDate = '', pushOffMetresPerWall = PUSH_OFF_ALLOWANCE_METRES_PER_WALL,
  eliteReference = null, armSpanCm = null } = {}) {
  const last = [endDate, asOfDate].filter(Boolean).sort()[0] || '';
  const inWindow = (row) => (!startDate || row.date >= startDate) && (!last || row.date <= last);
  const trainingSets = attendedTrainingSets(sets, deliveryBySchedule)
    .filter((set) => inWindow({ date: day(set?.scheduleDate || set?.date) }));
  const implausible = { test: [], competition: [], training: [] };
  const collect = (source, build) => {
    implausibleSink = implausible[source]; pushOffAllowance = pushOffMetresPerWall;
    try { return build(); } finally { implausibleSink = null; pushOffAllowance = PUSH_OFF_ALLOWANCE_METRES_PER_WALL; }
  };
  const efficiencyMeasurements = [
    ...collect('test', () => testEfficiencyRows(tests)), ...collect('competition', () => competitionEfficiencyRows(competitions)),
    ...collect('training', () => trainingEfficiencyRows(trainingSets)),
  ].filter(inWindow).sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source))
    .map((row) => {
      // % of the elite reference Stroke Index, kept uncapped (a reference is not a ceiling).
      const elite = row.course && typeof eliteReference === 'function' ? eliteReference(row) : null;
      const pctOfElite = elite > 0 ? (row.si / elite) * 100 : null;
      // Relative stroke length (DPC ÷ arm span): descriptive only, no reference or score.
      const relativeStrokeLength = armSpanCm > 0 ? row.dpc / (armSpanCm / 100) : null;
      return { ...row, eliteSi: elite > 0 ? elite : null, pctOfElite, aboveReference: pctOfElite > 100, relativeStrokeLength };
    });
  const retests = changesByKey(testPerformanceRows(tests).filter(inWindow), ['seconds'])
    .map((row) => ({ ...row, timeChangePct: row.secondsChangePct }));
  const recovery = recoveryResponses(trainingSets);
  return {
    efficiency: {
      measurements: efficiencyMeasurements,
      changes: changesByKey(efficiencyMeasurements, ['si', 'speed', 'dpc', 'cycles']),
      armSpanCm: armSpanCm > 0 ? armSpanCm : null,
      // Swims (repetitions) left out because the stroke count is implausible for the whole swim.
      excludedImplausible: Object.fromEntries(Object.entries(implausible).map(([source, rows]) => [source, rows.length])),
      // Swims with no recorded underwater distance: push-off allowance per wall (src/data/efficiencyReference.js).
      pushOffMetresPerWall,
      pushOffEstimatedCount: efficiencyMeasurements.filter((row) => row.pushOffEstimated).length,
      score: null,
      scoreNote: 'Efficiency score (Capability, Competition, Integrated) = Stroke Index ÷ elite Stroke Index × 100; elite speed from the world-class reference, elite stroke rate from a provisional table pending owner confirmation. Scored only from at least 2 stroke-counted swims; a measurement above the elite reference counts only after coach verification and is then shown at its full % of the reference. Stroke Index is a stroke-economy indicator (speed × distance per cycle), not propelling efficiency. Below: each swimmer\'s own values and change.',
    },
    adaptability: {
      retests,
      recoverySessions: recovery.sessions,
      recoveryResponses: recovery.responses,
      score: null,
      scoreNote: 'Adaptability score = 50 when performance does not change; +10 points per 0.4 % faster (the smallest worthwhile change, Pyne et al. 2004), −10 per 0.4 % slower; from repeated tests, the same set on a tighter send-off, and the same race event.',
    },
  };
}
