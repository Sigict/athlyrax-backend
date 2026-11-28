// AthlyraX Final Model C - capability calculation.
// The original v1.8 engine still produces the measured metric records (stability, retention, Stroke Index, world-class
// output); Model C re-scores each record with its task-specific absolute demand, S = 100 x Q x D^alpha, separates
// Anaerobic Capacity from Power & Speed Expression, adds Critical Swimming Speed, changed-demand Adaptability and race
// retention, scores every source independently and integrates them with the exact source weights.
// Implementation of the approved Phase 0 final simulation (27-11-2026); every coefficient comes from `cfg`.
import { AXES } from './config.js';
import { evidenceIndex, observationsFor } from './evidence.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const WORLD_LEVEL = new Set(['world-class-time-reference', 'competition-world-class-time-reference']);
const REMOVED_AS_DEVELOPMENT = new Set(['learning_rate', 'regression_resistance']);
const DAY = 864e5;

// ------------------------------------------------------------------------------------------------ references
const refsCache = new Map();
export function makeReferences(WR, cfg) {
  const key = JSON.stringify([cfg.references.d25Ratio, cfg.references.worldRecordOverrides]);
  if (refsCache.get(WR)?.key === key) return refsCache.get(WR).refs;
  const OV = cfg.references.worldRecordOverrides || {};
  const sk = (s) => { const t = String(s || '').toLowerCase(); if (/medley|\bim\b/.test(t)) return 'medley'; if (/breast/.test(t)) return 'breast'; if (/back/.test(t)) return 'back'; if (/fly|butter/.test(t)) return 'fly'; return 'free'; };
  const ck = (pool) => { const t = String(pool ?? '').toLowerCase(); if (/lc/.test(t)) return 'LC'; if (/sc/.test(t)) return 'SC'; return Number(pool) >= 45 ? 'LC' : 'SC'; };
  const table = (course, sex, stroke) => { const base = WR?.[course]?.[sex]?.[stroke]; const ov = OV?.[course]?.[sex]?.[stroke]; return base || ov ? { ...(base || {}), ...(ov || {}) } : null; };
  const D25 = cfg.references.d25Ratio;
  const wrTime = (course, sex, stroke, d) => { const t = table(course, sex, stroke); if (!t) return null; if (t[d]) return Number(t[d]); if (d === 25 && t[50]) return Number(t[50]) * D25[sex]; return null; };
  const vmax = (course, sex, stroke, d) => {
    const t = wrTime(course, sex, stroke, d); if (t) return d / t;
    const tab = table(course, sex, stroke); if (!tab) return null; const ds = Object.keys(tab).map(Number).sort((a, b) => a - b);
    const lo = [...ds].reverse().find((x) => x < d); const hi = ds.find((x) => x > d);
    if (lo && hi) { const vl = lo / tab[lo]; const vh = hi / tab[hi]; return vl + (vh - vl) * (Math.log(d / lo) / Math.log(hi / lo)); }
    return null;
  };
  // elite critical speed: two-point distance-time model on the world records (derived reference)
  const css = (course, sex, stroke) => { const t2 = wrTime(course, sex, stroke, 200); const t4 = wrTime(course, sex, stroke, 400);
    if (t2 && t4) return 200 / (t4 - t2);
    const tf2 = wrTime(course, sex, 'free', 200); const tf4 = wrTime(course, sex, 'free', 400); const v2 = vmax(course, sex, stroke, 200);
    return tf2 && tf4 && v2 ? (200 / (tf4 - tf2)) * (v2 / (200 / tf2)) : null; };
  const baseWrTime = (course, sex, stroke, d) => { const t = WR?.[course]?.[sex]?.[stroke]; if (!t) return null; if (t[d]) return t[d]; if (d === 25 && t[50]) return t[50] * D25[sex]; return null; };
  const refs = { sk, ck, wrTime, vmax, css, baseWrTime };
  refsCache.set(WR, { key, refs });
  return refs;
}
const refSex = (cfg, swimmerSex) => (cfg.referenceSex === 'own' ? (/^f/i.test(swimmerSex || '') ? 'female' : 'male') : 'male');

// Task reference velocity for one piece of evidence (m/s) and its derivation label.
export function taskReference(ev, refs, cfg, swimmerSex) {
  const sex = refSex(cfg, swimmerSex);
  const stroke = refs.sk(ev.stroke); const course = refs.ck(ev.pool); const d = Number(ev.distance) || 0;
  if (!d) return { v: null, label: 'no distance' };
  const codeKey = ev.source === 'training' ? ev.energy : ev.source === 'testing' ? ev.protocol : `race${d}`;
  const tableV = Number(cfg.references.speedTable?.[`${course}|${stroke}|${d}|${codeKey}`]);
  if (tableV > 0) return { v: tableV, label: `Speed Table ${course} ${stroke} ${d} m ${codeKey}` };
  if (ev.source === 'competition' || /^M(25|50|100|200|400)$/.test(ev.protocol || '')) {
    const v = refs.vmax(course, sex, stroke, d); return { v, label: `world-class ${d} m ${stroke} ${course} ${sex} (event)` };
  }
  if (ev.source === 'testing') {
    const p = /^R8x(25|50|100)$/.test(ev.protocol) ? ev.protocol : /A5x400/.test(ev.protocol) ? 'A5x400' : 'custom';
    if (p === 'A5x400') { const v = refs.css(course, sex, stroke); return { v, label: `elite critical speed ${stroke} ${course} ${sex} (derived WR 200/400) for 5x400` }; }
    const f = cfg.protocolFactor[p] ?? cfg.protocolFactor.custom; const vm = refs.vmax(course, sex, stroke, d);
    return { v: vm ? vm * f : null, label: `${f} x world-class ${d} m ${stroke} ${course} ${sex} (protocol ${p})` };
  }
  const [base, f] = cfg.trainingRef[ev.energy] || cfg.trainingRef._default;
  const vb = base === 'css' ? refs.css(course, sex, stroke) : base === 'v400' ? refs.vmax(course, sex, stroke, 400) : refs.vmax(course, sex, stroke, d);
  return { v: vb ? vb * f : null, label: `${f} x ${base === 'css' ? 'elite critical speed' : base === 'v400' ? 'world-class 400 m speed' : `world-class ${d} m speed`} ${stroke} ${course} ${sex} (${ev.energy || 'uncoded'})` };
}

