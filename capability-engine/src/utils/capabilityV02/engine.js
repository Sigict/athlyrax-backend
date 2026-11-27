// AthlyraX capability engine v0.2 (EXPERIMENTAL, isolated branch) - evidence extraction, weighting, radars,
// development, decisions. Port of the research reference src/candidate/engine.py (v0.2).
//
// Design rules carried from the reference:
//  R1 nothing is multiplied by speed; R2 each timed test feeds ONE domain's primary score; R3 level, capability
//  characteristics, development and confidence are separate outputs; R4 a domain without qualifying evidence is NOT
//  MEASURED (never zero, never filled from another radar); R5 physiological names only where a physiological measurement
//  exists. Model C: Expression and capacity-related Repeatability are reported side by side and NEVER combined.
//
// Intentional app departures (documented in docs/CAPABILITY_V02_DEPARTURES.md):
//  A-1 informal coach observations are context only (Book 3 p. 293); they never enter Technical Control.
//  A-2 the Technical Control value is labelled a PROVISIONAL rating index.
//  A-3 the Training radar's efficiency / robustness entries report recorded-intent exposure or "INTENT NOT RECORDED".
import { PARAMS, CALIBRATION_VERSION, APP_CALIBRATION_VERSION, recencyWeight, linearIndexRaw } from './calibration.js';
import { buildLedger, summarise, workloadChange, trainingRadar, markConstraintVaried } from './ledger.js';
import { pyRound } from './ingest.js';
import { waPoints, criticalSpeed, setFade, dpsModel, dpsAt, eliteDps, dpsRetention, sd, durabilityExcess } from './metrics.js';

export const ENGINE_VERSION = 'AthlyraX Candidate Engine v0.2.1 (O-1 delivery rule, O-2 battery boundary, repeatability development; 2026-11-25) - JS port app.2';
export const BATTERY_PROTOCOLS = ['M25', 'M50', 'M100', 'M200', 'M400', 'R8x25', 'R8x50', 'R8x100', 'A5x400'];
const itemProtocol = (i) => i.raw.protocol || String(i.raw.group || '').split('|')[0];
export const DOMAINS = ['technical_control', 'efficiency', 'robustness_of_efficiency', 'aerobic_capacity', 'anaerobic_capacity',
  'power_speed_expression', 'adaptability', 'durability'];
export const LEVEL_DOMAINS = { power_speed_expression: ['M25', 'M50', 50], anaerobic_capacity: ['M100', null, 100], aerobic_capacity: ['M400', null, 400] };
export const CAPACITY_PROTOCOLS = { power_speed_expression: ['R8x25', 'set:SP'], anaerobic_capacity: ['R8x50', 'set:LT'], aerobic_capacity: ['R8x100', 'set:EN2', 'set:EN3'] };
const SOURCES = ['training', 'testing', 'competition'];

// ---------------------------------------------------------------- small helpers (Python semantics)
const DAY = 86400000;
const toMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
export const days = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
const addDays = (iso, n) => new Date(toMs(iso) + n * DAY).toISOString().slice(0, 10);
export function mean(v) { const x = v.filter((a) => a !== null && a !== undefined); return x.length ? x.reduce((s, a) => s + a, 0) / x.length : null; }
const pyStr = (x) => (x === null || x === undefined ? 'None' : x === true ? 'True' : x === false ? 'False' : String(x));
const pyRepr = (x) => (typeof x === 'string' ? `'${x}'` : pyStr(x));
const cmpScalar = (a, b) => {
  const na = a === null || a === undefined; const nb = b === null || b === undefined;
  if (na || nb) return na === nb ? 0 : na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};
export const cmpTuple = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i += 1) { const c = cmpScalar(a[i], b[i]); if (c) return c; } return 0; };
// Python round(x, d): half to even (EQ run 2 found Math.round's half-up rule differing on exact halves, e.g. 3.125).
const round = (x, d) => pyRound(x, d);
const truthy = (x) => !(x === null || x === undefined || x === 0 || x === '' || x === false || Number.isNaN(x));
const maxStr = (arr) => arr.reduce((m, x) => (m === null || x > m ? x : m), null);
const groupBy = (arr, keyFn) => { const m = new Map(); for (const x of arr) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };

export function item(domain, value, source, date, key, signal = 1.0, raw = {}) {
  return { domain, value, source, date, key, signal, raw };
}

// ---------------------------------------------------------------- evidence extraction
export function groupSets(obs) {
  const g = new Map();
  for (const o of obs) if (o.set_id && o.time) { if (!g.has(o.set_id)) g.set(o.set_id, []); g.get(o.set_id).push(o); }
  for (const rows of g.values()) rows.sort((a, b) => (a.rep || 0) - (b.rep || 0));
  return new Map([...g.entries()].sort((x, y) => cmpTuple([x[1][0].date || '', String(x[0])], [y[1][0].date || '', String(y[0])])));
}

export function levelItems(obs, sex) {
  const items = [];
  for (const o of obs) {
    const p = o.protocol || '';
    let dom = null;
    if (o.source === 'testing' && o.rep === 1) dom = { M25: 'power_speed_expression', M50: 'power_speed_expression', M100: 'anaerobic_capacity', M400: 'aerobic_capacity' }[p] || null;
    else if (o.source === 'competition') {
      const d = Math.trunc(o.distance || 0);
      dom = d <= 50 ? 'power_speed_expression' : d <= 100 ? 'anaerobic_capacity' : d >= 400 ? 'aerobic_capacity' : null;
    }
    if (!dom) continue;
    const st = o.stroke !== 'unknown' ? o.stroke : 'free';
    const pts = waPoints(o.time, o.distance, st, PARAMS.speedReferenceSex, o.pool);
    if (pts === null) continue;
    items.push(item(dom, pts / 10, o.source, o.date, o.mkey, 1.0, { protocol: p, group: `${p}|${o.pool}|${o.stroke}`, time: o.time, distance: o.distance,
      wa_points_own_sex: waPoints(o.time, o.distance, st, sex, o.pool), speed: o.speed }));
  }
  const out = [];
  for (const dom of [...new Set(items.map((i) => i.domain))]) {
    const rows = items.filter((i) => i.domain === dom).sort((a, b) => b.value - a.value);
    if (rows.length >= 2 && (rows[0].value / rows[1].value) ** (1 / 3) > PARAMS.speedOutlierRatio) {
      rows[0] = { ...rows[0], excluded: 'unconfirmed outlier (>10 % faster than every other swim)' };
    }
    out.push(...rows);
  }
  return out;
}

