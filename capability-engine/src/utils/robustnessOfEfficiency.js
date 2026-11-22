// Robustness of Efficiency v3 — one measurement for tests, training and races (owner code review 21-11-2026).
//
// WHAT IS MEASURED
// Retention of stroke length (distance per stroke cycle, DPC) within one effort, at comparable pace:
//   loss % = 100 × (1 − DPC_late ÷ DPC_early) = 100 × (1 − cycles_early ÷ cycles_late)
// over ordered units of equal stroked distance (repetitions of one set or repeated test; lengths of one race after the
// dive length, splits equal to the pool length). Early = first third, late = last third of the units (≥ 1 unit each).
// Push-off and turn allowances are identical in every unit of one set or race, so they cancel in the ratio.
//
// PACE (validity, not scoring) — revised after owner review 21-11-2026 (item 2)
// speed = stroke length × stroke frequency, so  Δln(speed) = Δln(SL) + Δln(SF). Three cases:
//  * late units at the same pace: a shorter stroke (with a higher rate) is a loss of efficiency → measured;
//  * late units SLOWER (pace fade, the usual fatigue pattern): at a lower speed a swimmer who is not fatigued keeps or
//    lengthens the stroke, so the raw early-to-late loss is a LOWER BOUND of the fatigue-related loss → measured, and
//    marked lossIsLowerBound. Slowing with an unchanged stroke length gives zero loss: slower swimming alone never
//    lowers Robustness (that is Durability). Slowing WITH a shorter stroke lowers both, because both happened;
//  * late units FASTER (descending set, finishing sprint): a faster swimmer shortens the stroke even without fatigue,
//    so the loss cannot be attributed → not comparable, reported, never scored.
// A speed-up is tolerated up to ROBUSTNESS_SPEEDUP_TOLERANCE_PCT = 0.4 % (timing noise of steady repetitions). The
// value is justified by the bias it can introduce, not borrowed: the stroke-length change caused by a speed-up Δ is
// e·Δ, with e = d ln SL / d ln speed between 0 and −1 (SL roughly constant at sub-maximal speeds, falling near maximal
// speed; Craig & Pendergast 1979). At 0.4 % the bias is at most 0.4 percentage points (0.1 at e = −0.25, the demo
// model), below the 1.0-point precision required of a scored context. e is NOT validated on measured AthlyraX data.
// The previous two-sided 0.4 % rule (the Adaptability smallest worthwhile change) discarded every fading effort,
// i.e. most genuine fatigue evidence; that rule is withdrawn.
// DEMAND CONTEXT (canonical, never invented)
// Each item keeps the canonical energy code of the set (canonicalTrainingEnergyAuthority.js: EN1, EN2, EN3, LP, LT,
// SP = speed / ATP-PC) — for tests the protocol's code (testTemplateCatalog.js), for races the context 'RACE'. A
// missing or unrecognised code stays 'Unclassified': it is measured and reported but not scored, because its demand is
// unknown. Recovery: work fraction = swimming time ÷ send-off (0–1) is kept with the item and used as its signal
// weight; unknown recovery keeps the neutral weight 0.5 used by the Training demand engine. Energy system describes the
// stimulus; it never raises or lowers the score by itself.
//
// VALID MEASUREMENTS AND EVIDENCE ORIGIN (existing provenance fields, nothing invented)
// A unit needs a recorded stroke count and time; cycles need a known stroke family (freestyle/backstroke 2 arm strokes
// per cycle, breaststroke/butterfly 1; medley, choice, drill and kick are undefined). Origin of a count, from the
// provenance fields already written by AthlyraX (measurementSource, strokeCountSource, strokeCycleSource,
// resultSource):
//  * 'synthetic'     — labelled synthetic (the demonstration dataset, e.g. measurementSource 'synthetic-demo'). Used,
//                      so the demo shows all eight axes, but every result built on it is labelled a SYNTHETIC
//                      DEMONSTRATION of the calculation: never validation of a swimmer's capability;
//  * 'model-derived' — produced by a model but not labelled synthetic (an estimate presented among real records):
//                      not a measurement of stroke length, excluded;
//  * 'measured'      — everything else (coach-entered, device, imported).
// PRECISION AND SCORING (provisional — see SPECIFICATION GAPS)
// Items are pooled per demand context (energy code / RACE) with the engine's evidence weights; the pooled signed loss
// has standard error SE = max(empirical weighted SE, stroke-count quantisation SE), quantisation SD of one item =
// 100 × √(2/12) ÷ cycles in its smaller window. A context is scored when it has ≥ 2 items (the minimum to estimate a
// spread) and SE ≤ ROBUSTNESS_MAX_SE_PCT. Context scores are combined with the locked core formula at context level
// (weight = the context's summed evidence weight). Missing contexts are reported as coverage gaps, never as zero.
//
// SPECIFICATION GAPS (not invented here — owner to specify)
//  - S6: the stability curve that converts % loss to 0–100 is unapproved; scores are provisional.
//  - S5: the signal/noise rule ("noise dominant", ratio R) is missing; ROBUSTNESS_MAX_SE_PCT = 1.0 is a provisional
//    placeholder for it (≈ 5 points of the S6 curve).
//  - No rule states which demand contexts must be covered, or how many weeks (S12), for Robustness to be "sufficient".
import { SWIMMING_CV_STABILITY_ANCHORS } from './olympicCapabilityCalibration.js';
import { resolveCanonicalTrainingEnergy } from './canonicalTrainingEnergyAuthority.js';
import { efficiencyStrokeFamily } from '../data/efficiencyReference.js';