export function cvScore(v, cfg) {
  const A = cfg.stabilityCurve; const x = Math.max(0, v); if (x <= A[0][0]) return A[0][1];
  for (let i = 1; i < A.length; i += 1) { const [ux, uy] = A[i]; const [lx, ly] = A[i - 1]; if (x <= ux) return ly + (uy - ly) * ((x - lx) / (ux - lx)); }
  return A[A.length - 1][1];
}

// Measured-capability routing: separates Anaerobic Capacity from Power & Speed Expression and keeps long aerobic
// protocols out of Anaerobic. Returns { drop } | { signal, axis, metric, protocolOutput, note }.
export function routeRecord(r, ev, cfg) {
  const p = ev?.source === 'testing' ? ev.protocol : ev?.source === 'competition' ? `race${ev.distance}` : ev?.source === 'training' ? `train:${ev.energy}` : '';
  const k = `${r.axis}.${r.metric}`; const R = cfg.routing;
  const longAerobic = /10x200|A5x400|1x400/.test(p);
  if (k === 'anaerobic_capacity.peak_output') {
    if (p === 'M25' || p === 'R8x25') return { drop: 'maximum short-sprint speed is Power & Speed evidence, not Anaerobic output' };
    const w = R.anaerobicPeak[p]; if (w === undefined || w === null) return { drop: `no high-intensity output reference for ${p}` };
    return { signal: w, protocolOutput: p === 'R8x50' || p === 'R8x100' };
  }
  if (k === 'power_speed_expression.maximum_velocity' && (p === 'R8x25' || p === 'R8x50')) return { drop: 'a repeated-effort set is not a maximum-velocity measurement' };
  if (k === 'power_speed_expression.sprint_stability' && (p === 'R8x50' || p === 'train:LP' || p === 'train:LT')) return { drop: 'high-intensity repetition (LP/LT/8x50) is Anaerobic repeatability evidence' };
  if (k === 'anaerobic_capacity.repeatability') { if (p === 'R8x25') return { drop: 'short maximum efforts: Power & Speed reproduction (sprint_stability)' }; if (longAerobic) return { axis: 'aerobic_capacity', metric: 'repeatability', note: 'aerobic protocol' }; }
  if (k === 'anaerobic_capacity.fatigue_resistance') { if (p === 'R8x25') return { axis: 'power_speed_expression', metric: 'sprint_stability', note: 'short-effort speed reproduction' }; if (longAerobic) return { drop: 'aerobic protocol: Durability fatigue_resistance already measures it' }; }
  if (k === 'aerobic_capacity.pace_stability') { if (p === 'R8x25' || p === 'R8x50') return { drop: 'sprint / high-intensity protocol' }; const w = R.aerobicPaceStability[p]; if (w !== undefined) return { signal: w }; }
  if (r.axis === 'durability' && ev && (ev.source === 'testing' || ev.source === 'competition')) {
    const metres = ev.source === 'testing' ? (ev.metres || 0) : (ev.distance || 0);
    return { signal: Math.min(1, metres / cfg.durabilityRelevanceMetres), note: 'accumulated-demand relevance' };
  }
  return {};
}

// Owner reference overrides that change an ORIGINAL output score (world-class output, Efficiency): ratio adjustments,
// identity when nothing is overridden.
function worldOutputOverrideRatio(ev, refs, cfg, swimmerSex) {
  if (!ev || !Object.keys(cfg.references.worldRecordOverrides || {}).length) return 1;
  const sex = refSex(cfg, swimmerSex); const c = refs.ck(ev.pool); const st = refs.sk(ev.stroke); const d = Number(ev.distance);
  const tb = refs.baseWrTime(c, sex, st, d); const tn = refs.wrTime(c, sex, st, d);
  return tb && tn ? tn / tb : 1;
}
function strokeRateOverrideRatio(ev, cfg, swimmerSex, eliteRates) {
  const ov = cfg.references.strokeRateOverrides || {}; if (!ev || !Object.keys(ov).length) return 1;
  const st = String(ev.stroke || 'free'); const sex = /^f/i.test(swimmerSex || '') ? 'female' : /^m/i.test(swimmerSex || '') ? 'male' : null; const d = Number(ev.distance);
  if (!sex) return 1; const nv = Number(ov?.[st]?.[sex]?.[d]); const ovr = Number(eliteRates?.[st]?.[sex]?.[d]);
  return nv > 0 && ovr > 0 ? nv / ovr : 1;
}

