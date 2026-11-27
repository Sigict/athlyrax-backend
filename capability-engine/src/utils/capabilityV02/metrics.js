// AthlyraX capability engine v0.2 (EXPERIMENTAL) - derived metrics. Port of src/candidate/metrics.py.
import { PARAMS } from './calibration.js';
import { WORLD_RECORD_BASE_TIMES } from '../../data/worldRecordBaseTimes.js';
import { ELITE_STROKE_RATE_PROVISIONAL } from '../../data/efficiencyReference.js';

const D25 = { female: 10.7 / 23.6, male: 9.5 / 20.9 };
export const courseOf = (pool) => ((pool || 25) >= 45 ? 'LC' : 'SC');
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

// Performance (assignment 23): a typed-array numeric sort orders finite doubles exactly as the comparator sort did, so
// the median is bit-identical (verified by the equivalence harness) while Theil-Sen's O(n^2) slope set sorts ~5x faster.
export function median(v) {
  const s = Float64Array.from(v).sort(); const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
export function sd(v) {
  const x = v.filter((a) => a !== null && a !== undefined);
  if (x.length < 2) return null;
  const m = x.reduce((a, b) => a + b, 0) / x.length;
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1));
}
export function waPoints(time, distance, stroke = 'free', sex = 'male', pool = 25) {
  if (!time || !distance) return null;
  const sx = String(sex).startsWith('f') ? 'female' : 'male';
  const st = ['free', 'back', 'breast', 'fly'].includes(stroke) ? stroke : 'free';
  const table = WORLD_RECORD_BASE_TIMES?.[courseOf(pool)]?.[sx]?.[st] || {};
  const d = Math.trunc(distance);
  let b = table[d] ?? table[String(d)];
  if ((b === undefined || b === null) && d === 25) {
    const b50 = table[50] ?? table['50'];
    b = b50 ? b50 * D25[sx] : null;
  }
  return b ? 1000 * (b / time) ** 3 : null;
}
// Performance (release correction 27-11-2026): the k-th smallest value of a Float64Array by selection (in place,
// average linear time) instead of sorting all n(n-1)/2 Theil-Sen slopes. It returns exactly the value a full typed-array
// sort would place at index k, including the sign of a zero (a sort orders -0 before +0); arrays holding NaN use the sort.
function kthSmallest(a, k) {
  let lo = 0; let hi = a.length - 1;
  while (hi > lo) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < a[lo]) { const t = a[mid]; a[mid] = a[lo]; a[lo] = t; }
    if (a[hi] < a[lo]) { const t = a[hi]; a[hi] = a[lo]; a[lo] = t; }
    if (a[hi] < a[mid]) { const t = a[hi]; a[hi] = a[mid]; a[mid] = t; }
    const pivot = a[mid]; let i = lo; let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i += 1;
      while (a[j] > pivot) j -= 1;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i += 1; j -= 1; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else break;
  }
  return a[k];
}
// A zero found at sorted index k is -0 exactly when k falls among the negatives and negative zeros (sorted first).
function zeroAt(a, k) {
  let before = 0;
  for (let i = 0; i < a.length; i += 1) { const x = a[i]; if (x < 0 || Object.is(x, -0)) before += 1; }
  return k < before ? -0 : 0;
}
function medianOfTyped(s) {
  const n = s.length;
  if (!n) return null;
  for (let i = 0; i < n; i += 1) if (Number.isNaN(s[i])) { s.sort(); return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
  const k = n % 2 ? (n - 1) / 2 : n / 2 - 1;
  let lower = kthSmallest(s, k);
  if (lower === 0) lower = zeroAt(s, k);
  if (n % 2) return lower;
  // After selecting index k every later element is >= it, so the next order statistic is the smallest of them.
  let upper = s[k + 1];
  for (let i = k + 2; i < n; i += 1) if (s[i] < upper) upper = s[i];
  if (upper === 0) upper = zeroAt(s, k + 1);
  return (lower + upper) / 2;
}
export function theilSen(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x !== null && x !== undefined && y !== null && y !== undefined);
  if (pts.length < 2) return [null, null, pts.length];
  const m = pts.length; const sl = new Float64Array((m * (m - 1)) / 2); let n = 0;
  for (let i = 0; i < m; i += 1) {
    const x1 = pts[i][0]; const y1 = pts[i][1];
    for (let j = i + 1; j < m; j += 1) { const x2 = pts[j][0]; if (x2 !== x1) { sl[n] = (pts[j][1] - y1) / (x2 - x1); n += 1; } }
  }
  if (!n) return [null, null, pts.length];
  const b = medianOfTyped(sl.subarray(0, n));
  const a = median(pts.map(([x, y]) => y - b * x));
  return [b, a, pts.length];
}
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

