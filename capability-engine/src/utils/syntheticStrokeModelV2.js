// SYNTHETIC stroke model v2 — demonstration data only (labelled 'synthetic-stroke-model-v2'). Owner brief 21-11-2026.
// One documented way to generate stroke counts, stroke cycles and stroke rates for recorded synthetic swims, for every
// synthetic swimmer, from the swim's recorded time (never changed), the swimmer's level, sex, stroke, distance and
// the set's intensity and recovery. It replaces demoStrokeModel.js for regenerated demo data; demoStrokeModel.js is kept
// for the existing one-time upgrades.
//
// 1. Elite reference (already in AthlyraX, src/data/efficiencyReference.js and worldRecordBaseTimes.js):
//      elite speed v_E(d) = d ÷ world record (sex, stroke, course); elite stroke rate SR_E(d) (cycles/min, provisional
//      except 200 m); elite distance per cycle DPC_E(d) = v_E ÷ (SR_E ÷ 60). 25 m uses the 50 m values; distances
//      between table entries are interpolated on log-distance; beyond 400 m the 400 m stroke rate is used.
// 2. Swimmer level (speed, age and development): r(d) = the swimmer's best recorded speed at distance d ÷ v_E(d)
//      (interpolated on log-distance between recorded distances). At race pace:
//        DPC_level = DPC_E × r^LEVEL_DPC_SHARE,  SR_level = SR_E × r^(1 − LEVEL_DPC_SHARE)   (so v = SR × DPC holds).
//      ASSUMPTION A1 (owner to confirm): LEVEL_DPC_SHARE = 2/3 — most of the speed difference between performance
//      levels, and between juniors and seniors, is stroke length rather than stroke rate (Craig & Pendergast 1979;
//      Pelayo et al. 1996). A younger/slower swimmer therefore gets shorter strokes automatically.
// 3. Pace within a swimmer: swimming slower than race pace lengthens the stroke: DPC ∝ (v ÷ v_level)^PACE_ELASTICITY,
//      PACE_ELASTICITY = −0.25, the speed coefficient of the existing demo model (demoStrokeModel.js) at 1.5 m/s.
// 4. Fatigue (stroke-length loss beyond pace), first-order load/recovery:
//        while swimming dF/dt = K × w(zone) − F/TAU;  while resting dF/dt = −F/TAU;   DPC × (1 − F)
//      w(zone) = the AthlyraX intensity weights already used by the Training engine (Mujika et al. 1995):
//      EN1 1, EN2 2, EN3 3, LT/LP 5, SP 8. A repetition uses the mean F over its duration. Rest = send-off − swim time.
//      Continuous swimming saturates at F_ss = K × w × TAU (EN1 1.2 %, EN2 2.4 %, EN3 3.6 %, LT/LP 6 %, SP 9.6 %),
//      so long aerobic sets do not accumulate unbounded loss, short-rest hard sets accumulate more, and long recovery
//      resets it. Races and single efforts are continuous swims at the zone of their distance (25–50 m SP, 100 m LP,
//      200 m LT, 400 m EN3, ≥ 800 m EN2).
//      ASSUMPTION A2 (owner to confirm): TAU = 60 s and K = 0.0002 /s. Chosen so steady-state loss stays a few per cent
//      for aerobic work and about 6 % near threshold; NOT fitted to any AthlyraX score. Sensitivity is reported.
// 5. Stroked distance = swim distance − 5 m per wall (the AthlyraX push-off allowance, efficiencyReference.js), so
//      the engine measures back the modelled DPC; dive breakout 10 m for race and Max starts (as the demo seed).
// 6. Whole cycles: unbiased seeded stochastic rounding (floor(exact + u), u uniform in [0,1)), i.e. ±1 cycle of
//      natural count variation without systematic drift; race cycles are given per length from each length's own DPC.
// Freestyle and backstroke: 2 arm strokes per cycle; butterfly and breaststroke: 1. Medley/choice/drill/kick swims
// are not generated (no stroke reference).
import { WORLD_RECORD_BASE_TIMES } from '../data/worldRecordBaseTimes.js';
import { ELITE_STROKE_RATE_PROVISIONAL, efficiencyStrokeFamily } from '../data/efficiencyReference.js';