export function technicalItems(obs) {
  const items = []; const comp = {};
  const [lo, hi] = PARAMS.technicalRatingScale;
  const raw = obs.filter((o) => o.kind === 'rating').map((o, i) => [o, i]).sort((a, b) => cmpTuple([a[0].date, a[1]], [b[0].date, b[1]])).map(([o]) => o);
  const ratings = []; const used = new Set();
  raw.forEach((o, i) => {
    if (used.has(i)) return;
    const grp = [o, ...raw.filter((p, j) => j > i && !used.has(j) && p.protocol === o.protocol && p.rater !== o.rater && Math.abs(days(o.date, p.date)) <= 7)];
    raw.forEach((p, j) => { if (grp.includes(p)) used.add(j); });
    if (grp.length === 1) { ratings.push(o); return; }
    const keys = [...new Set(grp.flatMap((g) => Object.keys(g.items)))];
    const merged = { ...o, items: Object.fromEntries(keys.map((k) => [k, mean(grp.filter((g) => k in g.items).map((g) => g.items[k]))])),
      rater: grp.map((g) => pyStr(g.rater)).sort().join('+'), n_raters: grp.length, date: maxStr(grp.map((g) => g.date)) };
    ratings.push(merged);
  });
  const perKind = {};
  for (const o of ratings) perKind[o.protocol] = (perKind[o.protocol] || 0) + 1;
  const byKind = new Map();
  for (const o of ratings) {
    const vals = Object.values(o.items); const m = vals.reduce((s, a) => s + a, 0) / vals.length;
    const base = o.protocol === 'coach-observation' ? PARAMS.coachObservationWeight : 1.0;
    const sig = PARAMS.technicalAggregation === 'equal_kind' ? base / perKind[o.protocol] : base;
    const share = o.n_items ? o.variable_items / o.n_items : null;
    if (!byKind.has(o.protocol)) byKind.set(o.protocol, []);
    byKind.get(o.protocol).push([o.date, m, share]);
    items.push(item('technical_control', ((m - lo) / (hi - lo)) * 100, o.source, o.date, o.mkey, sig, { protocol: o.protocol, group: o.protocol,
      mean_rating: m, n_items: o.n_items, variable_share: share, rater: o.rater }));
  }
  comp.technical_quality_by_kind = Object.fromEntries([...byKind].map(([k, v]) => [k, round([...v].sort(cmpTuple)[v.length - 1][1], 2)]));
  comp.technical_consistency_variable_share_by_kind = Object.fromEntries([...byKind].map(([k, v]) => [k, mean(v.map((x) => x[2]))]));
  comp.technical_rating_spread_by_kind = Object.fromEntries([...byKind].map(([k, v]) => [k, sd(v.map((x) => x[1]))]));
  const pairs = [];
  const rat = obs.filter((o) => o.kind === 'rating' && String(o.protocol).startsWith('technical'));
  rat.forEach((a, i) => {
    for (const b of rat.slice(i + 1)) {
      if (a.protocol === b.protocol && a.rater !== b.rater && Math.abs(days(a.date, b.date)) <= 7) {
        const common = Object.keys(a.items).filter((k) => k in b.items);
        if (common.length) pairs.push(mean(common.map((k) => Math.abs(a.items[k] - b.items[k]))));
      }
    }
  });
  comp.inter_rater_mean_abs_difference = mean(pairs);
  comp.inter_rater_status = pairs.length ? 'measured' : 'single rater or no repeat: reliability UNKNOWN';
  comp.value_label = 'PROVISIONAL rating index (structured coach ratings rescaled 1-5 -> 0-100; not a calibrated measurement)';
  return [items, comp];
}

export function efficiencyRobustness(obs, sex, windowObs) {
  const comps = {}; const effItems = []; const robItems = [];
  const fresh = (o) => (o.nreps || 1) <= 1 || (o.rep || 1) <= Math.max(1, Math.floor((o.nreps || 1) / 3));
  const freeSc = (o) => o.dps && o.speed && o.stroke === 'free' && (o.pool || 25) === 25;
  const swim = windowObs.filter((o) => freeSc(o) && fresh(o));
  const robModel = dpsModel(windowObs.filter(freeSc));
  const model = dpsModel(swim);
  comps.dps_model = model;
  const m200 = windowObs.filter((o) => o.protocol === 'M200' && o.speed).sort((a, b) => cmpScalar(a.date, b.date));
  const vref = m200.length ? m200[m200.length - 1].speed : null;
  comps.reference_speed_m_s = vref;
  const eDps = eliteDps('free', sex, 200);
  if (model && vref) {
    const d = dpsAt(model, vref);
    if (d === null) comps.efficiency_status = 'reference speed outside the observed speed range: not interpolated (no extrapolation)';
    else {
      for (const src of SOURCES) {
        const sub = dpsModel(swim.filter((o) => o.source === src));
        const ds = sub ? dpsAt(sub, vref) : null;
        if (ds !== null) {
          effItems.push(item('efficiency', (100 * ds) / eDps, src, maxStr(swim.filter((o) => o.source === src).map((o) => o.date)), `dpsmodel:${src}`, 1.0,
            { dps_at_ref: ds, elite_dps: eDps, n: sub.n, stroke_index_at_ref: vref * ds, stroke_rate_at_ref: (vref * 60) / ds }));
        }
      }
      Object.assign(comps, { dps_at_reference_m: d, elite_dps_m: eDps, stroke_index_at_reference: vref * d,
        stroke_rate_at_reference_cpm: (vref * 60) / d, kinematic_consistency_resid_pct: (model.resid_sd / d) * 100 });
      if (!effItems.length) {
        const cnt = (s) => swim.filter((o) => o.source === s).length;
        const src = SOURCES.reduce((best, s) => (cnt(s) > cnt(best) ? s : best), SOURCES[0]);
        effItems.push(item('efficiency', (100 * d) / eDps, src, maxStr(swim.map((o) => o.date)), 'dpsmodel:pooled', 0.85, { dps_at_ref: d, elite_dps: eDps, n: model.n }));
      }
    }
  } else {
    comps.efficiency_status = `not identifiable: ${!vref ? 'no 200 m Max speed' : 'too few stroke-counted swims or speed range too narrow'}`;
  }
  comps.development_items = [];
  const allswim = obs.filter((o) => freeSc(o) && fresh(o));
  const gmodel = dpsModel(allswim);
  if (gmodel && eDps) {
    const sp = allswim.map((o) => o.speed).sort((a, b) => a - b); const v0 = sp[Math.floor(sp.length / 2)];
    const sess = new Map();
    for (const o of allswim) {
      if (gmodel.vmin <= o.speed && o.speed <= gmodel.vmax) { const k = o.set_id || o.mkey; if (!sess.has(k)) sess.set(k, []); sess.get(k).push(o); }
    }
    for (const [sid, rows] of [...sess.entries()].sort((x, y) => cmpTuple([x[1][0].date, String(x[0])], [y[1][0].date, String(y[0])]))) {
      const dv = mean(rows.map((o) => o.dps + gmodel.b * (v0 - o.speed)));
      comps.development_items.push(item('efficiency', (100 * dv) / eDps, 'session', rows[0].date, `sess:${sid}`, 1.0,
        { group: `${pyStr(rows[0].protocol)}|${pyStr(rows[0].set_name)}`, dps_at_fixed_speed: dv, fixed_speed: v0 }));
    }
  }
  const recUw = allswim.filter((o) => o.underwater_recorded);
  comps.underwater_control = allswim.length ? `${recUw.length}/${allswim.length} swims with recorded underwater distance` : 'no swims';
  comps.glide_confound_warning = recUw.length < allswim.length
    ? 'Underwater / push-off distance not recorded: a longer underwater phase or more gliding would appear as longer DPS.'
    : 'underwater distance recorded on every swim';
  comps.underwater_basis = recUw.length < allswim.length ? 'ESTIMATED (5 m push-off allowance per wall; dive breakout) where not recorded' : 'recorded';
  comps.construct = 'Stroke length (distance per cycle) at a matched speed: a KINEMATIC indicator, not energy cost';
  comps.economy_metabolic = 'NOT MEASURED (needs VO2 / lactate at fixed speed)';
  comps.propulsive_efficiency = 'NOT MEASURED (needs kinematic/kinetic analysis)';
  for (const [sid, rows] of groupSets(windowObs)) {
    const r = dpsRetention(rows, model || robModel);
    if (r === null) continue;
    const trend = r.speed_change_pct > 1 ? 'increasing' : r.speed_change_pct < -1 ? 'decreasing' : 'stable';
    robItems.push(item('robustness_of_efficiency', linearIndexRaw(r.loss_pct, PARAMS.dpsLossIndexSlope), rows[0].source, rows[0].date,
      `set:${pyStr(sid)}`, r.speed_adjusted ? 1.0 : 0.6, { speed_trend: trend, group: `${rows[0].protocol ?? ''}|${pyStr(rows[0].set_name)}`, ...r }));
  }
  for (const o of windowObs) {
    const sp = (o.splits || []).filter((s) => s.time && s.cycles);
    if (o.source === 'competition' && sp.length >= 2 && o.split_length) {
      const L = o.split_length; const allow = PARAMS.pushOffAllowanceM * Math.max(1, L / (o.pool || 25));
      const firstAllow = allow + (o.breakout_distance || 10.0) - PARAMS.pushOffAllowanceM;
      const d0 = (L - firstAllow) / sp[0].cycles; const d1 = (L - allow) / sp[sp.length - 1].cycles;
      const v0 = L / sp[0].time; const v1 = L / sp[sp.length - 1].time;
      const adj = (d1 - d0) - ((model || robModel || {}).b || 0) * (v1 - v0);
      const loss = (-adj / d0) * 100;
      robItems.push(item('robustness_of_efficiency', linearIndexRaw(loss, PARAMS.dpsLossIndexSlope), 'competition', o.date, o.mkey, 0.8,
        { loss_pct: loss, group: o.protocol, note: 'first vs last split; start/turn allowance approximate' }));
    }
  }
  return [effItems, robItems, comps];
}

