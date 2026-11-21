// One-time, protected repair of the synthetic demonstration stroke counts (owner review 21-11-2026). Ported unchanged
// from the verified dry-run script (checks branch, scripts/demo-stroke-model-v2-apply.mjs); run once by the backend at
// production start (scripts/upgrade-demo-robustness-v32.mjs, atomic write with backup), never by the browser.
// Regenerates stroke counts, cycles and rates of every synthetic swimmer with recorded stroke data using
// syntheticStrokeModelV2.js (progressive demonstration fatigue rule). Times, distances, attendance and sessions are never
// changed; every changed value is labelled synthetic-stroke-model-v2. Coach-entered, device, imported and unlabelled
// counts are never changed (whole effort left as it is), no count is invented, and the repair runs once
// (demoSeed.strokeModelV2Version).
import * as StrokeModelV2 from './syntheticStrokeModelV2.js';

const text = (v) => String(v ?? '').trim();
const secs = (v) => { const s = text(v); if (!s) return NaN; return s.includes(':') ? s.split(':').reduce((m, n) => m * 60 + Number(n), 0) : Number(s); };
const poolOf = (c) => (/^(50|lc|lcm)$/i.test(text(c)) ? 50 : 25);
const CATALOG_SENDOFF = { '8x25 repeatability': 30, '8x50 repeatability': 60, '8x100 repeatability': 90 };
export const UNKNOWN_REST_SECONDS = 15; // documented default when a repeated test has no send-off recorded

export function scopeSwimmers(db) {
  const has = new Set();
  for (const s of db.trainingSessionSets || []) for (const [id, r] of Object.entries(s.resultsBySwimmer || {})) if ((r.reps || []).some((x) => x.overallStrokeCount != null || x.strokeCount != null)) has.add(id);
  for (const t of db.tests || []) if ((t.repResults || []).some((x) => x.overallStrokeCount != null || x.strokeCount != null)) has.add(t.swimmerId);
  return new Set((db.swimmers || []).filter((s) => has.has(s.id)).map((s) => s.id));
}