export const ROBUSTNESS_METHOD = 'dpc-retention-early-late-v3.1';
export const ROBUSTNESS_MIN_REPETITIONS = 4;
export const ROBUSTNESS_MIN_RACE_LENGTHS = 3;
export const ROBUSTNESS_UNKNOWN_RECOVERY_WEIGHT = 0.5;
export const ROBUSTNESS_SPEEDUP_TOLERANCE_PCT = 0.4; // bias-bounded (see PACE); not the Adaptability rule
export const ROBUSTNESS_METHOD_VERSION = 'v3.1';
export const ROBUSTNESS_MAX_SE_PCT = 1.0;          // PROVISIONAL placeholder for the missing S5 rule
export const ROBUSTNESS_MIN_CONTEXT_ITEMS = 2;
export const ROBUSTNESS_RACE_CONTEXT = 'RACE';

const finite = (v) => Number.isFinite(v);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => sum(a) / a.length;

/** Arm strokes per stroke cycle by canonical stroke family; null when undefined (medley, choice, drill, kick, unknown). */
export function strokesPerCycle(stroke) {
  const raw = String(stroke ?? '').trim();
  if (!raw) return null;
  const t = raw.toLowerCase();
  const family = efficiencyStrokeFamily(t) || ({ fr: 'free', fs: 'free', bk: 'back', ba: 'back', br: 'breast', fl: 'fly', bf: 'fly' }[t] || null);
  if (!family) return null;
  return family === 'breast' || family === 'fly' ? 1 : 2;
}

/** Cycles from a recorded count: counts already in cycles stay; arm strokes are divided by strokes per cycle. */
export function cyclesFromCount(count, { unit = 'strokes', stroke } = {}) {
  const n = Number(count);
  if (!finite(n) || n <= 0) return null;
  if (String(unit || '').toLowerCase().startsWith('cycle')) return n;
  const spc = strokesPerCycle(stroke);
  if (spc) return n / spc;
  // Stroke not recorded: the early/late ratio of arm strokes is still the stroke-length ratio; for PRECISION only,
  // 2 arm strokes per cycle is assumed (fewer cycles = wider uncertainty, never narrower).
  return isStrokeUnrecorded(stroke) ? n / 2 : null;
}
/** A stroke that changes within or between repetitions (medley, choice), or has no arm strokes (kick), or drills. */
const MIXED_OR_NON_ARM = /medley|\bim\b|choice|mixed|kick|drill/i;
export const isStrokeUnrecorded = (stroke) => !String(stroke ?? '').trim();
export const strokeUndefinedForRetention = (stroke) => MIXED_OR_NON_ARM.test(String(stroke ?? '')) || (!isStrokeUnrecorded(stroke) && strokesPerCycle(stroke) === null);