// ------------------------------------------------------------------------------------------------ record re-scoring
export function rescoreRecords({ records, index, refs, cfg, swimmerSex, eliteRates }) {
  const out = []; const audit = [];
  for (let r of records) {
    if (r.kind === 'trend') continue;
    const base = { axis: r.axis, metric: r.metric, source: r.source, date: r.date, evidenceId: r.evidenceId, signal: r.signal, method: r.method, rawValue: r.rawValue };
    const evR = index.byKey.get(String(r.evidenceId)); const route = routeRecord(r, evR, cfg);
    if (route.drop) { audit.push({ ...base, excluded: route.drop }); continue; }
    if (route.axis) { r = { ...r, axis: route.axis, metric: route.metric || r.metric }; base.axis = r.axis; base.metric = r.metric; base.rerouted = route.note; }
    base.signal = (Number(base.signal) || 0) * (route.signal ?? 1);
    if (route.protocolOutput && evR?.meanSpeed) {
      const tr = taskReference(evR, refs, cfg, swimmerSex);
      if (tr.v) { const D = evR.meanSpeed / tr.v;
        out.push({ ...base, Q: null, D, alpha: 0, S: 100 * Math.max(0, D) ** cfg.transform.protocolOutput, ref: `${tr.label} (high-intensity protocol output)`, kind: 'output', method: 'protocol-velocity-vs-protocol-reference', vObserved: evR.meanSpeed, vReference: tr.v });
        continue; }
    }
    if (r.axis === 'adaptability') {
      // identical demand repeated = development; changed demand is scored below from the same evidence
      audit.push({ ...base, excluded: REMOVED_AS_DEVELOPMENT.has(r.metric) || /same-event|retest/.test(r.method)
        ? 'development (identical demand repeated), not adaptability' : 'replaced by the changed-demand calculation (same evidence, specification formula)' });
      continue;
    }
    if (WORLD_LEVEL.has(r.method)) {
      const D = Math.cbrt(Math.max(0, Number(r.score)) / 100) * worldOutputOverrideRatio(evR, refs, cfg, swimmerSex);
      out.push({ ...base, Q: null, D, alpha: 0, S: 100 * D ** cfg.transform.event, ref: 'World Aquatics base time (event)', kind: 'output' }); continue;
    }
    if (r.axis === 'efficiency') {
      out.push({ ...base, Q: null, D: null, alpha: 0, S: Number(r.score) * strokeRateOverrideRatio(evR, cfg, swimmerSex, eliteRates), ref: 'elite Stroke Index', kind: 'output-ratio' }); continue;
    }
    const ev = evR;
    // quality Q: the original quality score BEFORE the original universal speed multiplier
    let Qs = Number.isFinite(r.consistencyScore) ? r.consistencyScore : Number(r.score);
    if (cfg.cvMultiplier !== 1 && /cv/.test(r.method) && Number.isFinite(Number(r.rawValue))) Qs = cvScore(Number(r.rawValue) * cfg.cvMultiplier, cfg);
    const Q = clamp01(Qs / 100);
    let D = null; let ref = null; const alpha = cfg.alpha[r.axis] ?? 0.5; let parts = null;
    if (r.axis === 'durability') {
      if (!ev?.meanSpeed) { audit.push({ ...base, excluded: 'no sustained-speed measurement' }); continue; }
      const tr = taskReference(ev, refs, cfg, swimmerSex); const Dout = tr.v ? clamp01(ev.meanSpeed / tr.v) : null;
      const isTest = ev.source === 'testing'; const isRace = ev.source === 'competition';
      const Dwork = isTest || isRace ? null : clamp01(ev.metres / cfg.durability.referenceWorkM); // test/race workload is inherent
      const wfRef = cfg.durability.referenceWorkFraction[ev.energy] ?? cfg.durability.referenceWorkFraction._default;
      const wf = ev.sendoff && ev.meanTime ? ev.meanTime / ev.sendoff : null;
      const Ddens = isRace || !wf || !wfRef ? null : clamp01(wf / wfRef);
      if (Dout === null) { audit.push({ ...base, excluded: 'no sustained-output reference' }); continue; }
      const comps = [[Dout, cfg.durability.wOutput], [Dwork, cfg.durability.wWork], [Ddens, cfg.durability.wDensity]].filter(([v]) => v !== null && v !== undefined);
      const wsum = comps.reduce((a, [, w]) => a + w, 0);
      D = Math.exp(comps.reduce((a, [v, w]) => a + (w / wsum) * Math.log(Math.max(1e-9, v)), 0));
      ref = tr.label; parts = { Dout, Dwork, Ddens, renormalised: comps.length < 3, vObserved: ev.meanSpeed, vReference: tr.v };
    } else {
      if (!ev?.meanSpeed) { audit.push({ ...base, excluded: 'no velocity for the demand reference' }); continue; }
      const tr = taskReference(ev, refs, cfg, swimmerSex);
      if (!tr.v) { audit.push({ ...base, excluded: `no reference: ${tr.label}` }); continue; }
      D = clamp01(ev.meanSpeed / tr.v); ref = tr.label; parts = { vObserved: ev.meanSpeed, vReference: tr.v, Duncapped: ev.meanSpeed / tr.v };
    }
    const Dx = cfg.demandScale === 'wa' ? D ** 3 : D;
    const S = 100 * Q * Dx ** alpha;
    if (!Number.isFinite(S)) { audit.push({ ...base, excluded: 'demand unavailable' }); continue; }
    out.push({ ...base, Q, D, alpha, S, ref, parts, kind: 'quality' });
  }
  out.push(...criticalSpeedItems({ index, refs, cfg, swimmerSex }));
  out.push(...changedDemandItems({ index, refs, cfg, swimmerSex }));
  out.push(...raceRetentionItems({ index, refs, cfg, swimmerSex }));
  return { scored: out, audit };
}