// Safety (owner review 21-11-2026, item 5): one-time (demoSeed.strokeModelV2Version), and restricted to stroke counts
// the demo generators produced: a count is rewritten only if it already exists and carries synthetic/model provenance.
// An effort (test, set result, race) holding any coach-entered, device, imported or unlabelled count is left entirely
// as it is, so a later or manual change is never overwritten and no new count is invented.
export const STROKE_MODEL_V2_REPAIR_VERSION = 1;
const provenance = (row, parent) => `${row?.measurementSource || ''} ${row?.strokeCountSource || ''} ${row?.strokeCycleSource || ''} ${parent?.measurementSource || ''} ${parent?.resultSource || ''} ${parent?.strokeCountSource || ''}`;
const hasCount = (row) => [row?.strokeCount, row?.overallStrokeCount, row?.strokeCycles].some((v) => v !== undefined && v !== null && v !== '');
const protectedCount = (row) => /coach-entered|derived-from|wearable|athlyrax-|device|import/i.test(`${row?.measurementSource || ''} ${row?.strokeCountSource || ''} ${row?.strokeCycleSource || ''}`);
export const syntheticCount = (row, parent) => hasCount(row) && !protectedCount(row) && /synthetic|model|regenerat/i.test(provenance(row, parent));
/** An effort may be regenerated when it has at least one count and every count in it is synthetic. */
export const effortIsSynthetic = (rows, parent) => { const counted = rows.filter(hasCount); return counted.length > 0 && counted.every((row) => syntheticCount(row, parent)); };
export function applyModelV2(db, M = StrokeModelV2, { K, TAU, mode = 'progressive', KP, CAP } = {}) {
  if (Number(db?.__meta?.demoSeed?.strokeModelV2Version) >= STROKE_MODEL_V2_REPAIR_VERSION) return { next: db, stats: { alreadyApplied: true }, scope: scopeSwimmers(db) };
  const next = structuredClone(db); const scope = scopeSwimmers(db); const stats = { swimmers: scope.size, testReps: 0, trainingReps: 0, raceResults: 0, unchangedNoReference: 0, labelled: 0, skippedNotSynthetic: { tests: 0, training: 0, races: 0 } };
  const opts = { K, TAU, mode, KP, CAP };
  const sexOf = (id) => next.swimmers.find((s) => s.id === id)?.gender;
  // Level from recorded single efforts (Max tests and races).
  const levelOf = {};
  for (const id of scope) {
    const swims = [];
    for (const t of next.tests || []) if (t.swimmerId === id && (t.repResults || []).length === 1 && /max/i.test(`${t.testName || ''} ${t.templateName || ''}`))
      swims.push({ distance: Number(t.distance), seconds: secs(t.repResults[0].overallTime ?? t.repResults[0].time), stroke: text(t.stroke) || 'free', poolLength: poolOf(t.course ?? t.poolLength) });
    for (const f of next.fixtures || []) for (const ev of f.events || []) { const r = ev.resultsBySwimmer?.[id]; if (r) swims.push({ distance: Number(ev.distance), seconds: secs(r.time ?? r.resultTime ?? r.totalTime), stroke: text(ev.stroke) || 'free', poolLength: poolOf(f.course ?? f.poolLength) }); }
    levelOf[id] = M.swimmerLevel(swims, sexOf(id));
  }
  const ctx = (id, seed) => ({ level: levelOf[id], sex: sexOf(id), seed, ...opts });
  const writeReps = (reps, gen) => reps.map((rep, k) => (gen?.[k] && hasCount(rep) ? { ...rep, ...M.fieldsFor(gen[k]) } : rep));
  for (const s of next.swimmers) if (scope.has(s.id) && s.synthetic !== true) { s.synthetic = true; s.measurementSource = 'synthetic-demo'; stats.labelled += 1; }
  for (const t of next.tests || []) {
    if (!scope.has(t.swimmerId) || !(t.repResults || []).length) continue;
    if (!effortIsSynthetic([...t.repResults, ...t.repResults.flatMap((r) => r.splits || [])], t)) { stats.skippedNotSynthetic.tests += 1; continue; }
    const name = `${t.testName || ''} ${t.templateName || ''}`.toLowerCase(); const d = Number(t.distance);
    const single = t.repResults.length === 1;
    const zone = single ? M.raceZone(d) : /repeat/.test(name) ? (d <= 25 ? 'sp' : d <= 50 ? 'lp' : 'lt') : 'en2';
    const times = t.repResults.map((r) => secs(r.overallTime ?? r.time));
    const sendOff = Number(t.sendOff) > 0 ? Number(t.sendOff) : CATALOG_SENDOFF[text(t.testName).toLowerCase()] ?? (Math.max(...times) + UNKNOWN_REST_SECONDS);
    const gen = M.generateSetReps(times.map((x) => ({ seconds: x })), { distance: d, stroke: text(t.stroke) || 'free', poolLength: poolOf(t.course ?? t.poolLength), zone, sendOffSeconds: sendOff, dive: single }, ctx(t.swimmerId, `${t.id}`));
    if (!gen) { stats.unchangedNoReference += 1; continue; }
    t.repResults = writeReps(t.repResults, gen).map((rep, k) => {
      if (!Array.isArray(rep.splits) || !rep.splits.length) return rep;
      // splits: cycles of the rep spread in proportion to each split's time
      const cum = rep.splits.map((sp) => secs(sp.time)); const seg = cum.map((c, i) => c - (i ? cum[i - 1] : 0));
      const total = gen[k].strokeCycles; const exact = seg.map((x) => total * x / seg.reduce((a, b) => a + b, 0));
      const cyc = exact.map(Math.floor); let miss = total - cyc.reduce((a, b) => a + b, 0);
      exact.map((x, i) => [i, x - Math.floor(x)]).sort((a, b) => b[1] - a[1]).forEach(([i]) => { if (miss > 0) { cyc[i] += 1; miss -= 1; } });
      return { ...rep, splits: rep.splits.map((sp, i) => ({ ...sp, strokeCount: cyc[i] * gen[k].strokesPerCycle, strokeCycles: cyc[i], strokeCountUnit: 'strokes', strokeCountSource: M.SYNTHETIC_STROKE_MODEL_V2 })) };
    });
    stats.testReps += t.repResults.length;
  }
  for (const set of next.trainingSessionSets || []) for (const [id, r] of Object.entries(set.resultsBySwimmer || {})) {
    if (!scope.has(id) || !(r?.reps || []).length) continue;
    if (!effortIsSynthetic([...r.reps, ...r.reps.flatMap((x) => x.splits || [])], r)) { stats.skippedNotSynthetic.training += 1; continue; }
    const times = r.reps.map((x) => secs(x.overallTime ?? x.time));
    const sendOff = Number(set.setTimeSeconds) > 0 ? Number(set.setTimeSeconds) : secs(set.sendOff);
    const zone = text(set.energySystem || set.energy).toLowerCase() || 'en1'; const dist = Number(set.distance);
    const strokeName = text(set.stroke) || 'free';
    let gen;
    if (/\bim\b|medley/i.test(strokeName) && dist % 100 === 0) {
      // Individual medley: each quarter with its own stroke reference (fly, back, breast, free), quarter time in
      // proportion to the elite speed of that stroke; cycles and strokes are summed (ASSUMPTION: same level ratio).
      const order = ['fly', 'back', 'breast', 'free']; const q = dist / 4; const sx = next.swimmers.find((x) => x.id === id)?.gender;
      const eliteT = order.map((st) => q / (M.eliteReference({ distance: q, stroke: st, sex: sx, poolLength: 25 })?.v || 1)); const sumT = eliteT.reduce((a2, b2) => a2 + b2, 0);
      const parts = order.map((st, i) => M.generateSetReps(times.map((x) => ({ seconds: x * eliteT[i] / sumT })), { distance: q, stroke: st, poolLength: 25, zone, sendOffSeconds: Number.isFinite(sendOff) ? sendOff * eliteT[i] / sumT : NaN }, ctx(id, `${set.id}|${id}|${st}`)));
      gen = parts.some((x) => !x) ? null : times.map((t, k) => { const g = parts.map((x) => x[k]); const cyc = g.reduce((a2, b2) => a2 + b2.strokeCycles, 0);
        return { strokeCycles: cyc, strokeCount: g.reduce((a2, b2) => a2 + b2.strokeCount, 0), strokesPerCycle: null, strokeRate: Math.round((cyc / (t * (dist - 20) / dist)) * 600) / 10, k }; });
    } else {
      // Choice: the stroke actually swum is not recorded; generated as freestyle (ASSUMPTION, documented).
      gen = M.generateSetReps(times.map((x) => ({ seconds: x })), { distance: dist, stroke: /choice/i.test(strokeName) ? 'free' : strokeName, poolLength: 25,
        zone, sendOffSeconds: Number.isFinite(sendOff) ? sendOff : NaN }, ctx(id, `${set.id}|${id}`));
    }
    if (!gen || gen.some((g) => !g)) { stats.unchangedNoReference += 1; continue; }
    r.reps = writeReps(r.reps, gen); stats.trainingReps += r.reps.length;
  }
  for (const f of next.fixtures || []) {
    const pool = poolOf(f.course ?? f.poolLength);
    for (const ev of f.events || []) for (const [id, r] of Object.entries(ev.resultsBySwimmer || {})) {
      if (!scope.has(id)) continue;
      const splitRows = [...(r.splits || []), ...Object.values(r.splitRecordsByLength || {}).flat()];
      // An unlabelled race total that equals the sum of its synthetic split counts is derived from them (synthetic).
      const countedSplits = (r.splits || []).filter(hasCount);
      const derivedTotal = hasCount(r) && !protectedCount(r) && countedSplits.length > 0 && countedSplits.every((x) => syntheticCount(x, null))
        && Number(r.strokeCount) === countedSplits.reduce((a, x) => a + Number(x.strokeCount), 0);
      const raceRows = derivedTotal ? splitRows : [r, ...splitRows];
      if ([r, ...splitRows].some(protectedCount) || !effortIsSynthetic(raceRows, r)) { stats.skippedNotSynthetic.races += 1; continue; }
      const d = Number(ev.distance); const total = secs(r.time ?? r.resultTime ?? r.totalTime); const n = Math.max(1, Math.round(d / pool));
      if (!(total > 0)) continue;
      // per-length times: from per-pool-length split records, cumulative splits, or evenly when none were recorded
      let lens = null;
      const byPool = r.splitRecordsByLength?.[String(pool)];
      if (Array.isArray(byPool) && byPool.length === n) { const v = byPool.map((x) => secs(x.time)); const cumulative = v.every((x, i) => !i || x > v[i - 1]) && Math.abs(v[n - 1] - total) < 0.05; lens = cumulative ? v.map((x, i) => x - (i ? v[i - 1] : 0)) : v; }
      else if (Array.isArray(r.splits) && r.splits.length) { const cum = r.splits.map((x) => secs(x.time)); const step = d / r.splits.length; const per = Math.round(pool / step);
        if (per >= 1 && r.splits.length === n * per) { lens = []; for (let i = 0; i < n; i += 1) lens.push(cum[(i + 1) * per - 1] - (i ? cum[i * per - 1] : 0)); } }
      if (!lens) lens = Array.from({ length: n }, () => total / n);
      const gen = M.generateRaceLengths(lens, { distance: d, stroke: text(ev.stroke) || 'free', poolLength: pool }, ctx(id, `${f.id}|${ev.id}|${id}`));
      if (!gen) { stats.unchangedNoReference += 1; continue; }
      const rows = (rr, segLen) => { const group = Math.round(pool / segLen) || 1; // segLen may be shorter than the pool (25 m splits in a 50 m pool)
        if (segLen === pool) return rr.map((x, i) => ({ ...x, strokeCount: gen[i].strokeCount, strokeCycles: gen[i].strokeCycles, strokeCountUnit: 'strokes', strokeCountSource: M.SYNTHETIC_STROKE_MODEL_V2 }));
        if (segLen > pool) { const per = Math.round(segLen / pool); return rr.map((x, i) => { const g = gen.slice(i * per, (i + 1) * per); return { ...x, strokeCount: g.reduce((a, b) => a + b.strokeCount, 0), strokeCycles: g.reduce((a, b) => a + b.strokeCycles, 0), strokeCountUnit: 'strokes', strokeCountSource: M.SYNTHETIC_STROKE_MODEL_V2 }; }); }
        return rr.map((x, i) => { const g = gen[Math.floor(i / group)]; const part = i % group === group - 1 ? g.strokeCycles - Math.floor(g.strokeCycles / group) * (group - 1) : Math.floor(g.strokeCycles / group);
          return { ...x, strokeCount: part * g.strokesPerCycle, strokeCycles: part, strokeCountUnit: 'strokes', strokeCountSource: M.SYNTHETIC_STROKE_MODEL_V2 }; }); };
      for (const [key, rr] of Object.entries(r.splitRecordsByLength || {})) if (Array.isArray(rr) && rr.length) r.splitRecordsByLength[key] = rows(rr, Number(key));
      if (Array.isArray(r.splits) && r.splits.length && r.splits.some((x) => x.strokeCount != null)) r.splits = rows(r.splits, d / r.splits.length);
      if (r.strokeCount != null) { r.strokeCount = gen.reduce((a, b) => a + b.strokeCount, 0); r.strokeCycles = gen.reduce((a, b) => a + b.strokeCycles, 0); r.strokeCountSource = M.SYNTHETIC_STROKE_MODEL_V2; }
      stats.raceResults += 1;
    }
  }
  next.__meta = { ...(next.__meta || {}), demoSeed: { ...(next.__meta?.demoSeed || {}), strokeModelV2Version: STROKE_MODEL_V2_REPAIR_VERSION, strokeModelV2Stats: stats } };
  return { next, stats, scope };
}
