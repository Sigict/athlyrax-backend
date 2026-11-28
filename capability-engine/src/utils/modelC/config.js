// AthlyraX Final Model C - configuration authority.
// The DEFAULT configuration reproduces the approved Phase 0 final simulation
// (AthlyraX_ModelC_final_simulation.html / AthlyraX_ModelC_recommended_config.json,
// 27-11-2026). Every coefficient used by the Model C calculation is read from a
// configuration object built here; no calculation function carries its own
// provisional constant. The original v1.8 engine is kept unchanged as the
// comparison and rollback reference (engine: 'original').
import { ATHLYRAX_AXIS_DEFINITIONS } from '../athlyraxCapabilityEngine.js';
import { ORIGINAL_ENERGY_ATTRIBUTION, ORIGINAL_TRAINING_COEFFICIENTS, WORLD_CLASS_WEEKLY_METRES_REFERENCE } from '../trainingAxisDemandEngine.js';
import { SWIMMING_CV_STABILITY_ANCHORS } from '../olympicCapabilityCalibration.js';
import { WORLD_RECORD_META } from '../../data/worldRecordBaseTimes.js';

export const MODEL_C_ENGINE_VERSION = 'AthlyraX Model C 1.0.0';
export const ORIGINAL_ENGINE_ID = 'original';
export const MODEL_C_ENGINE_ID = 'model-c';
export const MODEL_C_REFERENCE_VERSION = `references-1 (world records ${WORLD_RECORD_META.fetchedAt}; elite CSS, protocol, intensity and pacing references derived; elite stroke rates: 200 m primary, others provisional)`;
export const AXES = Object.freeze(['technical_control', 'efficiency', 'robustness_of_efficiency', 'aerobic_capacity', 'anaerobic_capacity',
  'power_speed_expression', 'adaptability', 'durability']);
export const AXIS_LABEL = Object.freeze({ technical_control: 'Technical Control', efficiency: 'Efficiency', robustness_of_efficiency: 'Robustness of Efficiency',
  aerobic_capacity: 'Aerobic Capacity', anaerobic_capacity: 'Anaerobic Capacity', power_speed_expression: 'Power & Speed Expression',
  adaptability: 'Adaptability', durability: 'Durability' });

const clone = (v) => JSON.parse(JSON.stringify(v));
const metricWeightsOriginal = () => Object.fromEntries(ATHLYRAX_AXIS_DEFINITIONS.map((a) => [a.key, { ...a.metrics }]));
const exposureOriginal = () => Object.fromEntries(ATHLYRAX_AXIS_DEFINITIONS.map((a) => [a.key, a.exposureTarget]));

// Final Model C training attribution (Phase 0 instruction table): SP Ana .20 / P&S 1.00, LP 1.00/.25, LT 1.00/.10, EN3 .75/0.
const MODEL_C_ENERGY_ATTRIBUTION = (() => {
  const t = clone(ORIGINAL_ENERGY_ATTRIBUTION);
  t.en3 = { aerobic_capacity: 0.65, anaerobic_capacity: 0.75, power_speed_expression: 0, durability: 0.45 };
  t.lt = { anaerobic_capacity: 1, aerobic_capacity: 0.35, power_speed_expression: 0.10, durability: 0.65 };
  t.lp = { anaerobic_capacity: 1, power_speed_expression: 0.25, durability: 0.4 };
  t.sp = { power_speed_expression: 1, anaerobic_capacity: 0.2, technical_control: 0.3 };
  return t;
})();