/** Origin of a recorded stroke count: 'synthetic' | 'model-derived' | 'measured' (see VALID MEASUREMENTS). */
export function strokeCountOrigin(row) {
  const t = `${row?.measurementSource || ''} ${row?.strokeCountSource || ''} ${row?.strokeCycleSource || ''} ${row?.resultSource || ''}`;
  if (/synthetic/i.test(t)) return 'synthetic';
  if (/model|regenerat/i.test(t)) return 'model-derived';
  return 'measured';
}
/** True when a count was generated by a model without a synthetic label (excluded). */
export const isModelledStrokeCount = (row) => strokeCountOrigin(row) === 'model-derived';
const unitOrigin = (u) => u?.origin || (u?.modelled ? 'model-derived' : 'measured');
/** Origin of a set of items: 'measured', 'synthetic' or 'mixed'. */
export function combinedOrigin(origins) {
  const set = new Set((origins || []).filter(Boolean));
  if (!set.size) return null;
  return set.size === 1 ? [...set][0] : 'mixed';
}
export const SYNTHETIC_VALIDATION_NOTE = 'Synthetic demonstration: calculated from generated swimming data; not validated by measured swimming results.';

/** Work fraction of a repeated set: mean swimming time ÷ send-off, in [0, 1]; null when the send-off is unknown. */
export function workFraction(times, sendOffSecondsValue) {
  const t = (times || []).filter((x) => finite(x) && x > 0);
  const s = Number(sendOffSecondsValue);
  if (!t.length || !finite(s) || s <= 0) return null;
  return Math.max(0, Math.min(1, mean(t) / s));
}

/** Parse "1:15" / "75" / 75 into seconds. */
export function sendOffSeconds(value) {
  if (finite(Number(value)) && Number(value) > 0) return Number(value);
  const s = String(value ?? '').trim();
  if (!/^\d+(:\d{1,2}(\.\d+)?)?$/.test(s)) return null;
  const v = s.split(':').reduce((m, x) => m * 60 + Number(x), 0);
  return v > 0 ? v : null;
}

/** Early-to-late change in distance per cycle over ordered units of equal stroked distance. */
export function strokeLengthRetention(cycles, { minUnits = ROBUSTNESS_MIN_REPETITIONS } = {}) {
  const c = (cycles || []).map(Number);
  if (c.length < minUnits || c.some((x) => !finite(x) || x <= 0)) return null;
  const window = Math.max(1, Math.floor(c.length / 3));
  const earlyCycles = sum(c.slice(0, window)); const lateCycles = sum(c.slice(-window));
  const lossPct = 100 * (1 - earlyCycles / lateCycles);
  const quantSdPct = 100 * Math.sqrt(2 / 12) / Math.min(earlyCycles, lateCycles);
  return { lossPct, quantSdPct, earlyCycles, lateCycles, units: c.length, window };
}

/**
 * Assess one effort (a set or repeated test of one swimmer, or one race) as Robustness evidence.
 * units: [{ count, unit, seconds, origin }] in order. Returns the measurement and its demand context, or the reason
 * it cannot be used.
 */