export const SYNTHETIC_STROKE_MODEL_V2 = 'synthetic-stroke-model-v2';
export const LEVEL_DPC_SHARE = 2 / 3;
export const PACE_ELASTICITY = -0.25;
export const FATIGUE_TAU_SECONDS = 60;
// PROGRESSIVE fatigue (owner review 21-11-2026, item 1) — the existing AthlyraX demo rule expressed per second of work.
// demoStrokeModel.js / build-demo-tenant-dataset.mjs shorten the stroke by 1.2 % per repetition of the demo's 100 m EN2
// main set (≈ 66.5 s per repetition, EN2 intensity weight 2). Expressed per second of swimming and scaled by the existing
// AthlyraX intensity weight w: F = min(F_CAP, K_P · w · t), t = swimming time before the unit within ONE effort (a set,
// a repeated test or a race; rest ignored, as in the existing rule; each effort starts fresh). F_CAP = 6 %, the largest
// fatigue the existing seed rule produces (6 repetitions × 1.2 %, 5 intervals). One rule for sets, tests and races.
// Synthetic demonstration only: NOT a validated model of how real swimmers lose stroke length.
export const FATIGUE_PROGRESSIVE_K_PER_SECOND = 0.012 / (2 * 66.5);
export const FATIGUE_PROGRESSIVE_CAP = 0.06;
export const FATIGUE_MODES = Object.freeze(['progressive', 'a2']);
export const FATIGUE_K_PER_SECOND = 0.0002;
export const ZONE_WEIGHT = Object.freeze({ en1: 1, a1: 1, en2: 2, a2: 2, en3: 3, lt: 5, lp: 5, b1: 5, b2: 5, c1: 5, c2: 5, c3: 5, rg: 5, sp: 8 });
export const PUSH_OFF_METRES = 5;
export const DIVE_BREAKOUT_METRES = 10;
export const raceZone = (d) => (d <= 50 ? 'sp' : d <= 100 ? 'lp' : d <= 200 ? 'lt' : d <= 400 ? 'en3' : 'en2');
const SPC = { free: 2, back: 2, fly: 1, breast: 1 };
const sexKey = (s) => (/^f|female|wom/i.test(String(s || '')) ? 'female' : 'male');
const courseKey = (pool) => (Number(pool) === 50 ? 'LC' : 'SC');

function interpLog(table, d) {
  const keys = Object.keys(table).map(Number).filter((k) => Number(table[k]) > 0).sort((a, b) => a - b);
  if (!keys.length) return null;
  if (d <= keys[0]) return table[keys[0]];
  if (d >= keys[keys.length - 1]) return table[keys[keys.length - 1]];
  const hi = keys.find((k) => k >= d); const lo = [...keys].reverse().find((k) => k <= d);
  if (hi === lo) return table[hi];
  const t = Math.log(d / lo) / Math.log(hi / lo);
  return table[lo] + (table[hi] - table[lo]) * t;
}
/** Elite speed (m/s), stroke rate (cycles/min) and DPC (m) for distance d. */
export function eliteReference({ distance, stroke = 'free', sex, poolLength = 25 }) {
  const fam = efficiencyStrokeFamily(stroke); if (!fam) return null;
  const s = sexKey(sex); const course = courseKey(poolLength);
  const wr = WORLD_RECORD_BASE_TIMES?.[course]?.[s]?.[fam]; const sr = ELITE_STROKE_RATE_PROVISIONAL?.[fam]?.[s];
  if (!wr || !sr) return null;
  const d = Math.max(50, Number(distance));
  const speeds = Object.fromEntries(Object.entries(wr).map(([k, t]) => [k, Number(k) / Number(t)]));
  const v = interpLog(speeds, d); const rate = interpLog(sr, d);
  return v && rate ? { v, sr: rate, dpc: v / (rate / 60), family: fam } : null;
}

/** Level ratios r(d) for one swimmer from recorded single efforts: [{distance, seconds, stroke, poolLength}]. */
export function swimmerLevel(swims, sex) {
  const best = {};
  for (const sw of swims || []) {
    const ref = eliteReference({ ...sw, sex }); if (!ref || !(sw.seconds > 0)) continue;
    const r = (sw.distance / sw.seconds) / ref.v; const d = Number(sw.distance);
    if (!best[d] || r > best[d]) best[d] = r;
  }
  return { ratios: best, at: (d) => interpLog(best, Math.max(25, Number(d))) };
}

function rng(seed) { let h = 2166136261; for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } let a = h >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Mean fatigue over a swim of T seconds starting at F0, and the fatigue at its end. */
export function fatigueOverSwim(F0, T, w, { K = FATIGUE_K_PER_SECOND, TAU = FATIGUE_TAU_SECONDS } = {}) {
  const Fss = K * w * TAU; const e = Math.exp(-T / TAU);
  return { mean: Fss + (F0 - Fss) * (TAU / T) * (1 - e), end: Fss + (F0 - Fss) * e };
}