// Aerobic critical swimming speed from compatible M200 + M400 (same stroke and course, within the pairing window).
export function criticalSpeedItems({ index, refs, cfg, swimmerSex }) {
  const out = [];
  const tests = [...index.byKey.values()].filter((e) => e.source === 'testing' && /^M(200|400)$/.test(e.protocol) && e.meanTime);
  for (const m4 of tests.filter((e) => e.protocol === 'M400')) {
    const m2 = tests.filter((e) => e.protocol === 'M200' && e.stroke === m4.stroke && e.pool === m4.pool && Math.abs(Date.parse(e.date) - Date.parse(m4.date)) <= cfg.cssPairWindowDays * DAY)
      .sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(m4.date)) - Math.abs(Date.parse(b.date) - Date.parse(m4.date)))[0];
    if (!m2 || !(m4.meanTime > m2.meanTime)) continue;
    const cssObs = 200 / (m4.meanTime - m2.meanTime);
    const sex = refSex(cfg, swimmerSex);
    const cssRef = refs.css(refs.ck(m4.pool), sex, refs.sk(m4.stroke)); if (!cssRef) continue;
    const D = cssObs / cssRef;
    out.push({ axis: 'aerobic_capacity', metric: 'critical_speed', source: 'testing', date: m4.date > m2.date ? m4.date : m2.date, evidenceId: `css:${m2.key}+${m4.key}`, signal: 1,
      method: 'critical-swimming-speed-vs-elite-derived', rawValue: cssObs, Q: null, D, alpha: 0, S: 100 * Math.max(0, D) ** cfg.transform.css,
      ref: `elite critical speed ${refs.sk(m4.stroke)} ${refs.ck(m4.pool)} ${sex} = 200/(T400_WR - T200_WR) (derived)`, kind: 'output', parts: { vObserved: cssObs, vReference: cssRef, m200: m2.key, m400: m4.key } });
  }
  return out;
}