export function buildDefaultModelConfig() {
  return {
    engine: MODEL_C_ENGINE_ID,
    engineVersion: MODEL_C_ENGINE_VERSION,
    referenceVersion: MODEL_C_REFERENCE_VERSION,
    // ---- capability scoring S = 100 x Q x D^alpha (quality metrics); output metrics use the transformations below
    alpha: { technical_control: 1, robustness_of_efficiency: 0.75, aerobic_capacity: 0.75, anaerobic_capacity: 0.75,
      power_speed_expression: 0.5, adaptability: 0.5, durability: 1 },
    // 'male' = one absolute men's standard for every swimmer (owner decision); 'own' = category (sex-specific) standard
    referenceSex: 'male',
    // score transformation exponent of velocity-performance ratios: 3 = World Aquatics cubic, 1 = linear
    transform: { event: 3, css: 3, protocolOutput: 3 },
    // demand ratio scale for quality metrics: 'linear' D = v/v_ref (plain ratio), 'wa' = D^3
    demandScale: 'linear',
    // stability sensitivity: multiplier applied to a coefficient of variation before the stability curve (1 = original)
    cvMultiplier: 1,
    stabilityCurve: SWIMMING_CV_STABILITY_ANCHORS.map(([x, y]) => [x, y]),
    metricWeights: metricWeightsOriginal(),
    exposureTargets: exposureOriginal(),
    recency: { bands: [[14, 1], [28, 0.75], [56, 0.5]], older: 0.25 },
    // ---- references
    protocolFactor: { R8x25: 0.95, R8x50: 0.92, R8x100: 0.88, A5x400: 1.0, custom: 0.90 },
    trainingRef: { EN1: ['css', 0.85], A1: ['css', 0.85], EN2: ['css', 0.95], A2: ['css', 0.93], EN3: ['v400', 1.0],
      LT: ['vmax', 0.86], LP: ['vmax', 0.90], SP: ['vmax', 0.96], B1: ['vmax', 0.86], B2: ['vmax', 0.88], RG: ['vmax', 0.90],
      TECH: ['css', 0.80], DRILL: ['css', 0.75], _default: ['css', 0.85] },
    pacingRef: { 50: null, 100: 1.07, 200: 1.04, 400: 1.02, 800: 1.01, 1500: 1.01 },
    references: {
      // 25 m world-class time derived from the 50 m record (start-dominated split ratio)
      d25Ratio: { female: 10.7 / 23.6, male: 9.5 / 20.9 },
      // split format detection tolerance against the official time (seconds)
      splitToleranceSeconds: 0.6,
      // owner overrides of world-record base times {course:{sex:{stroke:{distance:seconds}}}} and elite stroke rates
      worldRecordOverrides: {},
      strokeRateOverrides: {},
      // future Speed Table: {"<course>|<stroke>|<distance>|<energy or protocol>": velocity m/s} consulted before derived references
      speedTable: {},
    },
    // ---- Aerobic: CSS share of the threshold_pace weight; M200 + M400 pairing window
    aerobicCssShare: 0.5,
    cssPairWindowDays: 28,
    // ---- measured-capability routing (separate from the training stimulus attribution)
    routing: { anaerobicPeak: { M50: 0.5, M100: 1.0, M200: 0.8, R8x50: 1.0, R8x100: 1.0, race50: 0.5, race100: 1.0, race200: 1.0 },
      aerobicPaceStability: { R8x100: 0.5 } },
    // ---- Durability
    durability: { wOutput: 0.60, wWork: 0.25, wDensity: 0.15, referenceWorkM: 2000,
      referenceWorkFraction: { EN1: 0.85, EN2: 0.80, EN3: 0.70, LT: 0.50, LP: 0.35, SP: 0.25, _default: 0.75 } },
    // Durability evidence weight of a single effort = min(1, metres / this): 50 m 0.125 -> races below 100 m none (see below),
    // 100 m 0.25, 200 m 0.50, >= 400 m 1.00. Race retention below the relevance goes to Anaerobic fatigue_resistance (1 - r).
    durabilityRelevanceMetres: 400,
    // ---- Adaptability
    // pairing: 'most-recent-eligible' (owner decision 28-11-2026: corrected rule; multiple simultaneous changes,
    // including repetition-count changes, are never scored) | 'consecutive' (Phase 0 simulation rule, kept for rollback)
    adaptability: { pairing: 'most-recent-eligible', tolerance: 0.10, sendoffChangeRef: 0.20, speedChangeRef: 0.10, distanceChangeRef: 1.0, pairWindowDays: 14,
      direction: { harder: 1.0, easier: 0.5, neutral: 1.0 },
      // Provisional fallback F2 (owner decision 28-11-2026): used only when the changed-demand calculation leaves
      // Adaptability unscored in every source; never combined with a valid score. 'off' disables it (rollback).
      repetitionFallback: { mode: 'provisional-f2', b: 0, tolerance: 0.10, magnitudeRef: 1.0, alpha: 0.5 } },
    // ---- integration and competition
    sourceWeights: { training: 0.30, testing: 0.50, competition: 0.20 },
    combine: 'flat',
    competitionAggregation: 'events',
    // ---- Training stimulus (training-demand v8 structure; diminishing returns retained)
    training: {
      attributionMode: 'scaled',
      energyAttribution: MODEL_C_ENERGY_ATTRIBUTION,
      coefficients: { ...ORIGINAL_TRAINING_COEFFICIENTS },
      weeklyReferenceMetres: WORLD_CLASS_WEEKLY_METRES_REFERENCE,
    },
  };
}