/**
 * Stroke fields for the repetitions of one set (or a single swim), in order.
 * reps: [{ seconds }]; set: { distance, stroke, poolLength, zone, sendOffSeconds, dive }.
 */
const progressiveFatigue = (w, tBefore, { KP = FATIGUE_PROGRESSIVE_K_PER_SECOND, CAP = FATIGUE_PROGRESSIVE_CAP } = {}) => Math.min(CAP, KP * w * tBefore);
export function generateSetReps(reps, { distance, stroke, poolLength = 25, zone, sendOffSeconds, dive = false }, { level, sex, seed, K, TAU, mode = 'a2', KP, CAP }) {
  const ref = eliteReference({ distance, stroke, sex, poolLength }); const fam = ref?.family;
  if (!ref || !fam) return null;
  const r = level.at(distance); if (!(r > 0)) return null;
  const dpcLevel = ref.dpc * r ** LEVEL_DPC_SHARE; const vLevel = ref.v * r;
  const walls = Math.max(1, Math.round(distance / poolLength));
  const stroked = distance - (dive ? DIVE_BREAKOUT_METRES + PUSH_OFF_METRES * (walls - 1) : PUSH_OFF_METRES * walls);
  const w = ZONE_WEIGHT[String(zone || raceZone(distance)).toLowerCase()] ?? 1;
  const rand = rng(seed); let F = 0; let swum = 0;
  return reps.map((rep, k) => {
    const T = Number(rep.seconds); if (!(T > 0)) return null;
    const f = mode === 'progressive' ? { mean: progressiveFatigue(w, swum, { KP, CAP }), end: 0 } : fatigueOverSwim(F, T, w, { K, TAU });
    swum += T;
    const v = distance / T;
    const dpc = dpcLevel * (v / vLevel) ** PACE_ELASTICITY * (1 - f.mean);
    const cycles = Math.max(1, Math.floor(stroked / dpc + rand()));
    const rest = Number(sendOffSeconds) > T ? Number(sendOffSeconds) - T : 0;
    F = f.end * Math.exp(-rest / (TAU ?? FATIGUE_TAU_SECONDS));
    const swimSeconds = T * stroked / distance;
    return { strokeCycles: cycles, strokeCount: cycles * SPC[fam], strokesPerCycle: SPC[fam], strokeRate: Math.round((cycles / swimSeconds) * 600) / 10, k };
  });
}

/** Per-length stroke fields for a continuous race from its per-length times. */
export function generateRaceLengths(lengthSeconds, { distance, stroke, poolLength = 25 }, { level, sex, seed, K, TAU, mode = 'a2', KP, CAP }) {
  const ref = eliteReference({ distance, stroke, sex, poolLength }); const fam = ref?.family;
  if (!ref || !fam) return null;
  const r = level.at(distance); if (!(r > 0)) return null;
  const dpcLevel = ref.dpc * r ** LEVEL_DPC_SHARE; const vLevel = ref.v * r;
  const w = ZONE_WEIGHT[raceZone(distance)]; const rand = rng(seed); let F = 0; let swum = 0;
  return lengthSeconds.map((T, i) => {
    const f = mode === 'progressive' ? { mean: progressiveFatigue(w, swum, { KP, CAP }), end: 0 } : fatigueOverSwim(F, T, w, { K, TAU });
    F = f.end; swum += T;
    const stroked = poolLength - (i === 0 ? DIVE_BREAKOUT_METRES : PUSH_OFF_METRES);
    const v = poolLength / T; // length speed (pace of this length)
    const dpc = dpcLevel * (v / vLevel) ** PACE_ELASTICITY * (1 - f.mean);
    const cycles = Math.max(1, Math.floor(stroked / dpc + rand()));
    return { strokeCycles: cycles, strokeCount: cycles * SPC[fam], strokesPerCycle: SPC[fam] };
  });
}

export const fieldsFor = (g, extra = {}) => ({
  strokeCount: g.strokeCount, overallStrokeCount: g.strokeCount, strokeCountUnit: 'strokes', strokeCycles: g.strokeCycles,
  strokeCycleUnit: 'cycles', strokesPerCycle: g.strokesPerCycle, ...(g.strokeRate != null ? { strokeRate: g.strokeRate, strokeRateUnit: 'cycles/min' } : {}),
  measurementSource: 'synthetic-demo', strokeCycleSource: SYNTHETIC_STROKE_MODEL_V2, strokeCountSource: SYNTHETIC_STROKE_MODEL_V2, ...extra,
});