// Adaptability: identifiable changed demand between two training sets of the same swimmer (within the pair window);
// exactly ONE of send-off / recovery / prescribed pace / intensity code / repetition distance / stroke / task differs.
// Q = max(0, 1 - E/tolerance), E = relative error vs the task benchmark (transition = first repetition, stabilisation =
// later repetitions). D = sqrt(D_output x D_change x direction); S = 100 x Q x D^alpha.
// Pairing (cfg.adaptability.pairing):
//   'consecutive' (approved Final Model C): each set is compared with the immediately preceding timed set only.
//   'most-recent-eligible': each set is compared with the most recent earlier set (other day, within the pair window)
//     whose demand differs in exactly ONE scorable way; repetition count and technical prescriptions (target stroke
//     count) must then be unchanged - a change in those alone has no approved change-difficulty formula and is not scored.
// The scoring formula is identical in both modes. `diagnostics` (optional array) receives the reason for every set.
const taskOf = (x) => (/kick/.test(x.modality + x.setName.toLowerCase()) ? 'kick' : /drill/.test(x.modality + x.setName.toLowerCase()) ? 'drill' : /\bim\b|medley/.test(x.setName.toLowerCase()) ? 'im' : 'swim');
function demandDiff(a, b, refs, extended) {
  const pa = a.prescription || {}; const pb = b.prescription || {};
  const diff = { sendoff: a.sendoff !== b.sendoff, intensity: a.energy !== b.energy, distance: a.distance !== b.distance, stroke: refs.sk(a.stroke) !== refs.sk(b.stroke),
    pace: Boolean(pa.targetPace && pb.targetPace && pa.targetPace !== pb.targetPace), recovery: Boolean(pa.rest !== null && pb.rest !== null && pa.rest !== undefined && pa.rest !== pb.rest && a.sendoff === b.sendoff),
    task: taskOf(pa.modality !== undefined ? pa : { modality: '', setName: '' }) !== taskOf(pb.modality !== undefined ? pb : { modality: '', setName: '' }) };
  if (diff.pace) diff.intensity = false; // a prescribed pace change is the more specific description of the intensity change
  const kinds = Object.entries(diff).filter(([, v]) => v).map(([k]) => k);
  const unscorable = [];
  if (extended) {
    if (pa.repetitions && pb.repetitions && pa.repetitions !== pb.repetitions) unscorable.push('repetitions');
    if ((pa.targetStrokeCount ?? null) !== (pb.targetStrokeCount ?? null)) unscorable.push('technical');
  }
  return { kinds, unscorable, pa, pb };
}
function pairItems({ a, b, kind, pa, pb, refs, cfg, swimmerSex }) {
  const A = cfg.adaptability;
  const vb = b.meanSpeed; const refB = taskReference(b, refs, cfg, swimmerSex); const refA = taskReference(a, refs, cfg, swimmerSex);
  if (!refA.v || !refB.v) return { items: null, reason: 'no task reference' };
  let vExp; let change; let Dchg; let direction; let oneSided = false;
  if (kind === 'sendoff') { if (!a.sendoff || !b.sendoff) return { items: null, reason: 'send-off not recorded' }; change = Math.abs(a.sendoff - b.sendoff) / b.sendoff; Dchg = Math.min(1, change / A.sendoffChangeRef); direction = a.sendoff < b.sendoff ? 'harder' : 'easier'; vExp = vb; oneSided = true; }
  else if (kind === 'intensity') { const ratio = refA.v / refB.v; change = Math.abs(ratio - 1); Dchg = Math.min(1, change / A.speedChangeRef); direction = ratio > 1 ? 'harder' : 'easier'; vExp = vb * ratio; }
  else if (kind === 'distance') { change = Math.abs(Math.log(a.distance / b.distance)) / Math.log(2); Dchg = Math.min(1, change / A.distanceChangeRef); direction = a.distance > b.distance ? 'harder' : 'easier'; vExp = vb * (refA.v / refB.v); }
  else if (kind === 'pace') { const tA = a.distance / pa.targetPace; const tB = b.distance / pb.targetPace; change = Math.abs(tA - tB) / tB; Dchg = Math.min(1, change / A.speedChangeRef); direction = tA > tB ? 'harder' : 'easier'; vExp = tA; }
  else if (kind === 'recovery') { change = Math.abs(pa.rest - pb.rest) / Math.max(1, pb.rest); Dchg = Math.min(1, change / A.sendoffChangeRef); direction = pa.rest < pb.rest ? 'harder' : 'easier'; vExp = vb; oneSided = true; }
  else if (kind === 'task') { change = 1; Dchg = 1; direction = 'neutral'; vExp = vb; oneSided = true; }
  else { change = 1; Dchg = 1; direction = 'neutral'; vExp = vb * (refA.v / refB.v); }
  // a prescribed target on the changed set is the response benchmark whenever it exists
  if (pa.targetPace && kind !== 'pace') { vExp = a.distance / pa.targetPace; oneSided = false; }
  const err = (v) => (oneSided ? Math.max(0, (vExp - v) / vExp) : Math.abs(v - vExp) / vExp);
  const reps = a.repSpeeds; const Eall = reps.reduce((s, v) => s + err(v), 0) / reps.length;
  const Etrans = err(reps[0]); const Estab = reps.length >= 3 ? reps.slice(1).reduce((s, v) => s + err(v), 0) / (reps.length - 1) : null;
  const Dout = Math.min(1, a.meanSpeed / refA.v); const dir = A.direction[direction] ?? 1;
  const D = Math.sqrt(Dout * Dchg * dir); const alpha = cfg.alpha.adaptability;
  const common = { axis: 'adaptability', source: 'training', date: a.date, evidenceId: a.key, signal: 1, D, alpha, kind: 'quality',
    ref: `${kind} change ${(100 * change).toFixed(1)} % (${direction}); benchmark ${oneSided ? 'hold pace' : 'task reference ratio'} ${vExp.toFixed(3)} m/s; ${refA.label}`,
    parts: { changeKind: kind, from: b.key, Dout, Dchange: Dchg, direction, directionFactor: dir, Eall, Etransition: Etrans, Estabilisation: Estab, vExpected: vExp } };
  const items = [];
  const Qt = Math.max(0, 1 - Etrans / A.tolerance); items.push({ ...common, metric: 'transfer_success', method: `changed-${kind}-transition-response`, rawValue: 100 * Etrans, Q: Qt, S: 100 * Qt * D ** alpha });
  if (Estab !== null) { const Qs = Math.max(0, 1 - Estab / A.tolerance); items.push({ ...common, metric: 'stabilisation_speed', method: `changed-${kind}-stabilisation-response`, rawValue: 100 * Estab, Q: Qs, S: 100 * Qs * D ** alpha }); }
  return { items, reason: null };
}
export function changedDemandItems({ index, refs, cfg, swimmerSex, diagnostics = null }) {
  const A = cfg.adaptability; const sets = [...index.byKey.values()].filter((e) => e.source === 'training' && e.meanSpeed && e.repSpeeds?.length)
    .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  const items = []; const note = (a, outcome, reason, from = null) => { if (diagnostics) diagnostics.push({ set: a.key, date: a.date, outcome, reason, from }); };
  if ((A.pairing || 'consecutive') === 'consecutive') {
    for (let i = 1; i < sets.length; i += 1) {
      const b = sets[i - 1]; const a = sets[i];
      if (a.date === b.date) { note(a, 'excluded', 'previous set on the same day', b.key); continue; }
      if ((Date.parse(a.date) - Date.parse(b.date)) > A.pairWindowDays * DAY) { note(a, 'excluded', `previous set more than ${A.pairWindowDays} days earlier`, b.key); continue; }
      const { kinds, pa, pb } = demandDiff(a, b, refs, false);
      if (kinds.length !== 1) { note(a, 'excluded', kinds.length ? 'two or more demands changed at once' : 'identical demand (development, not adaptability)', b.key); continue; } // not identifiable
      const r = pairItems({ a, b, kind: kinds[0], pa, pb, refs, cfg, swimmerSex });
      if (!r.items) { note(a, 'excluded', r.reason, b.key); continue; }
      items.push(...r.items); note(a, 'scored', `${kinds[0]} change`, b.key);
    }
    if (sets.length) note(sets[0], 'excluded', 'no earlier timed set');
    return items;
  }
  // most-recent-eligible
  for (let i = 0; i < sets.length; i += 1) {
    const a = sets[i]; const seen = new Set(); let scored = false;
    for (let j = i - 1; j >= 0; j -= 1) {
      const b = sets[j];
      if (b.date === a.date) { seen.add('only same-day sets'); continue; }
      if ((Date.parse(a.date) - Date.parse(b.date)) > A.pairWindowDays * DAY) break;
      const { kinds, unscorable, pa, pb } = demandDiff(a, b, refs, true);
      if (kinds.length === 0 && unscorable.length === 0) { seen.add('identical demand (development, not adaptability)'); continue; }
      if (kinds.length + unscorable.length > 1) { seen.add('two or more demands changed at once'); continue; }
      if (unscorable.length) { seen.add(`only the ${unscorable[0] === 'technical' ? 'technical prescription (target stroke count)' : 'repetition count'} changed: no approved change-difficulty formula`); continue; }
      const r = pairItems({ a, b, kind: kinds[0], pa, pb, refs, cfg, swimmerSex });
      if (!r.items) { seen.add(r.reason); continue; }
      items.push(...r.items); note(a, 'scored', `${kinds[0]} change`, b.key); scored = true; break;
    }
    if (!scored) note(a, 'excluded', seen.size ? [...seen].join('; ') : `no earlier timed set within ${A.pairWindowDays} days`);
  }
  return items;
}