export function criticalSpeed(maxObs) {
  const rows = maxObs.filter((o) => [100, 200, 400].includes(o.distance));
  const out = { status: 'insufficient', reason: '', cs: null, dprime: null, points: [], r2: null, three_point: null };
  if (rows.some((o) => !(finite(o.time) && o.time > 0))) return { ...out, status: 'invalid', reason: 'non-positive or non-finite time' };
  const by = {};
  for (const o of [...rows].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))) by[o.distance] = o;
  if (!by[200] || !by[400]) return { ...out, reason: 'missing 200 m or 400 m Max' };
  const a = by[200]; const b = by[400];
  if (a.stroke !== b.stroke || a.pool !== b.pool) return { ...out, status: 'invalid', reason: 'incompatible stroke or pool length between 200 m and 400 m' };
  if (a.date && b.date && Math.abs(dayDiff(a.date, b.date)) > PARAMS.csMaxDateGapDays) return { ...out, reason: `200 m and 400 m Max more than ${PARAMS.csMaxDateGapDays} days apart` };
  if (!(b.time > a.time && 400 / b.time < 200 / a.time)) return { ...out, status: 'invalid', reason: 'contradictory distance-time relation (400 m not slower than 200 m)' };
  const cs = (400 - 200) / (b.time - a.time);
  const dp = 200 - cs * a.time;
  const res = { ...out, points: [200, 400], cs, dprime: dp, dates: [a.date, b.date] };
  if (!(finite(cs) && cs > 0)) return { ...res, cs: null, dprime: null, status: 'invalid', reason: 'non-positive critical speed' };
  if (!(dp > 0) || dp >= 200) return { ...res, cs: null, dprime: null, status: 'invalid', reason: `inadmissible D' (${dp.toFixed(1)} m)` };
  if (by[100] && by[100].stroke === a.stroke && by[100].pool === a.pool) {
    const pts = [[100, by[100].time], [200, a.time], [400, b.time]];
    const mt = pts.reduce((s, [, t]) => s + t, 0) / 3; const md = pts.reduce((s, [d]) => s + d, 0) / 3;
    const sxx = pts.reduce((s, [, t]) => s + (t - mt) ** 2, 0);
    const c3 = sxx ? pts.reduce((s, [d, t]) => s + (t - mt) * (d - md), 0) / sxx : null;
    if (c3) {
      const d3 = md - c3 * mt; const ss = pts.reduce((s, [d]) => s + (d - md) ** 2, 0);
      const r2 = 1 - pts.reduce((s, [d, t]) => s + (d - (c3 * t + d3)) ** 2, 0) / ss;
      res.three_point = { cs: c3, dprime: d3, r2, note: 'comparison only: adding 100 m pulls CS up and D-prime down when the 100 m is anaerobically dominated' };
    }
  }
  if (dp > PARAMS.csDprimePlausibleMaxM) return { ...res, status: 'unreliable', reason: `D' ${dp.toFixed(1)} m above plausibility limit (PROVISIONAL ${PARAMS.csDprimePlausibleMaxM} m)` };
  return { ...res, status: 'valid', reason: '' };
}