export function assessRetentionEvidence({ source, energy = '', stroke, units = [], sendOff = null, minUnits = ROBUSTNESS_MIN_REPETITIONS }) {
  const context = source === 'competition' ? ROBUSTNESS_RACE_CONTEXT : resolveCanonicalTrainingEnergy({ energy }).energySystem;
  const base = { source, context, units: units.length };
  if (units.length < minUnits) return { ...base, eligible: false, reason: `fewer than ${minUnits} comparable units` };
  if (units.some((u) => unitOrigin(u) === 'model-derived')) return { ...base, eligible: false, reason: 'stroke counts are model-generated (not a measurement of stroke length)' };
  const origin = units.some((u) => unitOrigin(u) === 'synthetic') ? 'synthetic' : 'measured';
  base.origin = origin;
  const cycles = units.map((u) => cyclesFromCount(u.count, { unit: u.unit, stroke }));
  if (strokeUndefinedForRetention(stroke)) return { ...base, eligible: false, reason: 'stroke length undefined for this stroke (medley, choice, drill or kick)' };
  if (cycles.some((c) => c === null)) return { ...base, eligible: false, reason: 'a unit has no stroke count' };
  const seconds = units.map((u) => Number(u.seconds));
  if (seconds.some((s) => !finite(s) || s <= 0)) return { ...base, eligible: false, reason: 'a unit has no time: pace comparability cannot be established' };
  const retention = strokeLengthRetention(cycles, { minUnits });
  const k = retention.window;
  const earlyT = sum(seconds.slice(0, k)); const lateT = sum(seconds.slice(-k));
  const paceChangePct = 100 * (lateT / earlyT - 1); // + = late units slower
  // Decomposition (per unit of equal distance): speed ∝ 1/time, SL ∝ 1/cycles, SF = cycles/time.
  const strokeRateChangePct = 100 * ((retention.lateCycles / lateT) / (retention.earlyCycles / earlyT) - 1);
  const fraction = source === 'competition' ? 1 : workFraction(seconds, sendOff);
  const paceFaded = paceChangePct > ROBUSTNESS_SPEEDUP_TOLERANCE_PCT;
  const measured = { ...base, ...retention, paceChangePct, strokeRateChangePct, paceFaded, lossIsLowerBound: paceFaded,
    workFraction: fraction, meanUnitSeconds: mean(seconds), unclassified: context === 'Unclassified',
    strokeAssumedForPrecision: isStrokeUnrecorded(stroke) && !units.every((u) => String(u.unit || '').toLowerCase().startsWith('cycle')) };
  if (paceChangePct < -ROBUSTNESS_SPEEDUP_TOLERANCE_PCT) {
    return { ...measured, eligible: false, reason: `late units ${Math.abs(paceChangePct).toFixed(2)} % faster than early units (> ${ROBUSTNESS_SPEEDUP_TOLERANCE_PCT} %): the stroke shortens with speed alone, loss not attributable` };
  }
  return { ...measured, eligible: true, reason: null };
}

/** The AthlyraX stability curve (S6, unapproved) applied to a loss in %. Same anchors as calibratedStabilityScore. */
export function robustnessScoreFromLoss(lossPct) {
  const value = Math.max(0, Number(lossPct));
  if (!finite(value)) return null;
  const A = SWIMMING_CV_STABILITY_ANCHORS;
  if (value <= A[0][0]) return A[0][1];
  for (let i = 1; i < A.length; i += 1) {
    const [x1, y1] = A[i]; const [x0, y0] = A[i - 1];
    if (value <= x1) return y0 + (y1 - y0) * ((value - x0) / Math.max(0.0001, x1 - x0));
  }
  return A[A.length - 1][1];
}

/** Race lengths usable for Robustness: per-length counts and times whose split length equals the pool length, dive removed. */
export function raceLengthUnits(result, { poolLength }) {
  const pool = Number(poolLength);
  if (!(pool > 0)) return null;
  const toSeconds = (v) => { const s = String(v ?? '').trim(); return s.includes(':') ? s.split(':').reduce((m, x) => m * 60 + Number(x), 0) : Number(s); };
  const candidates = [];
  for (const [key, rows] of Object.entries(result?.splitRecordsByLength || {})) {
    if (Number(key) !== pool || !Array.isArray(rows)) continue;
    const t = rows.map((r) => toSeconds(r?.time));
    const total = toSeconds(result?.time ?? result?.totalTime ?? result?.resultTime);
    const cumulative = t.every((x, i) => i === 0 || x > t[i - 1]) && finite(total) && Math.abs(t[t.length - 1] - total) < 0.05 && rows.length > 1;
    candidates.push(rows.map((r, i) => ({ count: r?.strokeCount ?? r?.overallStrokeCount, unit: r?.strokeCountUnit, seconds: cumulative ? t[i] - (i ? t[i - 1] : 0) : t[i], origin: strokeCountOrigin({ ...result, ...r }) })));
  }
  const splits = Array.isArray(result?.splits) ? result.splits : [];
  if (splits.length >= 2) {
    const d = splits.map((s) => Number(s?.distance)); const t = splits.map((s) => toSeconds(s?.time));
    if (d.every((x, i) => finite(x) && x - (i ? d[i - 1] : 0) === pool)) {
      candidates.push(splits.map((r, i) => ({ count: r?.strokeCount, unit: r?.strokeCountUnit, seconds: t[i] - (i ? t[i - 1] : 0), origin: strokeCountOrigin({ ...result, ...r }) })));
    }
  }
  const usable = candidates.filter((c) => c.length >= ROBUSTNESS_MIN_RACE_LENGTHS + 1 && c.every((u) => Number(u.count) > 0)).sort((a, b) => b.length - a.length)[0];
  return usable ? usable.slice(1) : null; // drop the dive length
}