// Provisional Adaptability fallback F2 (owner decision 28-11-2026; research rep2, b = 0, τ = 0.10, c = 1, α = 0.5).
// Used ONLY when the changed-demand calculation above leaves Adaptability unscored in every source (never combined with
// a valid score). Pair: the most recent earlier timed set (other day, within the pair window) with the same distance,
// stroke, course, intensity code, send-off, modality and target stroke count whose repetition count differs; sets with
// the same repetition count are skipped (development). Expected profile = line fitted through the previous set's
// repetition speeds, a + s·i, extended or truncated to every repetition of the new set, × (r_new / r_old)^-b.
// δ = mean(v_new) / mean(v_expected) − 1;  Q = clamp(1 − max(0, −δ) / τ);  S = 100 · Q · D_out^α;
// evidence weight (signal) w = min(1, |ln(r_new / r_old)| / ln 2 / c); recency and exposure weighting as every item.
const F2_METHOD = 'provisional-repetition-count-response-F2';
function lineFit(v) {
  const n = v.length; const m = v.reduce((a, b) => a + b, 0) / n; if (n < 3) return { a: m, s: 0 };
  const mi = (n - 1) / 2; let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i += 1) { sxy += (i - mi) * (v[i] - m); sxx += (i - mi) ** 2; }
  const s = sxy / sxx; return { a: m - s * mi, s };
}
export function repetitionFallbackItems({ index, refs, cfg, swimmerSex }) {
  const F = cfg.adaptability?.repetitionFallback; if (!F || F.mode !== 'provisional-f2') return [];
  const reps = (e) => e.prescription?.repetitions;
  const sets = [...index.byKey.values()].filter((e) => e.source === 'training' && e.meanSpeed && e.repSpeeds?.length && reps(e))
    .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  const same = (a, b) => a.sendoff === b.sendoff && a.energy === b.energy && a.distance === b.distance && refs.sk(a.stroke) === refs.sk(b.stroke)
    && refs.ck(a.pool) === refs.ck(b.pool) && String(a.prescription?.modality) === String(b.prescription?.modality)
    && (a.prescription?.targetStrokeCount ?? null) === (b.prescription?.targetStrokeCount ?? null);
  const items = [];
  for (let i = 0; i < sets.length; i += 1) {
    const a = sets[i];
    for (let j = i - 1; j >= 0; j -= 1) {
      const b = sets[j]; if (b.date === a.date) continue;
      if ((Date.parse(a.date) - Date.parse(b.date)) > cfg.adaptability.pairWindowDays * DAY) break;
      if (!same(a, b) || reps(a) === reps(b)) continue;
      const tr = taskReference(a, refs, cfg, swimmerSex); if (!tr.v) break;
      const L = Math.log(reps(a) / reps(b)); const m = Math.exp(-F.b * L); const f = lineFit(b.repSpeeds);
      const expected = a.repSpeeds.map((_, k) => (f.a + f.s * k) * m);
      const vNew = a.repSpeeds.reduce((x, y) => x + y, 0) / a.repSpeeds.length; const vExp = expected.reduce((x, y) => x + y, 0) / expected.length;
      const delta = vNew / vExp - 1; const Q = clamp01(1 - Math.max(0, -delta) / F.tolerance);
      const Dout = Math.min(1, a.meanSpeed / tr.v); const magnitude = Math.abs(L) / Math.log(2); const w = Math.min(1, magnitude / F.magnitudeRef);
      items.push({ axis: 'adaptability', source: 'training', metric: 'transfer_success', method: F2_METHOD, provisional: true, kind: 'quality',
        date: a.date, evidenceId: a.key, signal: w, Q, D: Dout, alpha: F.alpha, S: 100 * Q * Dout ** F.alpha, rawValue: 100 * delta,
        ref: `Provisional estimate (repetition-count fallback F2): ${reps(b)} → ${reps(a)} repetitions; expected mean ${vExp.toFixed(3)} m/s, actual ${vNew.toFixed(3)} m/s (${(100 * delta).toFixed(2)} %); ${tr.label}`,
        parts: { from: b.key, rOld: reps(b), rNew: reps(a), direction: reps(a) > reps(b) ? 'increase' : 'decrease', magnitude, weight: w, b: F.b, tolerance: F.tolerance,
          fitPrevious: f, vExpected: vExp, vObserved: vNew, delta, Dout, vReference: tr.v } });
      break;
    }
  }
  return items;
}