export function fadeItems(windowObs, plan, cs = null) {
  const out = {}; const dur = [];
  const map = { 'set:SP': 'power_speed_expression', 'set:LP': 'anaerobic_capacity', 'set:LT': 'anaerobic_capacity', 'set:EN2': 'aerobic_capacity', 'set:EN3': 'aerobic_capacity' };
  for (const [sid, rows] of groupSets(windowObs)) {
    const o = rows[0]; const p = o.protocol || '';
    const times = rows.map((r) => r.time);
    const f = setFade(times, o.distance, o.sendoff);
    if (f === null) continue;
    const minutes = o.sendoff ? (rows.length * o.sendoff) / 60 : times.reduce((s, t) => s + t, 0) / 60;
    if (p === 'A5x400' || minutes >= PARAMS.durabilityMinMinutes) {
      let x = p !== 'A5x400' ? durabilityExcess(times, o.distance) : null;
      if (x === null) {
        const km = ((rows.length - 1) * o.distance) / 1000;
        x = { excess_pct_per_km: km ? Math.max(0.0, f.loss_pct / km) : null, overall_loss_pct_per_km: km ? f.loss_pct / km : null, onset_rep: f.onset_rep,
          onset_interval: f.onset_interval, onset_accumulated_m: f.onset_accumulated_m, censoring: f.onset_censoring, total_loss_pct: f.loss_pct,
          note: '5 repetitions: total loss per km (short-term fade not separable)' };
      }
      const rel = cs ? mean(rows.map((r) => r.speed)) / cs : null;
      const iwM = cs ? rows.slice(0, -1).reduce((s, r) => s + r.distance * (r.speed / cs) ** 2, 0) : null;
      const basis = PARAMS.durabilityBasis === 'preservation' ? x.overall_loss_pct_per_km : x.excess_pct_per_km;
      dur.push(item('durability', linearIndexRaw(basis, PARAMS.durabilityIndexSlopePerKm), o.source, o.date, `set:${pyStr(sid)}`, p !== 'A5x400' ? 1.0 : 0.8,
        { kind: 'within-set accumulated workload', minutes, group: `${p}|${pyStr(o.set_name)}`, accumulated_m: (rows.length - 1) * o.distance,
          relative_intensity_cs: rel, intensity_weighted_m: iwM, duration_band: minutes < 40 ? '20-40 min' : '40+ min', ...x }));
      continue;
    }
    const dom = plan[p] || map[p];
    if (dom) {
      if (!out[dom]) out[dom] = [];
      out[dom].push(item(dom, linearIndexRaw(f.loss_pct, PARAMS.fadeIndexSlope), o.source, o.date, `set:${pyStr(sid)}`, 1.0, { protocol: p, ...f }));
    }
  }
  return [out, dur];
}

export function durabilityProtocolItems(windowObs) {
  const fresh = windowObs.filter((o) => String(o.protocol ?? '').startsWith('DUR-FL:fresh'));
  const loaded = windowObs.filter((o) => String(o.protocol ?? '').startsWith('DUR-FL:loaded'));
  const items = [];
  for (const l of loaded) {
    let f = null;
    for (const c of fresh) if (c.distance === l.distance && Math.abs(days(c.date, l.date)) <= 7 && (f === null || Math.abs(days(c.date, l.date)) < Math.abs(days(f.date, l.date)))) f = c;
    if (!f || !l.preload_m) continue;
    const loss = ((l.time - f.time) / f.time) * 100;
    const rate = loss / (l.preload_m / 1000);
    items.push(item('durability', linearIndexRaw(rate, PARAMS.durabilityIndexSlopePerKm), 'testing', l.date, l.mkey, 1.0, { group: 'DUR-FL',
      kind: 'fresh-vs-loaded protocol', loss_pct: loss, loss_per_km_pct: rate, preload_m: l.preload_m, preload_min: l.preload_min ?? null,
      preload_composition: l.preload_composition || 'NOT RECORDED (intensity of the preload unknown: results comparable only for identical preloads)' }));
  }
  return items;
}

export function physiologicalDurability(windowObs) {
  const res = [];
  for (const [sid, rows] of groupSets(windowObs)) {
    const hr = rows.filter((r) => r.heart_rate);
    if (hr.length < 4) continue;
    const k = Math.max(1, Math.floor(hr.length / 3));
    const v0 = mean(hr.slice(0, k).map((r) => r.speed)); const v1 = mean(hr.slice(-k).map((r) => r.speed));
    if (Math.abs(v1 - v0) / v0 > 0.01) continue;
    const h0 = mean(hr.slice(0, k).map((r) => r.heart_rate)); const h1 = mean(hr.slice(-k).map((r) => r.heart_rate));
    const km = ((hr.length - k) * rows[0].distance) / 1000;
    res.push({ set: sid, hr_drift_bpm_per_km: km ? (h1 - h0) / km : null, date: rows[0].date });
  }
  return res;
}