// The original working engine's values for the same parameters (baseline column of the console).
export function buildOriginalBaselineConfig() {
  const c = buildDefaultModelConfig();
  return { ...c, engine: ORIGINAL_ENGINE_ID, engineVersion: 'AthlyraX Full V6 Axis Engine v1.8', adaptability: { ...c.adaptability, pairing: 'consecutive', repetitionFallback: { ...c.adaptability.repetitionFallback, mode: 'off' } },
    training: { ...c.training, attributionMode: 'original', energyAttribution: clone(ORIGINAL_ENERGY_ATTRIBUTION) } };
}

export const DEFAULT_MODEL_CONFIG = Object.freeze(buildDefaultModelConfig());

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base, over) {
  if (!isObj(over)) return over === undefined ? base : clone(over);
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : clone(v);
  return out;
}
// Complete configuration from a (possibly partial) stored configuration. Unknown keys are kept for audit only.
export function resolveModelConfig(stored) {
  if (!isObj(stored)) return clone(DEFAULT_MODEL_CONFIG);
  return deepMerge(clone(DEFAULT_MODEL_CONFIG), stored);
}

// Stable short signature of a configuration (cache key component and version identity).
export function configSignature(cfg) {
  const s = JSON.stringify(cfg);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) flatten(v, p, out); else out[p] = v;
  }
  return out;
}
export function getPath(obj, p) { return String(p).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj); }
export function setPath(obj, p, value) {
  const keys = String(p).split('.'); const out = clone(obj); let o = out;
  for (let i = 0; i < keys.length - 1; i += 1) { if (!isObj(o[keys[i]]) && !Array.isArray(o[keys[i]])) o[keys[i]] = {}; o = o[keys[i]]; }
  o[keys[keys.length - 1]] = value; return out;
}