/**
 * Axis estimate from eligible Robustness records ({ weights: { W }, date, context: { context, lossPct, quantSdPct } }).
 * Returns { score|null, contexts, coverage, reason, provisional }.
 */
export function robustnessAxisEstimate(records) {
  const groups = {};
  for (const r of records || []) {
    const c = r?.context || {}; const w = Number(r?.weights?.W);
    if (!(w > 0) || !finite(Number(c.lossPct))) continue;
    (groups[c.context || 'Unclassified'] ||= []).push({ w, loss: Number(c.lossPct), q: Number(c.quantSdPct), date: String(r.date || ''), origin: c.origin || 'measured', lowerBound: !!c.lossIsLowerBound });
  }
  const contexts = {};
  for (const [name, items] of Object.entries(groups)) {
    const W = sum(items.map((x) => x.w)); const m = sum(items.map((x) => x.w * x.loss)) / W;
    const empirical = items.length > 1 ? Math.sqrt(sum(items.map((x) => x.w * x.w * (x.loss - m) ** 2))) / W * Math.sqrt(items.length / (items.length - 1)) : Infinity;
    const quant = Math.sqrt(sum(items.map((x) => x.w * x.w * x.q * x.q))) / W;
    const se = Math.max(empirical, quant);
    const dates = [...new Set(items.map((x) => x.date).filter(Boolean))].sort();
    const status = name === 'Unclassified' ? 'demand unknown (not scored)'
      : items.length < ROBUSTNESS_MIN_CONTEXT_ITEMS ? 'insufficient evidence'
        : se > ROBUSTNESS_MAX_SE_PCT ? 'insufficient precision' : 'scored';
    contexts[name] = { items: items.length, weight: W, pooledLossPct: m, standardErrorPct: se, status,
      origin: combinedOrigin(items.map((x) => x.origin)), lowerBoundItems: items.filter((x) => x.lowerBound).length,
      score: status === 'scored' ? robustnessScoreFromLoss(Math.max(0, m)) : null,
      longitudinal: { dates: dates.length, first: dates[0] || null, last: dates[dates.length - 1] || null } };
  }
  const scored = Object.entries(contexts).filter(([, c]) => c.score !== null);
  const coverage = { scored: scored.map(([n]) => n), notScored: Object.entries(contexts).filter(([, c]) => c.score === null).map(([n, c]) => `${n}: ${c.status}`) };
  const evidenceOrigin = combinedOrigin(scored.map(([, c]) => c.origin));
  const validation = evidenceOrigin === 'synthetic' || evidenceOrigin === 'mixed' ? SYNTHETIC_VALIDATION_NOTE : null;
  if (!scored.length) {
    return { score: null, contexts, coverage, provisional: true, evidenceOrigin: null, validation: null,
      reason: Object.keys(contexts).length
        ? `Robustness not established: ${coverage.notScored.join('; ')}.`
        : 'No stroke-counted effort at comparable pace with a recorded demand context.' };
  }
  const W = sum(scored.map(([, c]) => c.weight));
  return { score: sum(scored.map(([, c]) => c.score * c.weight)) / W, contexts, coverage, provisional: true, evidenceOrigin, validation, reason: null };
}