export function adaptabilityItems(windowObs, allObs) {
  const sets = groupSets(allObs.filter((o) => o.source === 'training'));
  const sig = new Map();
  for (const [sid, rows] of sets) {
    const o = rows[0];
    if (!o.sendoff || rows.length < 3) continue;
    const k = `(${[o.distance, rows.length, o.stroke, o.energy ?? null].map(pyRepr).join(', ')})`;
    if (!sig.has(k)) sig.set(k, []);
    sig.get(k).push([o.date, o.sendoff, mean(rows.map((r) => r.speed)), mean(rows.map((r) => r.dps)), sid]);
  }
  const items = [];
  const wdates = windowObs.map((o) => o.date);
  const lo = wdates.length ? wdates.reduce((m, x) => (x < m ? x : m)) : null;
  const cont = PARAMS.adaptabilityMethod === 'continuous';
  for (const [k, lst] of sig) {
    lst.sort(cmpTuple);
    lst.forEach((a, i) => {
      for (const b of lst.slice(i + 1)) {
        if (days(a[0], b[0]) > PARAMS.adaptabilityPairWindowDays) break;
        const ch = ((b[1] - a[1]) / Math.max(a[1], b[1])) * 100;
        if (Math.abs(ch) < (cont ? PARAMS.adaptabilityMinChangeContinuousPct : PARAMS.adaptabilityMinSendoffChangePct)) continue;
        const [tight, loose] = ch < 0 ? [b, a] : [a, b];
        if (lo && (a[0] > b[0] ? a[0] : b[0]) < lo) continue;
        const resp = ((tight[2] - loose[2]) / loose[2]) * 100;
        const dpsResp = truthy(tight[3]) && truthy(loose[3]) ? ((tight[3] - loose[3]) / loose[3]) * 100 : null;
        const norm = cont ? -resp / (Math.abs(ch) / 10) : -resp;
        const wsig = cont ? Math.min(1.0, Math.abs(ch) / 10) : 1.0;
        items.push(item('adaptability', linearIndexRaw(norm, PARAMS.adaptabilityIndexSlope), 'training', a[0] > b[0] ? a[0] : b[0],
          `pair:${pyStr(tight[4])}:${pyStr(loose[4])}`, wsig, { sendoff_change_pct: ((tight[1] - loose[1]) / loose[1]) * 100,
            speed_response_pct: resp, dps_response_pct: dpsResp, gap_days: days(a[0], b[0]), signature: k }));
      }
    });
  }
  return items;
}

// v0.2.3 (owner-approved release correction 27-11-2026). Port of stability_score / cv_pct / stability_items / retest_items.
export function stabilityScore(cvPct) {
  const a = PARAMS.stabilityCvAnchors;
  const v = Math.max(0, cvPct);
  if (v <= a[0][0]) return a[0][1];
  for (let i = 1; i < a.length; i += 1) {
    const [lx, ly] = a[i - 1]; const [ux, uy] = a[i];
    if (v <= ux) { const t = (v - lx) / Math.max(0.0001, ux - lx); return ly + (uy - ly) * t; }
  }
  return a[a.length - 1][1];
}
function cvPct(values) {
  const v = values.filter(truthy);
  if (v.length < 2) return null;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  const s = sd(v);
  return m > 0 && s !== null ? (s / m) * 100 : null;
}
// Technical Control from measured consistency: repetition pace and stroke-count stability within a test or training set
// (>= 3 repetitions) and segment pace stability within a race (splits after the start segment).
export function stabilityItems(hist) {
  const items = []; const n = PARAMS.stabilityMinValues;
  for (const [sid, rows] of groupSets(hist.filter((o) => o.source === 'training' || o.source === 'testing'))) {
    const o = rows[0];
    if (rows.length < n) continue;
    const times = rows.filter((r) => truthy(r.time)).map((r) => r.time);
    const cyc = rows.filter((r) => truthy(r.cycles)).map((r) => r.cycles);
    if (times.length >= n) {
      const c = cvPct(times);
      if (c !== null) items.push(item('technical_control', stabilityScore(c), o.source, o.date, `stab:pace:${pyStr(sid)}`, 1.0,
        { protocol: o.protocol ?? null, group: 'pace-stability', cv_pct: c, n_values: times.length }));
    }
    if (cyc.length >= n) {
      const c = cvPct(cyc);
      if (c !== null) items.push(item('technical_control', stabilityScore(c), o.source, o.date, `stab:strokes:${pyStr(sid)}`, 1.0,
        { protocol: o.protocol ?? null, group: 'stroke-count-stability', cv_pct: c, n_values: cyc.length }));
    }
  }
  for (const o of hist) {
    if (o.source !== 'competition') continue;
    const cum = (o.splits || []).map((x) => x?.time);
    if (cum.length < n + 1 || cum.some((t) => !truthy(t))) continue;
    const seg = cum.slice(1).map((b, i) => b - cum[i]);
    if (seg.some((x) => x <= 0)) continue;
    const c = cvPct(seg);
    if (c !== null) items.push(item('technical_control', stabilityScore(c), 'competition', o.date, `stab:race:${pyStr(o.mkey)}`, 1.0,
      { protocol: o.protocol ?? null, group: 'race-segment-stability', cv_pct: c, n_values: seg.length }));
  }
  return items;
}
// Adaptability from the response to a repeated demand: the same test protocol (stroke, pool) or the same race event
// (distance, stroke, pool) on its next occasion within retestMaxGapDays. 50 = no change (previous AthlyraX rule).
export function retestItems(hist) {
  const by = new Map();
  const add = (key, source, protocol, date, v) => {
    if (!by.has(key)) by.set(key, { source, protocol: protocol ?? null, dates: new Map() });
    const g = by.get(key); if (!g.dates.has(date)) g.dates.set(date, []); g.dates.get(date).push(v);
  };
  for (const [, rows] of groupSets(hist.filter((o) => o.source === 'testing'))) {
    const o = rows[0];
    const sp = mean(rows.filter((r) => truthy(r.speed)).map((r) => r.speed));
    if (truthy(sp)) add(`testing|${pyStr(o.protocol)}|${pyStr(o.stroke)}|${pyStr(o.pool)}`, 'testing', o.protocol, o.date, sp);
  }
  for (const o of hist) {
    if (o.source === 'competition' && truthy(o.speed)) add(`competition|${pyStr(o.distance)}|${pyStr(o.stroke)}|${pyStr(o.pool)}`, 'competition', o.protocol, o.date, o.speed);
  }
  const items = [];
  for (const [k, g] of by) {
    const dates = [...g.dates.keys()].sort();
    for (let i = 0; i + 1 < dates.length; i += 1) {
      const a = dates[i]; const b = dates[i + 1];
      if (days(a, b) > PARAMS.retestMaxGapDays) continue;
      const va = g.source === 'competition' ? Math.max(...g.dates.get(a)) : mean(g.dates.get(a));
      const vb = g.source === 'competition' ? Math.max(...g.dates.get(b)) : mean(g.dates.get(b));
      const ch = ((vb - va) / va) * 100;
      items.push(item('adaptability', 50 + PARAMS.adaptabilityIndexSlope * (ch / PARAMS.smallestWorthwhileChangePct), g.source, b,
        `retest:${k}:${a}:${b}`, 1.0, { protocol: g.protocol, group: 'repeated-demand', speed_change_pct: ch, gap_days: days(a, b) }));
    }
  }
  return items;
}