export function setFade(times, distance, sendoff = null) {
  const t = times.filter((x) => x); const n = t.length;
  if (n < 4) return null;
  const base = (t[0] + t[1]) / 2;
  const [b, a] = theilSen([...Array(n).keys()], t);
  const resid = t.map((x, i) => x - (a + b * i));
  const noise = ((sd(resid) || 0) / base) * 100;
  const thr = Math.max(PARAMS.onsetMinThresholdPct, 2 * noise);
  let onset = null;
  for (let k = 2; k < n; k += 1) {
    let all = true;
    for (let j = k; j < n; j += 1) if (!(((t[j] - base) / base) * 100 > thr)) { all = false; break; }
    if (all) { onset = k + 1; break; }
  }
  return { loss_pct: (b * (n - 1)) / base * 100, noise_pct: noise, threshold_pct: thr, n, onset_rep: onset,
    onset_censoring: onset ? 'interval' : 'right-censored', onset_interval: onset ? [onset - 1, onset] : [n, null],
    onset_accumulated_m: onset ? (onset - 1) * distance : null, onset_accumulated_min: onset && sendoff ? ((onset - 1) * sendoff) / 60 : null };
}
// Performance (release correction 27-11-2026): the model depends only on the ordered (speed, DPS) pairs and the
// calibration parameters, so an identical input is computed once. Each caller receives its own copy of the result.
const dpsModelMemo = new Map();
export function dpsModel(obs) {
  const pts = obs.filter((o) => o.speed && o.dps).map((o) => [o.speed, o.dps]);
  if (pts.length < PARAMS.dpsModelMinObs) return null;
  const key = `${PARAMS.dpsModelMinObs}|${PARAMS.dpsModelMinSpeedRange}|${pts.join(';')}`;
  if (dpsModelMemo.has(key)) { const hit = dpsModelMemo.get(key); return hit && { ...hit }; }
  const model = dpsModelUncached(pts);
  if (dpsModelMemo.size >= 2000) dpsModelMemo.clear();
  dpsModelMemo.set(key, model);
  return model && { ...model };
}
function dpsModelUncached(pts) {
  const vs = pts.map((p) => p[0]);
  if (Math.max(...vs) - Math.min(...vs) < PARAMS.dpsModelMinSpeedRange) return null;
  const [b, a, n] = theilSen(vs, pts.map((p) => p[1]));
  const res = pts.map(([v, d]) => d - (a + b * v));
  return { a, b, n, vmin: Math.min(...vs), vmax: Math.max(...vs), resid_sd: sd(res) };
}
export function dpsAt(model, v, extrapolate = false) {
  if (!model || v === null || v === undefined) return null;
  if (!extrapolate && !(model.vmin - 1e-9 <= v && v <= model.vmax + 1e-9)) return null;
  return model.a + model.b * v;
}
export function eliteDps(stroke = 'free', sex = 'male', distance = 200) {
  const sx = String(sex).startsWith('f') ? 'female' : 'male';
  const wr = WORLD_RECORD_BASE_TIMES?.LC?.[sx]?.[stroke]?.[distance];
  const sr = ELITE_STROKE_RATE_PROVISIONAL?.[stroke]?.[sx]?.[distance];
  if (!wr || !sr) return null;
  return ((distance / wr) * 60) / sr;
}
export function dpsRetention(rows, model) {
  const r = [...rows].sort((a, b) => (a.rep || 0) - (b.rep || 0)).filter((o) => o.dps && o.speed);
  if (r.length < 4) return null;
  if (r.reduce((s, o) => s + (o.cycles || 0), 0) / r.length < PARAMS.robustnessMinCyclesPerRep) return null;
  const k = Math.max(1, Math.floor(r.length / 3));
  const e = r.slice(0, k); const l = r.slice(-k);
  const de = e.reduce((s, o) => s + o.dps, 0) / k; const dl = l.reduce((s, o) => s + o.dps, 0) / k;
  const ve = e.reduce((s, o) => s + o.speed, 0) / k; const vl = l.reduce((s, o) => s + o.speed, 0) / k;
  const slope = model ? model.b : 0;
  const adj = (dl - de) - slope * (vl - ve);
  const cyc = r.reduce((s, o) => s + (o.cycles || 0), 0) / r.length;
  return { loss_pct: (-adj / de) * 100, raw_change_pct: ((dl - de) / de) * 100, speed_change_pct: ((vl - ve) / ve) * 100,
    quantisation_resolution_pct: cyc ? 100 / cyc / Math.sqrt(k) : null, speed_adjusted: Boolean(model), n: r.length };
}
export function durabilityExcess(times, distance) {
  const t = times.filter((x) => x); const n = t.length;
  if (n < 8) return null;
  const base = (t[0] + t[1]) / 2;
  const loss = t.map((x) => (1 - base / x) * 100);
  const km = [...Array(n).keys()].map((i) => (i * distance) / 1000);
  const fit = (xs, ys) => {
    const m = xs.length; const mx = xs.reduce((s, x) => s + x, 0) / m; const my = ys.reduce((s, y) => s + y, 0) / m;
    const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    const b = sxx ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx : 0;
    return [b, xs.reduce((s, x, i) => s + (ys[i] - (my + b * (x - mx))) ** 2, 0)];
  };
  const [b1, sse1] = fit(km, loss);
  let best = null;
  for (let k = 3; k < n - 2; k += 1) {
    const [be, se] = fit(km.slice(0, k + 1), loss.slice(0, k + 1)); const [bl, sl] = fit(km.slice(k), loss.slice(k));
    if (best === null || se + sl < best[0]) best = [se + sl, k, be, bl];
  }
  const [sse2, k, be, bl] = best;
  const h = Math.floor(n / 2);
  const [eh] = fit(km.slice(0, h + 1), loss.slice(0, h + 1)); const [lh] = fit(km.slice(h), loss.slice(h));
  const out = { excess_pct_per_km: lh - eh, early_rate_pct_per_km: eh, late_rate_pct_per_km: lh, n, total_loss_pct: loss[n - 1], overall_loss_pct_per_km: b1 };
  if (sse1 > 0 && (sse1 - sse2) / sse1 >= 0.30 && bl > be) {
    Object.assign(out, { onset_rep: k + 1, onset_interval: [k, k + 1], onset_accumulated_m: k * distance, censoring: 'interval' });
  } else {
    Object.assign(out, { onset_rep: null, onset_interval: [n, null], onset_accumulated_m: null, censoring: 'right-censored (no onset within the set)' });
  }
  return out;
}