// Race retention (100 m and longer): second-half / first-half time against the elite pacing reference of the distance
// (finishing acceleration never penalised). Shared without double counting: Durability weight r = min(1, distance /
// relevance metres), Anaerobic fatigue_resistance weight 1 - r.
export function raceRetentionItems({ index, refs, cfg, swimmerSex }) {
  const items = [];
  for (const e of index.byKey.values()) {
    if (e.source !== 'competition' || !e.halves) continue;
    const ref = cfg.pacingRef[e.distance]; if (!ref) continue;
    const ratio = e.halves[1] / e.halves[0]; const det = 100 * (ratio / ref - 1); const Q = cvScore(Math.max(0, det), cfg) / 100;
    const tr = taskReference(e, refs, cfg, swimmerSex); if (!tr.v) continue; const D = Math.min(1, e.meanSpeed / tr.v);
    const rel = Math.min(1, e.distance / cfg.durabilityRelevanceMetres);
    const common = { source: 'competition', date: e.date, evidenceId: e.key, rawValue: det, Q, D, kind: 'quality', method: 'race-half-split-retention-vs-elite-pacing',
      ref: `${tr.label}; elite pacing ratio ${ref}`, parts: { halves: e.halves, ratio, pacingRef: ref, deteriorationPct: det, relevance: rel, Dout: D, Dwork: null, Ddens: null, renormalised: true } };
    if (rel < 1) items.push({ ...common, axis: 'anaerobic_capacity', metric: 'fatigue_resistance', signal: 1 - rel, alpha: cfg.alpha.anaerobic_capacity, S: 100 * Q * D ** cfg.alpha.anaerobic_capacity });
    if (rel > 0) items.push({ ...common, axis: 'durability', metric: 'decay_curve', signal: rel, alpha: cfg.alpha.durability, S: 100 * Q * D ** cfg.alpha.durability });
  }
  return items;
}

// ------------------------------------------------------------------------------------------------ aggregation
export function metricWeights(cfg) {
  const w = JSON.parse(JSON.stringify(cfg.metricWeights));
  const t = w.aerobic_capacity.threshold_pace; w.aerobic_capacity.threshold_pace = t * (1 - cfg.aerobicCssShare); w.aerobic_capacity.critical_speed = t * cfg.aerobicCssShare;
  return w;
}
export function recencyWeight(date, asof, cfg) {
  const a = (Date.parse(asof) - Date.parse(date)) / DAY;
  for (const [days, w] of cfg.recency.bands) if (a <= days) return w;
  return cfg.recency.older;
}
// Original single-stage aggregation within one source: sum(S x Wm x Wr x Wf x Ws) / sum(W).
export function aggregateSource(scored, source, weights, exposure, asof, cfg, sourceW = null) {
  const res = {}; const detail = {}; const coverage = {}; const counts = {};
  for (const axis of AXES) {
    const rs = scored.filter((r) => r.axis === axis && (source === '*' || r.source === source) && r.date <= asof && Number.isFinite(r.S));
    if (!rs.length) { res[axis] = null; coverage[axis] = 0; counts[axis] = 0; detail[axis] = []; continue; }
    const byMetric = {}; for (const r of rs) (byMetric[r.metric] ||= new Set()).add(r.evidenceId);
    let num = 0; let den = 0; const contrib = [];
    for (const r of rs) {
      const Wm = (weights[axis]?.[r.metric] ?? 0) * (source === '*' ? (sourceW?.[r.source] ?? 0) : 1); const Wr = recencyWeight(r.date, asof, cfg);
      const Wf = Math.min(1, byMetric[r.metric].size / (exposure[axis] || 4)); const Ws = Math.max(0, Math.min(1, Number(r.signal) || 0));
      const W = Wm * Wr * Wf * Ws; if (W <= 0) continue; num += W * r.S; den += W; contrib.push({ ...r, W, Wm, Wr, Wf, Ws });
    }
    res[axis] = den > 0 ? Math.max(0, num / den) : null; detail[axis] = contrib;
    counts[axis] = den > 0 ? new Set(contrib.map((r) => r.evidenceId)).size : 0;
    coverage[axis] = [...new Set(contrib.map((r) => r.metric))].reduce((a, m) => a + (weights[axis]?.[m] ?? 0), 0);
  }
  return { scores: res, detail, coverage, counts };
}
export function combineSources(parts, weights, coverage = null) {
  const out = {}; const effective = {};
  for (const axis of AXES) {
    const av = Object.entries(parts).filter(([, s]) => Number.isFinite(s?.[axis]));
    const w = (src) => weights[src] * (coverage ? (coverage[src]?.[axis] ?? 1) : 1);
    const den = av.reduce((a, [src]) => a + w(src), 0);
    out[axis] = av.length && den > 0 ? av.reduce((a, [src, s]) => a + w(src) * s[axis], 0) / den : null;
    effective[axis] = Object.fromEntries(av.map(([src]) => [src, den > 0 ? w(src) / den : 0]));
  }
  return { scores: out, effective };
}

// ------------------------------------------------------------------------------------------------ profile
const STROKE_LABEL = { free: 'Freestyle', back: 'Backstroke', breast: 'Breaststroke', fly: 'Butterfly', medley: 'Individual Medley' };
export const eventKeyOf = (ev, refs) => `${ev.distance} ${refs.sk(ev.stroke)} ${refs.ck(ev.pool)}`;
export const eventLabel = (key) => { const [d, st, c] = String(key).split(' '); return `${d}m ${STROKE_LABEL[st] || st} ${c === 'LC' ? 'LC' : 'SC'}`; };