export function adaptabilityExtras(windowObs, latest) {
  const out = { race_transfer: [], intensity_steps: [] };
  const tests = new Map(); for (const o of latest.values()) tests.set(o.distance, o);
  for (const o of windowObs) {
    if (o.source === 'competition' && tests.has(o.distance) && Math.abs(days(o.date, tests.get(o.distance).date)) <= PARAMS.adaptabilityPairWindowDays) {
      const t = tests.get(o.distance);
      out.race_transfer.push({ distance: o.distance, race_time: o.time, test_time: t.time, race_vs_test_pct: ((t.time - o.time) / t.time) * 100,
        note: 'race includes a dive start; test start in-water per catalogue' });
    }
  }
  const order = { EN1: 1, EN2: 2, EN3: 3 };
  const sig = new Map();
  for (const [, rows] of groupSets(windowObs.filter((o) => o.source === 'training'))) {
    const o = rows[0];
    if (o.energy in order) {
      const k = JSON.stringify([o.distance, rows.length, o.stroke, o.sendoff ?? null]);
      if (!sig.has(k)) sig.set(k, []);
      sig.get(k).push([o.date, o.energy, mean(rows.map((r) => r.speed))]);
    }
  }
  for (const lst of sig.values()) {
    lst.sort(cmpTuple);
    lst.forEach((a, i) => {
      for (const b of lst.slice(i + 1)) {
        if (days(a[0], b[0]) > PARAMS.adaptabilityPairWindowDays) break;
        if (a[1] !== b[1]) {
          const [l, h] = order[a[1]] < order[b[1]] ? [a, b] : [b, a];
          out.intensity_steps.push({ from: l[1], to: h[1], speed_change_pct: ((h[2] - l[2]) / l[2]) * 100 });
        }
      }
    });
  }
  out.not_available = 'stroke-rate targets, technical constraints, breathing patterns: no structured field in the data model';
  return out;
}

export function trainingExecution(windowObs, cs, refspeed, weeks) {
  const bands = { EN1: [0.78, 0.92], EN2: [0.92, 1.00], EN3: [1.00, 1.08] };
  const rows = []; let iw = 0.0; const sets = [];
  for (const [sid, rs] of groupSets(windowObs.filter((o) => o.source === 'training'))) {
    const o = rs[0]; const v = mean(rs.map((r) => r.speed)); const e = o.energy; const t = mean(rs.map((r) => r.time));
    const rest = o.sendoff ? o.sendoff - t : null;
    if (cs) iw += rs.reduce((s, r) => s + r.distance * (r.speed / cs) ** 2, 0);
    let rel = null; let ok = null;
    if (e in bands) { if (cs) { const [l, h] = bands[e]; rel = v / cs; ok = l <= rel && rel <= h; } }
    else if (['SP', 'LP', 'LT'].includes(e) && refspeed(o.distance)) { rel = v / refspeed(o.distance); ok = rel >= 0.90; }
    sets.push({ set: sid, energy: e ?? null, distance: o.distance, reps: rs.length, relative_speed: rel, within_band: ok,
      sendoff_s: o.sendoff ?? null, mean_rest_s: rest, rest_flag: rest !== null && rest < 0 ? 'IMPOSSIBLE' : null });
    if (ok !== null) rows.push([e, ok, rel]);
  }
  const by = {}; const relBy = {};
  for (const [e, ok, rel] of rows) { (by[e] ||= []).push(ok); (relBy[e] ||= []).push(rel); }
  const med = Object.fromEntries(Object.entries(relBy).map(([e, v]) => [e, [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]]));
  const flags = [];
  for (const [l, h] of [['EN1', 'EN2'], ['EN2', 'EN3'], ['EN1', 'EN3']]) {
    if (l in med && h in med && med[l] >= med[h]) flags.push(`label-intensity inconsistency: median ${l} relative speed ${med[l].toFixed(3)} >= ${h} ${med[h].toFixed(3)}`);
  }
  return { compliance_by_code: Object.fromEntries(Object.entries(by).map(([e, v]) => [e, round(v.filter(Boolean).length / v.length, 3)])),
    median_relative_speed_by_code: med, sets_assessed: rows.length, sets, flags,
    en_compliance_status: cs ? 'assessed' : 'UNKNOWN (no valid critical speed)',
    intensity_weighted_m_per_week: cs && weeks ? iw / weeks : null,
    bands_note: 'PROVISIONAL bands relative to CS (EN) or own max speed at that distance (SP/LP/LT >= 90 %)' };
}

export function taskStructureAudit(windowObs, refspeed) {
  const rows = [];
  for (const [sid, rs] of groupSets(windowObs)) {
    const o = rs[0];
    if (o.source !== 'training' || !['LP', 'LT', 'SP'].includes(o.energy) || !o.sendoff) continue;
    const work = mean(rs.map((r) => r.time)); const rest = o.sendoff - work;
    const rs0 = refspeed(o.distance);
    const rel = rs0 ? mean(rs.map((r) => r.speed)) / rs0 : null;
    let cls;
    if (work <= 20 && rest >= 3 * work) cls = 'SP-type (short maximal, long recovery)';
    else if (work > 20 && work <= 120 && rest >= 2 * work) cls = 'LP-type (high intensity, long recovery)';
    else if (work > 20 && work <= 180 && rest <= 1.0 * work) cls = 'LT-type (high intensity, incomplete recovery)';
    else cls = 'structure does not match a high-intensity task type';
    rows.push({ set: sid, label: o.energy, work_s: work, rest_s: rest, work_rest_ratio: work ? rest / work : null, relative_speed: rel, structure_class: cls, agrees: cls.startsWith(o.energy) });
  }
  return rows;
}

// ---------------------------------------------------------------- weighting, development
export function windowFilter(items, source, asof, start) {
  const its = items.filter((i) => i.source === source && !i.excluded && i.value !== null && i.value !== undefined && start <= i.date && i.date <= asof);
  if (source === 'training') return its.filter((i) => days(i.date, asof) <= 42);
  if (source === 'testing') {
    // v0.2.1 (O-2): the last battery is defined by the fixed battery only; supplementary assessments never move it.
    const bat = its.filter((i) => BATTERY_PROTOCOLS.includes(itemProtocol(i))).map((i) => i.date);
    const last = bat.length ? maxStr(bat) : maxStr(its.map((i) => i.date));
    return its.filter((i) => last && days(i.date, last) <= 14);
  }
  if (source === 'competition') {
    const ds = [...new Set(its.map((i) => i.date))].sort().slice(-2);
    return its.filter((i) => ds.includes(i.date));
  }
  return its;
}