// ------------------------------------------------------------------ parameter catalogue (console sections, ranges, purposes)
const S = (section, path, label, min, max, step, purpose, affects, kind = 'number') => ({ section, path, label, min, max, step, purpose, affects, kind });
export const CALIBRATION_SECTIONS = Object.freeze([
  ['technical_control', 'Technical Control'], ['efficiency', 'Efficiency'], ['robustness_of_efficiency', 'Robustness of Efficiency'],
  ['aerobic_capacity', 'Aerobic Capacity'], ['anaerobic_capacity', 'Anaerobic Capacity'], ['power_speed_expression', 'Power & Speed Expression'],
  ['adaptability', 'Adaptability'], ['durability', 'Durability'], ['training', 'Training demand'], ['competition', 'Competition calculations'],
  ['integration', 'Integrated source weighting'], ['references', 'Reference tables'], ['evidence', 'Evidence sufficiency and aggregation'],
]);
export function parameterCatalogue(cfg = DEFAULT_MODEL_CONFIG) {
  const out = [];
  for (const axis of AXES) {
    for (const metric of Object.keys(cfg.metricWeights[axis] || {})) {
      out.push(S(axis, `metricWeights.${axis}.${metric}`, `Metric weight · ${metric.replace(/_/g, ' ')}`, 0, 1, 0.01,
        'Share of this metric in the axis score (weights of the available metrics are renormalised).', `${AXIS_LABEL[axis]} source scores`));
    }
    out.push(S(axis, `exposureTargets.${axis}`, 'Exposure target (evidence items for full frequency weight)', 1, 20, 1,
      'Frequency weight = min(1, distinct evidence / target).', `${AXIS_LABEL[axis]} aggregation`));
    if (cfg.alpha[axis] !== undefined) out.push(S(axis, `alpha.${axis}`, 'Demand exponent α', 0, 2, 0.05,
      'S = 100·Q·D^α: how strongly the absolute task demand scales a quality measurement.', `${AXIS_LABEL[axis]} quality metrics`));
  }
  out.push(S('efficiency', 'references.strokeRateOverrides', 'Elite stroke-rate overrides {stroke.sex.distance: cycles/min}', null, null, null,
    'Replaces a provisional elite stroke rate; Efficiency = SI / SI_elite with SI_elite ∝ 1 / stroke rate.', 'Efficiency (all sources)', 'json'));
  out.push(S('aerobic_capacity', 'aerobicCssShare', 'Critical Swimming Speed share of threshold_pace', 0, 1, 0.05,
    'threshold_pace weight is divided between event output and CSS = 200/(T400 − T200).', 'Aerobic Capacity (testing)'));
  out.push(S('aerobic_capacity', 'cssPairWindowDays', 'M200 + M400 pairing window (days)', 1, 120, 1, 'Maximum separation of the two tests used for CSS.', 'Aerobic CSS'));
  out.push(S('aerobic_capacity', 'routing.aerobicPaceStability.R8x100', '8×100 pace-stability evidence weight', 0, 1, 0.05, 'Signal weight of 8×100 for Aerobic pace stability.', 'Aerobic Capacity'));
  for (const [k, v] of Object.entries(cfg.routing.anaerobicPeak)) out.push(S('anaerobic_capacity', `routing.anaerobicPeak.${k}`, `Peak-output evidence weight · ${k}`, 0, 1, 0.05,
    'Measured-capability weight of this protocol or race distance for Anaerobic peak output (independent of training attribution).', 'Anaerobic Capacity', v === null ? 'nullable' : 'number'));
  for (const k of Object.keys(cfg.protocolFactor)) out.push(S(k === 'R8x25' ? 'power_speed_expression' : k === 'A5x400' ? 'aerobic_capacity' : 'anaerobic_capacity',
    `protocolFactor.${k}`, `Protocol reference factor · ${k}`, 0.5, 1.2, 0.01, 'Fraction of world-class maximal speed an elite swimmer holds on average in this protocol.', 'Task demand D of the protocol'));
  out.push(S('robustness_of_efficiency', 'cvMultiplier', 'Stability sensitivity (CV multiplier)', 0.5, 1.5, 0.05,
    'Multiplies a coefficient of variation before the stability curve (former one-axis preview).', 'All stability metrics'));
  for (const k of ['tolerance', 'sendoffChangeRef', 'speedChangeRef', 'distanceChangeRef']) out.push(S('adaptability', `adaptability.${k}`,
    { tolerance: 'Response tolerance (relative error at Q = 0)', sendoffChangeRef: 'Send-off / recovery change for full change difficulty', speedChangeRef: 'Pace / intensity change for full change difficulty', distanceChangeRef: 'Distance change (doublings) for full change difficulty' }[k],
    k === 'distanceChangeRef' ? 0.25 : 0.02, k === 'distanceChangeRef' ? 3 : 0.5, 0.01,
    k === 'tolerance' ? 'Q = max(0, 1 − E/tolerance).' : 'D_change = min(1, change / reference).', 'Adaptability'));
  out.push(S('adaptability', 'adaptability.pairing', 'Changed-demand pairing rule', null, null, null,
    "'most-recent-eligible' = compare with the most recent earlier set within the window that differs in exactly one scorable demand, repetitions and technical prescription unchanged (owner decision 28-11-2026); 'consecutive' = the Phase 0 rule (immediately preceding timed set), kept for rollback.", 'Adaptability', 'enum:consecutive,most-recent-eligible'));
  out.push(S('adaptability', 'adaptability.pairWindowDays', 'Changed-demand pair window (days)', 1, 60, 1, 'Maximum separation of the two compared sets.', 'Adaptability'));
  out.push(S('adaptability', 'adaptability.repetitionFallback.mode', 'Repetition-count fallback (F2, provisional)', null, null, null,
    "'provisional-f2' = when the changed-demand calculation leaves Adaptability unscored, score it from sets whose only change is the repetition count (shown as a provisional estimate; never combined with a valid score); 'off' = no fallback.", 'Adaptability', 'enum:provisional-f2,off'));
  out.push(S('adaptability', 'adaptability.repetitionFallback.b', 'F2 · expected pace exponent b', 0, 0.2, 0.01, 'Expected profile × (r_new / r_old)^−b; 0 = the swimmer\'s own previous profile extended or truncated.', 'Adaptability (F2 fallback)'));
  out.push(S('adaptability', 'adaptability.repetitionFallback.tolerance', 'F2 · response tolerance τ', 0.005, 0.5, 0.005, 'Q = clamp(1 − max(0, −δ) / τ), δ = mean actual / mean expected speed − 1.', 'Adaptability (F2 fallback)'));
  out.push(S('adaptability', 'adaptability.repetitionFallback.magnitudeRef', 'F2 · magnitude weighting coefficient c', 0.25, 3, 0.05, 'Evidence weight = min(1, |ln(r_new / r_old)| / ln 2 / c); the magnitude never changes the score.', 'Adaptability (F2 fallback)'));
  out.push(S('adaptability', 'adaptability.repetitionFallback.alpha', 'F2 · demand exponent α', 0, 2, 0.05, 'S = 100 · Q · D_out^α.', 'Adaptability (F2 fallback)'));
  for (const k of ['harder', 'easier', 'neutral']) out.push(S('adaptability', `adaptability.direction.${k}`, `Direction coefficient · ${k}`, 0, 1, 0.05, 'Multiplies the change difficulty by direction.', 'Adaptability'));
  for (const k of ['wOutput', 'wWork', 'wDensity']) out.push(S('durability', `durability.${k}`, { wOutput: 'D_out exponent', wWork: 'D_work exponent', wDensity: 'D_density exponent' }[k], 0, 1, 0.05,
    'D = D_out^w1 · D_work^w2 · D_density^w3 (inapplicable components omitted and renormalised).', 'Durability'));
  out.push(S('durability', 'durability.referenceWorkM', 'Reference work (m) for D_work = 1', 200, 10000, 50, 'D_work = min(1, set metres / reference).', 'Durability (training)'));
  for (const k of Object.keys(cfg.durability.referenceWorkFraction)) out.push(S('durability', `durability.referenceWorkFraction.${k}`, `Reference work fraction · ${k}`, 0.05, 1, 0.01, 'D_density = min(1, (swim time / send-off) / reference).', 'Durability (training)'));
  out.push(S('durability', 'durabilityRelevanceMetres', 'Distance for full Durability relevance (m)', 100, 1500, 25,
    'Evidence weight r = min(1, metres / this); 100 m → 0.25, 200 m → 0.50, ≥400 m → 1 at 400. Race retention: Durability r, Anaerobic 1 − r.', 'Durability, Anaerobic (competition and tests)'));
  for (const k of Object.keys(cfg.pacingRef)) out.push(S('competition', `pacingRef.${k}`, `Elite pacing ratio (2nd/1st half) · ${k} m`, 0.9, 1.2, 0.005, 'Retention reference by race distance (null = no retention measurement).', 'Race retention', 'nullable'));
  out.push(S('competition', 'competitionAggregation', 'All-events aggregation', null, null, null, "'events' = each event first, equal weight across events; 'records' = pooled records.", 'Competition (all events)', 'enum:events,records'));
  for (const k of ['training', 'testing', 'competition']) out.push(S('integration', `sourceWeights.${k}`, `Source weight · ${k === 'training' ? 'measured Training' : k === 'testing' ? 'controlled Testing' : 'Competition'}`, 0, 1, 0.01,
    'I = Σ w·S / Σ w over the sources available for the axis.', 'Integrated, Capability'));
  out.push(S('integration', 'combine', 'Source combination', null, null, null, "'flat' = exact source weights (approved); 'coverage' and 'single' are comparison modes only.", 'Integrated', 'enum:flat,coverage,single'));
  out.push(S('references', 'referenceSex', 'Absolute reference standard', null, null, null, "'male' = men's world-class standard for all swimmers (approved); 'own' = category alternative.", 'All absolute references', 'enum:male,own'));
  for (const k of Object.keys(cfg.transform)) out.push(S('references', `transform.${k}`, `Score transformation exponent · ${k}`, 1, 3, 1, '3 = World Aquatics cubic; 1 = plain ratio.', 'Velocity-performance scores'));
  out.push(S('references', 'demandScale', 'Task-demand scale', null, null, null, "'linear' = plain ratio (approved); 'wa' = cubic.", 'All quality metrics', 'enum:linear,wa'));
  for (const k of Object.keys(cfg.trainingRef)) out.push(S('references', `trainingRef.${k}.0`, `Training intensity reference base · ${k}`, null, null, null,
    "'css' = elite critical speed, 'v400' = world-class 400 m speed, 'vmax' = world-class speed of the repetition distance.", 'Training task demand D', 'enum:css,v400,vmax'));
  for (const [k, [base, f]] of Object.entries(cfg.trainingRef)) out.push(S('references', `trainingRef.${k}.1`, `Training intensity reference · ${k} (× ${base})`, 0.5, 1.2, 0.01, `Reference velocity = factor × ${base === 'css' ? 'elite critical speed' : base === 'v400' ? 'world-class 400 m speed' : 'world-class speed of the repetition distance'}.`, 'Training task demand D', 'number'));
  out.push(S('references', 'references.d25Ratio.male', '25 m derived from 50 m record · men', 0.4, 0.5, 0.001, 'World-class 25 m time = 50 m record × ratio.', 'M25 / 8×25 references'));
  out.push(S('references', 'references.d25Ratio.female', '25 m derived from 50 m record · women', 0.4, 0.5, 0.001, 'World-class 25 m time = 50 m record × ratio.', 'M25 / 8×25 references'));
  out.push(S('references', 'references.worldRecordOverrides', 'World-record base-time overrides {course.sex.stroke.distance: s}', null, null, null, 'Replaces a base time (otherwise the weekly-updated world records).', 'Absolute performance references', 'json'));
  out.push(S('references', 'references.speedTable', 'Speed Table {"course|stroke|distance|code": m/s}', null, null, null, 'Owner Speed Table: consulted before derived references when present.', 'Task demand D', 'json'));
  out.push(S('evidence', 'stabilityCurve', 'Stability curve [CV %, score]', null, null, null, 'Piecewise-linear quality curve shared by every stability metric.', 'All stability metrics', 'json'));
  out.push(S('evidence', 'recency.bands', 'Recency bands [[days, weight], …]', null, null, null, 'Evidence weight by age at the calculation date.', 'All aggregation', 'json'));
  out.push(S('evidence', 'recency.older', 'Recency weight beyond the last band', 0, 1, 0.05, 'Weight of older evidence.', 'All aggregation'));
  out.push(S('references', 'references.splitToleranceSeconds', 'Split format tolerance (s)', 0.1, 2, 0.1, 'Cumulative vs per-lap split detection against the official time.', 'Race retention'));
  out.push(S('training', 'training.attributionMode', 'Attribution mode', null, null, null, "'scaled' = stimulus distributed by attribution (approved); 'original' = on/off.", 'Training graph', 'enum:scaled,original'));
  for (const [code, axes] of Object.entries(cfg.training.energyAttribution)) for (const axis of AXES) {
    if (axes[axis] === undefined && !['en3', 'lt', 'lp', 'sp'].includes(code)) continue;
    out.push(S('training', `training.energyAttribution.${code}.${axis}`, `Energy attribution · ${code.toUpperCase()} → ${AXIS_LABEL[axis]}`, 0, 1, 0.05, 'Share of the set stimulus attributed to this axis (blank = 0).', 'Training graph', 'nullable'));
  }
  for (const k of Object.keys(cfg.training.coefficients)) out.push(S('training', `training.coefficients.${k}`, `Demand coefficient · ${k}`, 0, 1, 0.01, 'Training-demand v8 set demand component.', 'Training graph'));
  out.push(S('training', 'training.weeklyReferenceMetres', 'World-class reference week (m)', 10000, 150000, 1000, 'Score = √(focused metres / world-class week focused metres) (diminishing returns).', 'Training graph'));
  return out;
}