// One swimmer, one window: independent Training (measured), Testing and Competition scores, Capability, Integrated,
// every competition event and every race. `records` are the original engine's metric records of the window.
export function computeModelCProfile({ db, swimmerId, swimmerSex, records, asOf, cfg, worldRecords, eliteRates }) {
  const refs = makeReferences(worldRecords, cfg);
  const W = metricWeights(cfg); const EXPO = cfg.exposureTargets;
  const built = observationsFor(db); const { observations, issues } = built;
  const index = evidenceIndex(observations, String(swimmerId), db, cfg, built);
  const { scored, audit } = rescoreRecords({ records, index, refs, cfg, swimmerSex, eliteRates });
  let src = Object.fromEntries(['training', 'testing', 'competition'].map((k) => [k, aggregateSource(scored, k, W, EXPO, asOf, cfg)]));
  // Adaptability fallback F2: only when no source produced an Adaptability score (never combined with a valid score).
  let provisional = null;
  if (!['training', 'testing', 'competition'].some((k) => Number.isFinite(src[k].scores.adaptability))) {
    const f2 = repetitionFallbackItems({ index, refs, cfg, swimmerSex }).filter((r) => r.date <= asOf);
    if (f2.length) {
      scored.push(...f2);
      src = { ...src, training: aggregateSource(scored, 'training', W, EXPO, asOf, cfg) };
      if (Number.isFinite(src.training.scores.adaptability)) provisional = { adaptability: { method: F2_METHOD, comparisons: f2.length, sets: src.training.counts.adaptability } };
    }
  }
  const compRecs = scored.filter((r) => r.source === 'competition');
  const evOf = (id) => index.byKey.get(String(id));
  const eventOf = (r) => { const ev = evOf(r.evidenceId); return ev ? eventKeyOf(ev, refs) : 'unknown'; };
  const events = [...new Set(compRecs.map(eventOf))].sort();
  const perEventAgg = Object.fromEntries(events.map((e) => [e, aggregateSource(compRecs.filter((r) => eventOf(r) === e), 'competition', W, EXPO, asOf, cfg)]));
  const perEvent = Object.fromEntries(events.map((e) => [e, perEventAgg[e].scores]));
  const ones = Object.fromEntries(AXES.map((a) => [a, 1]));
  const raceIds = [...new Set(compRecs.map((r) => r.evidenceId))].sort();
  const perRace = Object.fromEntries(raceIds.map((id) => { const ev = evOf(id); const agg = aggregateSource(compRecs.filter((r) => r.evidenceId === id), 'competition', W, { ...EXPO, ...ones }, asOf, cfg);
    return [id, { date: ev?.date, event: eventOf({ evidenceId: id }), time: ev?.meanTime, competition: ev?.competition || '', fixtureId: ev?.fixtureId || null, course: ev ? refs.ck(ev.pool) : null,
      pb: Boolean(ev?.pb), halves: ev?.halves || null, scores: agg.scores, counts: agg.counts }]; }));
  let R; let Rcounts;
  if (cfg.competitionAggregation === 'events' && events.length) {
    R = Object.fromEntries(AXES.map((a) => { const v = events.map((e) => perEvent[e][a]).filter(Number.isFinite); return [a, v.length ? v.reduce((x, y) => x + y, 0) / v.length : null]; }));
    Rcounts = src.competition.counts;
  } else { R = src.competition.scores; Rcounts = src.competition.counts; }
  const T = src.training.scores; const B = src.testing.scores;
  const cov = cfg.combine === 'coverage' ? { training: src.training.coverage, testing: src.testing.coverage, competition: src.competition.coverage } : null;
  let capability = combineSources({ training: T, testing: B }, cfg.sourceWeights, cov);
  let integrated = combineSources({ training: T, testing: B, competition: R }, cfg.sourceWeights, cov);
  if (cfg.combine === 'single') {
    capability = { scores: aggregateSource(scored.filter((r) => r.source !== 'competition'), '*', W, EXPO, asOf, cfg, cfg.sourceWeights).scores, effective: capability.effective };
    integrated = { scores: aggregateSource(scored, '*', W, EXPO, asOf, cfg, cfg.sourceWeights).scores, effective: integrated.effective };
  }
  const add = (...cs) => Object.fromEntries(AXES.map((a) => [a, cs.reduce((s, c) => s + (Number(c?.[a]) || 0), 0)]));
  return {
    engine: cfg.engine, engineVersion: cfg.engineVersion, referenceVersion: cfg.referenceVersion,
    sources: { training: T, testing: B, competition: R },
    capability: capability.scores, integrated: integrated.scores,
    effectiveWeights: { capability: capability.effective, integrated: integrated.effective },
    counts: { training: src.training.counts, testing: src.testing.counts, competition: Rcounts, capability: add(src.training.counts, src.testing.counts),
      integrated: add(src.training.counts, src.testing.counts, Rcounts) },
    coverage: { training: src.training.coverage, testing: src.testing.coverage, competition: src.competition.coverage },
    competitionPooled: src.competition.scores, events, perEvent, perEventCounts: Object.fromEntries(events.map((e) => [e, perEventAgg[e].counts])), perRace,
    provisional, scored, audit, issues: issues.filter((x) => String(x.swimmer) === String(swimmerId)),
    detail: { training: src.training.detail, testing: src.testing.detail, competition: src.competition.detail },
  };
}