export function weighted(items, asof) {
  if (!items.length) return [null, 0, null];
  const w = items.map((i) => recencyWeight(days(i.date, asof)) * i.signal);
  const sw = w.reduce((a, b) => a + b, 0);
  if (sw === 0) return [null, 0, null];
  let m = w.reduce((a, wi, k) => a + wi * items[k].value, 0) / sw;
  m = Math.max(0.0, Math.min(100.0, m));
  const s = sd(items.map((i) => i.value));
  return [m, items.length, s !== null ? s / Math.sqrt(items.length) : null];
}

const TCRIT = { 1: 6.31, 2: 2.92, 3: 2.35, 4: 2.13, 5: 2.02, 6: 1.94, 7: 1.89, 8: 1.86, 9: 1.83, 10: 1.81 };

export function development(items, asof, domain, stimulus = null, phase = null) {
  const pts = new Map();
  for (const i of items) {
    if (i.value !== null && i.value !== undefined && !i.excluded && i.date <= asof) {
      const g = i.raw.group || i.raw.protocol || 'all';
      const k = JSON.stringify([g, i.date]);
      if (!pts.has(k)) pts.set(k, []);
      pts.get(k).push(i.value);
    }
  }
  const ser = [...pts].map(([k, v]) => { const [g, d] = JSON.parse(k); return [d, g, v.reduce((a, b) => a + b, 0) / v.length]; }).sort(cmpTuple);
  const out = { n_obs: ser.length, series: ser.map(([d, , v]) => [d, v]), groups: new Set(ser.map((s) => s[1])).size };
  const groups = groupBy(ser, (s) => s[1]);
  const usable = [...groups.values()].filter((r) => r.length >= 2);
  const n = usable.reduce((a, r) => a + r.length, 0); const k = usable.length;
  if (n < PARAMS.plateauMinObs || n - k - 1 < 1) return { ...out, class: 'insufficient evidence' };
  const t0 = ser.reduce((m, s) => (s[0] < m ? s[0] : m), ser[0][0]);
  let sxx = 0.0; let sxy = 0.0; const residSrc = [];
  for (const r of usable) {
    const xs = r.map((s) => days(t0, s[0])); const ys = r.map((s) => s[2]);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length; const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    sxx += xs.reduce((a, x) => a + (x - mx) ** 2, 0); sxy += xs.reduce((a, x, j) => a + (x - mx) * (ys[j] - my), 0);
    residSrc.push([xs, ys, mx, my]);
  }
  if (sxx === 0) return { ...out, class: 'insufficient evidence' };
  const b = sxy / sxx;
  const sse = residSrc.reduce((a, [xs, ys, mx, my]) => a + xs.reduce((s, x, j) => s + (ys[j] - (my + b * (x - mx))) ** 2, 0), 0);
  const dfree = n - k - 1;
  const se = Math.sqrt(sse / dfree / sxx);
  const tcrit = TCRIT[dfree] ?? (dfree < 30 ? 1.70 : 1.645);
  const span = Math.max(...ser.map((s) => days(t0, s[0])));
  const change = b * span; const lo = (b - tcrit * se) * span; const hi = (b + tcrit * se) * span;
  const myAll = ser.reduce((a, s) => a + s[2], 0) / ser.length;
  let swc;
  if (domain in LEVEL_DOMAINS) swc = (Math.abs(myAll) * 3 * PARAMS.smallestWorthwhileChangePct) / 100;
  else swc = Math.max(2.0, 0.5 * (sd(residSrc.flatMap(([, ys, , my]) => ys.map((y) => y - my))) || 0));
  const cls = lo > swc ? 'improving' : hi < -swc ? 'declining' : lo > -swc && hi < swc ? 'practically stable' : 'uncertain';
  Object.assign(out, { slope_per_day: b, change, ci90: [lo, hi], swc, span_days: span, class: cls, df: dfree });
  if ((cls === 'practically stable' || cls === 'uncertain') && Math.abs(change) < swc && span >= PARAMS.plateauMinSpanDays) {
    const cont = stimulus === null ? null : stimulus.continued ?? null;
    if (phase === 'TAPER') out.plateau = 'stable during taper: not a plateau';
    else if (cont === true) out.plateau = 'possible plateau (stimulus continued, no worthwhile change)';
    else if (cont === false) out.plateau = `stable during reduced or zero training: not a plateau (${stimulus.category || ''})`;
    else out.plateau = `no worthwhile change; plateau NOT assessed: training exposure unknown (${(stimulus || {}).category ?? 'no ledger'})`;
  } else if (cls === 'declining' && stimulus && (stimulus.recent_load_ratio || 0) > PARAMS.loadIncreasedRatio) {
    out.plateau = 'decline during increased recent load: possible temporary training-related suppression (cause not established)';
  }
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function resolveDates(start, end, asof = null) {
  const valid = (x) => typeof x === 'string' && ISO.test(x) && !Number.isNaN(toMs(x)) && new Date(toMs(x)).toISOString().slice(0, 10) === x;
  for (const x of [start, end, ...(asof ? [asof] : [])]) if (!valid(x)) throw new Error(`invalid date: ${x}`);
  if (start > end) throw new Error(`reversed review window: start ${start} after end ${end}`);
  const a = asof || end;
  const eff = end < a ? end : a;
  if (eff < start) throw new Error(`assessment date ${eff} precedes the review window start ${start}`);
  return [start, end, eff];
}

export function levelExpression(items, method) {
  const v = items.filter((i) => !i.excluded && i.value !== null && i.value !== undefined).map((i) => i.value).sort((a, b) => b - a);
  if (!v.length) return null;
  if (method === 'best') return v[0];
  if (method === 'median_best3') { const t = v.slice(0, 3); return v.length >= 3 ? t[Math.floor(t.length / 2)] : v.slice(0, 2).reduce((a, b) => a + b, 0) / v.slice(0, 2).length; }
  if (method === 'second_best') return v.length > 1 ? v[1] : v[0];
  return null;
}

// ---------------------------------------------------------------- swimmer and squad evaluation
export function evaluateSwimmer(db, obsAll, swimmerId, start, end, asof = null, options = {}) {
  let eff;
  [start, end, eff] = resolveDates(start, end, asof);
  const sw = (db?.swimmers || []).find((s) => s?.id === swimmerId) || {};
  const sex = String(sw.sex || sw.gender || 'male').toLowerCase();
  const hist = obsAll.filter((o) => o.swimmer === swimmerId && o.date && o.date <= eff);
  const win = hist.filter((o) => o.date >= start);
  const items = Object.fromEntries(DOMAINS.map((d) => [d, []]));
  const comps = Object.fromEntries(DOMAINS.map((d) => [d, {}]));
  for (const i of levelItems(hist, sex)) items[i.domain].push(i);
  const [tItems, tComp] = technicalItems(hist); items.technical_control.push(...tItems); Object.assign(comps.technical_control, tComp);
  const ctx = (options.contextObservations || []).filter((o) => o.swimmer === swimmerId && o.date && o.date <= eff && o.date >= start);
  comps.technical_control.informal_observations_context = { n: ctx.length, scored: false,
    note: 'Informal coach observations are context only and never alter the score (Book 3 p. 293).' };
  const [effItems, rob, ec] = efficiencyRobustness(hist, sex, win);
  items.efficiency.push(...effItems); items.robustness_of_efficiency.push(...rob); Object.assign(comps.efficiency, ec);
  items.adaptability.push(...adaptabilityItems(win, hist));
  items.technical_control.push(...stabilityItems(hist));
  items.adaptability.push(...retestItems(hist));
  const refFrom = addDays(eff, -PARAMS.referenceMaxAgeDays);
  const maxes = hist.filter((o) => o.date >= refFrom && ['M25', 'M50', 'M100', 'M200', 'M400'].includes(o.protocol) && o.rep === 1);
  const latest = new Map();
  for (const o of [...maxes].sort((a, b) => cmpScalar(a.date, b.date))) latest.set(o.protocol, o);
  const csm = criticalSpeed([...latest.values()]);
  const csOk = csm.status === 'valid';
  const csv = csOk ? csm.cs : null;
  const vs = (latest.get('M50') || latest.get('M25') || {}).speed;
  const csEq = csv ? waPoints(1500 / csv, 1500, 'free', PARAMS.speedReferenceSex, (latest.get('M400') || {}).pool || 25) / 10 : null;
  Object.assign(comps.aerobic_capacity, { critical_speed_model: csm, critical_speed_m_s: csv, cs_points: csm.points ?? null,
    cs_equivalent_1500_wa_points_div10: csEq,
    cs_equivalent_note: 'PROVISIONAL MODEL-BASED reference (a 1500 m swum at CS on the World Aquatics scale), not an observed 1500 m',
    vo2_or_threshold: 'NOT MEASURED (critical speed is a performance indicator)' });
  Object.assign(comps.anaerobic_capacity, { d_prime_m: csOk ? csm.dprime : null, d_prime_status: csm.status,
    d_prime_shared_fit_with: 'aerobic CS (same M200/M400 swims; not independent evidence)',
    speed_reserve_m_s: vs && csv ? vs - csv : null,
    lactate_production_or_tolerance: 'NOT MEASURED (LP/LT are task contexts)' });
  const [fades, dur] = fadeItems(hist, { R8x25: 'power_speed_expression', R8x50: 'anaerobic_capacity', R8x100: 'aerobic_capacity' }, csv);
  for (const [dom, its] of Object.entries(fades)) comps[dom].retention_items = its;
  items.durability.push(...dur, ...durabilityProtocolItems(hist));
  const pd = physiologicalDurability(win);
  comps.durability.cardiovascular_drift_hr = pd.length ? pd : 'NOT MEASURED (no heart rate at stable speed)';
  comps.durability.physiological_durability_complete = 'NOT MEASURED (needs VO2 / economy / threshold before and after workload)';
  const refspeed = (d) => { for (const o of latest.values()) if (o.distance === d) return o.speed; return null; };
  comps.anaerobic_capacity.task_structure_audit = taskStructureAudit(win, refspeed);
  comps.adaptability.other_demand_changes = adaptabilityExtras(win, latest);
  const pw = win.map((o) => o.power_w).filter(truthy);
  Object.assign(comps.power_speed_expression, { mean_velocity_25_m_s: (latest.get('M25') || {}).speed ?? null, mean_velocity_50_m_s: (latest.get('M50') || {}).speed ?? null,
    mechanical_power_w: pw.length ? Math.max(...pw) : 'NOT MEASURED (no force/power instrument)',
    race_breakout_time_s: mean(win.map((o) => o.breakout_time).filter(truthy)) });
  // training ledger: current window and the previous NON-OVERLAPPING window of equal length (R-10)
  const L = days(start, eff) + 1;
  const pstart = addDays(start, -L); const pend = addDays(start, -1);
  const led = markConstraintVaried(buildLedger(db, swimmerId, start, eff, csv)); const cur = summarise(led, start, eff);
  const pled = buildLedger(db, swimmerId, pstart, pend, csv);
  const prev = pled.some((r) => !r.duplicate_of) ? summarise(pled, pstart, pend) : null;
  const load = workloadChange(cur, prev);
  const tradar = trainingRadar(cur, prev);
  const knownLoad = load.ratio !== null || load.category.startsWith('zero') || load.category.startsWith('increased');
  const stimulus = { continued: knownLoad ? ['unchanged', 'increased', 'increased (from zero)'].includes(load.category) : null,
    recent_load_ratio: load.ratio, category: load.category };
  const ph = win.filter((o) => o.source === 'training' && o.phase).map((o) => [o.date, o.phase]).sort(cmpTuple);
  const phaseNow = ph.length ? ph[ph.length - 1][1] : null;
  const result = { engine: ENGINE_VERSION, phase_at_assessment: phaseNow, calibration: CALIBRATION_VERSION, app_calibration: APP_CALIBRATION_VERSION,
    swimmer: swimmerId, window: [start, end], asof: eff,
    config: { expression_method: PARAMS.expressionMethod, source_weighting: PARAMS.sourceWeighting, adaptability_method: PARAMS.adaptabilityMethod,
      durability_basis: PARAMS.durabilityBasis, technical_aggregation: PARAMS.technicalAggregation },
    domains: {} };
  const provWin = win.filter((o) => o.provenance);
  const synth = win.filter((o) => o.provenance === 'synthetic').length / Math.max(1, provWin.length);
  for (const dom of DOMAINS) {
    const its = items[dom];
    const perSrc = Object.fromEntries(SOURCES.map((s) => [s, weighted(windowFilter(its, s, eff, start), eff)]));
    if (dom in LEVEL_DOMAINS && PARAMS.expressionMethod !== 'recency_mean') {
      for (const s of ['testing', 'competition']) {
        const v = levelExpression(windowFilter(its, s, eff, start), PARAMS.expressionMethod);
        if (v !== null) perSrc[s] = [Math.max(0.0, Math.min(100.0, v)), perSrc[s][1], perSrc[s][2]];
      }
    }
    const avail = Object.fromEntries(Object.entries(perSrc).filter(([, v]) => v[0] !== null));
    let cap = null; let n = 0; let capSe = null;
    const av = Object.entries(avail);
    if (av.length) {
      const w = PARAMS.sourceWeighting === 'precision' && av.every(([, v]) => truthy(v[2]))
        ? Object.fromEntries(av.map(([s, v]) => [s, 1 / v[2] ** 2]))
        : Object.fromEntries(av.map(([s]) => [s, PARAMS.sourceWeights[s]]));
      const sw2 = av.reduce((a, [s]) => a + w[s], 0);
      cap = av.reduce((a, [s, v]) => a + w[s] * v[0], 0) / sw2;
      n = av.reduce((a, [, v]) => a + v[1], 0);
      capSe = av.every(([, v]) => v[2] !== null) ? Math.sqrt(av.reduce((a, [s, v]) => a + (w[s] * v[2]) ** 2, 0)) / sw2 : null;
    }
    const devSrc = dom === 'efficiency' ? comps.efficiency.development_items || [] : its;
    const dev = development(devSrc, eff, dom, stimulus, phaseNow);
    let suff;
    if (n === 0) suff = 'not measured';
    else if (dom in LEVEL_DOMAINS && !('testing' in avail) && !('competition' in avail)) suff = 'insufficient';
    else if (n === 1) suff = 'testing' in avail || 'competition' in avail ? 'limited' : 'insufficient';
    else if (av.length === 1 && n < 4) suff = 'limited';
    else suff = 'sufficient';
    const decision = ['not measured', 'insufficient'].includes(suff) ? 'Do Not Interpret'
      : suff === 'limited' && dev.class !== 'improving' ? 'Hold'
        : { improving: 'Progress', 'practically stable': 'Hold', declining: String(dev.plateau ?? '').includes('suppression') ? 'Reduce' : 'Hold',
          uncertain: 'Repeat Test', 'insufficient evidence': 'Hold' }[dev.class];
    let paired = null;
    if (dom in LEVEL_DOMAINS) {
      const rit = (comps[dom].retention_items || []).filter((i) => CAPACITY_PROTOCOLS[dom].includes(i.raw.protocol) && i.date <= eff && i.date >= start);
      const capRel = rit.length ? weighted(rit, eff)[0] : null;
      const ritHist = (comps[dom].retention_items || []).filter((i) => CAPACITY_PROTOCOLS[dom].includes(i.raw.protocol) && i.date <= eff);
      paired = { expression: cap, capacity_related_repeatability: capRel,
        repeatability_development: development(ritHist, eff, `repeatability:${dom}`, stimulus, phaseNow),
        capacity_basis: `retention index of ${CAPACITY_PROTOCOLS[dom].join('/')} (PROVISIONAL scale, raw % in components)`,
        composite: 'NOT FORMED (different constructs and scales; see Model B analysis)' };
    }
    const ownSex = its.filter((i) => i.source === 'testing' && !i.excluded).map((i) => i.raw.wa_points_own_sex);
    result.domains[dom] = {
      capability: cap,
      testing: perSrc.testing[0], competition: perSrc.competition[0], training_execution: perSrc.training[0],
      training_stimulus: tradar[dom], paired_profile: paired,
      level: dom in LEVEL_DOMAINS
        ? { scale: 'World Aquatics points / 10, single (male) speed scale - ABSOLUTE (event performance)', value: cap, own_sex_wa_points: mean(ownSex.slice(-2)) }
        : { scale: dom === 'technical_control' ? 'PROVISIONAL rating index (structured coach ratings; not a calibrated measurement)' : 'PROVISIONAL index (raw units reported in components)', value: cap },
      components: comps[dom], development: dev,
      confidence: { sufficiency: suff, n_items: n, sources: Object.keys(avail).sort(), se: Object.fromEntries(av.map(([s, v]) => [s, v[2]])), capability_se: capSe,
        synthetic_share_of_window_observations: round(synth, 3) },
      decision, evidence_keys: [...new Set(its.filter((i) => !i.excluded && i.date <= eff).map((i) => i.key))].sort(),
    };
    // App-only, NON-enumerable (never serialised; not part of the reference output contract): the per-source
    // [value, n, se] triples, so the app can show the training+testing Capability radar with honest evidence counts.
    Object.defineProperty(result.domains[dom], 'per_source', { value: perSrc, enumerable: false });
    // App-only, NON-enumerable: the keys of the review-window evidence items behind each source value (traceability).
    Object.defineProperty(result.domains[dom], 'per_source_keys', { enumerable: false,
      value: Object.fromEntries(SOURCES.map((src) => [src, windowFilter(its, src, eff, start).map((i) => i.key)])) });
  }
  result.training_ledger = { current: cur, previous: prev, previous_window: [pstart, pend], workload_change: load };
  Object.defineProperty(result, 'ledger_rows', { value: led, enumerable: false });   // app-only, never serialised
  result.training_stimulus_meta = { unrecorded_attendance_metres: cur.unknown_workload_prescribed_m, weeks: cur.weeks };
  const execFrom = addDays(eff, -41);
  result.training_execution = trainingExecution(win.filter((o) => o.date >= execFrom), csv, refspeed, Math.min(6, L / 7));
  return result;
}

// Locked source weighting (0.30 / 0.50 / 0.20) restricted to a subset of sources: the same rule evaluateSwimmer uses for
// 'capability' (all three sources). Used by the app for its training+testing Capability radar. With every source it
// reproduces domains[d].capability exactly.
export function capabilityFromSources(domainResult, sources) {
  const per = domainResult?.per_source;
  if (!per) return { value: null, n: 0 };
  const av = sources.filter((s) => per[s] && per[s][0] !== null);
  if (!av.length) return { value: null, n: 0 };
  const w = av.reduce((a, s) => a + PARAMS.sourceWeights[s], 0);
  return { value: av.reduce((a, s) => a + PARAMS.sourceWeights[s] * per[s][0], 0) / w, n: av.reduce((a, s) => a + per[s][1], 0) };
}

export function evaluateSquad(perSwimmer, domains = DOMAINS) {
  const out = {};
  for (const dom of domains) {
    const row = {};
    for (const radar of ['capability', 'testing', 'competition', 'training_execution']) {
      const vals = perSwimmer.map((r) => r.domains[dom][radar]).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
      const q = (p) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1) + 0.5))] : null);
      row[radar] = { median: q(0.5), q1: q(0.25), q3: q(0.75), n_scored: vals.length, n_swimmers: perSwimmer.length };
    }
    const st = perSwimmer.map((r) => r.domains[dom].training_stimulus?.metres_per_week).filter((x) => x !== null && x !== undefined);
    row.training_stimulus_metres_per_swimmer_week = st.length ? st.reduce((a, b) => a + b, 0) / st.length : null;
    out[dom] = row;
  }
  const led = perSwimmer.filter((r) => r.training_ledger).map((r) => r.training_ledger.current);
  const cov = led.map((l) => l.attendance_coverage).filter((x) => x !== null && x !== undefined);
  out._training_ledger = { unique_physical_m_per_swimmer_week_mean: led.length ? led.reduce((a, l) => a + l.unique_physical_m_per_week, 0) / led.length : null,
    unique_physical_m_per_swimmer_week_median: led.length ? led.map((l) => l.unique_physical_m_per_week).sort((a, b) => a - b)[Math.floor(led.length / 2)] : null,
    attendance_coverage_mean: cov.length ? cov.reduce((a, b) => a + b, 0) / cov.length : null, n_swimmers: led.length,
    note: 'per-swimmer values; squad size never multiplies dose' };
  return out;
}

export function rankingWithUncertainty(entries, z = 1.645) {
  const e = entries.filter(([, v]) => v !== null && v !== undefined);
  const out = {};
  for (const [i, v, s] of e) {
    if (s === null || s === undefined) { out[i] = { value: v, rank_interval: null, status: 'rank not assessable (no SE)' }; continue; }
    const above = e.filter(([j, w, t]) => j !== i && t !== null && t !== undefined && w - v > z * Math.sqrt(s ** 2 + t ** 2)).length;
    const below = e.filter(([j, w, t]) => j !== i && t !== null && t !== undefined && v - w > z * Math.sqrt(s ** 2 + t ** 2)).length;
    out[i] = { value: v, se: s, rank_interval: [above + 1, e.length - below], status: above + below === e.length - 1 ? 'distinguishable from all' : 'indistinguishable from some' };
  }
  return out;
}