// ------------------------------------------------------------------ validation (activation is refused when any error exists)
export function validateModelConfig(cfg) {
  const errors = []; const warn = [];
  const num = (p, lo, hi) => { const v = getPath(cfg, p); if (!(typeof v === 'number' && Number.isFinite(v))) errors.push(`${p}: must be a number`); else if (v < lo || v > hi) errors.push(`${p}: ${v} outside ${lo}–${hi}`); };
  if (!isObj(cfg)) return { ok: false, errors: ['configuration must be an object'], warnings: [] };
  if (![MODEL_C_ENGINE_ID, ORIGINAL_ENGINE_ID].includes(cfg.engine)) errors.push('engine: must be model-c or original');
  for (const p of parameterCatalogue(cfg)) {
    const v = getPath(cfg, p.path);
    if (p.kind === 'number') num(p.path, p.min, p.max);
    else if (p.kind === 'nullable') { if (v !== null && v !== undefined) num(p.path, p.min, p.max); }
    else if (p.kind.startsWith('enum:')) { if (!p.kind.slice(5).split(',').includes(v)) errors.push(`${p.path}: must be one of ${p.kind.slice(5)}`); }
  }
  for (const axis of AXES) {
    const w = Object.values(cfg.metricWeights?.[axis] || {}); const s = w.reduce((a, b) => a + b, 0);
    if (!(s > 0)) errors.push(`metricWeights.${axis}: weights must sum to more than 0`);
    else if (Math.abs(s - 1) > 0.001) warn.push(`metricWeights.${axis}: weights sum to ${s.toFixed(3)} (renormalised over available metrics)`);
  }
  const sw = Object.values(cfg.sourceWeights || {}).reduce((a, b) => a + b, 0);
  if (Math.abs(sw - 1) > 0.001) errors.push(`sourceWeights: must sum to 1 (now ${sw.toFixed(3)})`);
  const dw = (cfg.durability?.wOutput || 0) + (cfg.durability?.wWork || 0) + (cfg.durability?.wDensity || 0);
  if (Math.abs(dw - 1) > 0.001) errors.push(`durability exponents must sum to 1 (now ${dw.toFixed(3)})`);
  const curve = cfg.stabilityCurve;
  if (!Array.isArray(curve) || curve.length < 2 || curve.some((p, i) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || (i && (p[0] <= curve[i - 1][0] || p[1] > curve[i - 1][1]))))
    errors.push('stabilityCurve: points must be [CV, score] with CV increasing and score not increasing');
  const bands = cfg.recency?.bands;
  if (!Array.isArray(bands) || bands.some((b, i) => !Array.isArray(b) || !(b[0] > 0) || !(b[1] >= 0 && b[1] <= 1) || (i && b[0] <= bands[i - 1][0]))) errors.push('recency.bands: [[days>0, weight 0–1], …] with days increasing');
  for (const [k, v] of Object.entries(cfg.trainingRef || {})) if (!Array.isArray(v) || !['css', 'v400', 'vmax'].includes(v[0]) || !(v[1] > 0)) errors.push(`trainingRef.${k}: [css|v400|vmax, positive factor]`);
  for (const [k, v] of Object.entries(cfg.references?.speedTable || {})) if (!(Number(v) > 0)) errors.push(`references.speedTable.${k}: velocity must be positive`);
  const wro = flatten(cfg.references?.worldRecordOverrides || {}); for (const [k, v] of Object.entries(wro)) if (!(Number(v) > 0)) errors.push(`references.worldRecordOverrides.${k}: time must be positive`);
  const sro = flatten(cfg.references?.strokeRateOverrides || {}); for (const [k, v] of Object.entries(sro)) if (!(Number(v) > 0)) errors.push(`references.strokeRateOverrides.${k}: stroke rate must be positive`);
  return { ok: errors.length === 0, errors, warnings: warn };
}
