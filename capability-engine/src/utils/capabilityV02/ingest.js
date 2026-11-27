// AthlyraX capability engine v0.2 (EXPERIMENTAL) - raw application records -> qualified observations.
// Port of src/candidate/ingest.py. Intentional departure A-1: informal coachObservations are NOT turned into scored
// Technical Control evidence (Book 3 p. 293); they are returned separately as context.
import { PARAMS } from './calibration.js';
import { buildSwimmerScheduleDeliveryRatios } from '../swimmerTrainingDeliveryRatios.js';

const FIXED = { 'Max|25': 'M25', 'Max|50': 'M50', 'Max|100': 'M100', 'Max|200': 'M200', 'Max|400': 'M400',
  'Repeatability|25': 'R8x25', 'Repeatability|50': 'R8x50', 'Repeatability|100': 'R8x100' };
export const DEFAULT_SENDOFF = { M25: 90, M50: 180, M100: 300, M200: 480, M400: 720, R8x25: 30, R8x50: 60, R8x100: 90, A5x400: null };
const START_PROTOCOL = { M25: 'in-water', M50: 'in-water' };
export const ENERGY = ['EN1', 'EN2', 'EN3', 'LP', 'LT', 'SP'];
const str = (v) => (v === null || v === undefined ? '' : String(v));

export function sec(v) {
  const s = str(v).trim();
  if (!s) return null;
  const parts = s.split(':');
  const p = parts.map((x) => (/^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/.test(x) ? Number(x) : Number.NaN));
  if (p.some((x) => Number.isNaN(x))) return null;
  const t = p.length === 2 ? p[0] * 60 + p[1] : p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0];
  return t > 0 ? t : null;
}
export function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
export function strokeFamily(s) {
  const t = str(s).toLowerCase();
  if (t.includes('breast')) return 'breast';
  if (t.includes('back')) return 'back';
  if (t.includes('fly') || t.includes('butter')) return 'fly';
  if (t.includes('medley') || t === 'im') return 'medley';
  if (t.includes('free') || t.includes('crawl') || t === 'fr') return 'free';
  return 'unknown';
}
export function provenance(rec) {
  const src = str(rec?.measurementSource || rec?.resultSource).toLowerCase();
  if (!src) return 'unknown';
  if (src.includes('synthetic')) return 'synthetic';
  if (src.includes('coach')) return 'coach-entered';
  if (src.includes('device') || src.includes('wearable')) return 'device';
  if (src.includes('import')) return 'imported';
  return 'measured';
}
export function cyclesOf(rep) {
  const c = num(rep?.strokeCycles);
  if (c && str(rep?.strokeCycleUnit || 'cycles').startsWith('cycle')) return c;
  const n = num(rep?.overallStrokeCount || rep?.strokeCount); const unit = str(rep?.strokeCountUnit); const spc = num(rep?.strokesPerCycle);
  if (n && unit.startsWith('cycle')) return n;
  if (n && spc) return n / spc;
  return null;
}
// R-16: send-off from 'sendOff' / 'sendOffSeconds' only; 'setTimeSeconds' is ambiguous in the application -> unknown.
export function sendoffOf(s) {
  const v = sec(s?.sendOff);
  if (v) return v;
  const w = num(s?.sendOffSeconds);
  return w && w > 0 ? w : null;
}
// App linkage (departure A-4, data pathway only): a Planner set may carry no date of its own; its date is then the
// date of its linked schedule (scheduleId -> schedule.scheduleDate / date). Sets that carry a date are unaffected.
export function scheduleDateIndex(db) {
  const m = new Map();
  for (const sc of [...(db?.schedule || []), ...(db?.schedules || [])]) {
    const d = str(sc?.scheduleDate || sc?.date || sc?.startDate).slice(0, 10);
    if (sc?.id && d) m.set(sc.id, d);
  }
  return m;
}
export const setDateOf = (s, idx) => str(s?.scheduleDate || s?.date).slice(0, 10) || idx.get(s?.scheduleId) || idx.get(s?.trainingScheduleId) || '';
// Python round(): half to even (used where the reference rounds)
export const pyRound = (x, d) => { const f = 10 ** d; const y = x * f; const fl = Math.floor(y); const diff = y - fl; const r = diff > 0.5 ? fl + 1 : diff < 0.5 ? fl : (fl % 2 === 0 ? fl : fl + 1); return r / f; };
const key = (...parts) => parts.map((p) => str(p)).join('|');

export function buildObservations(db) {
  const swimmers = new Map((db?.swimmers || []).map((s) => [s.id, s]));
  const att = new Map();
  for (const a of db?.attendance || []) {
    const st = str(a?.status).toLowerCase();
    att.set(`${a?.swimmerId}|${a?.scheduleId}`, st === 'absent' ? 'absent' : st === 'partial' ? 'partial' : st === 'present' ? 'present' : 'unknown');
  }
  const obs = []; const issues = []; const context = [];
  const schedDates = scheduleDateIndex(db);
  const add = (o) => {
    const sw = swimmers.get(o.swimmer) || {};
    o.sex = str(sw.sex || sw.gender).toLowerCase();
    o.speed = o.time && o.distance ? o.distance / o.time : null;
    const pool = o.pool || 25;
    o.walls = o.distance ? Math.max(1, pyRound(o.distance / pool, 0)) : null;
    if (o.cycles && o.distance) {
      const uw = o.underwater_m;
      o.underwater_recorded = uw !== null && uw !== undefined;
      let allow = o.underwater_recorded ? uw : PARAMS.pushOffAllowanceM * o.walls;
      if (o.start === 'dive' && !o.underwater_recorded) allow += (o.breakout_distance || 10.0) - PARAMS.pushOffAllowanceM;
      const swum = o.distance - allow;
      o.dps = swum > 0 ? swum / o.cycles : null;
      o.stroke_rate = o.time && swum > 0 ? (o.cycles / ((o.time * swum) / o.distance)) * 60 : null;
      o.underwater_basis = o.underwater_recorded ? 'recorded' : 'ESTIMATED (5 m push-off allowance per wall; dive breakout)';
    } else { o.dps = null; o.stroke_rate = null; }
    o.mkey = key(o.swimmer, o.set_id, o.rep, pyRound(o.time || 0, 2));
    obs.push(o);
  };
  for (const s of db?.trainingSessionSets || []) {
    if (s?.isTestSet === true || str(s?.setType).toLowerCase() === 'test') continue;
    const date = setDateOf(s, schedDates);
    const energy = str(s?.energy || s?.energySystem).toUpperCase();
    const phase = str(s?.phase).toUpperCase();
    for (const [sw, res] of Object.entries(s?.resultsBySwimmer || {})) {
      const reps = res?.reps || [];
      if (!reps.length) continue;
      const status = att.get(`${sw}|${s?.scheduleId}`) || 'unknown';
      if (status === 'absent') { issues.push({ swimmer: sw, record: s?.id, issue: 'results recorded for an absence: quarantined' }); continue; }
      for (const r of reps) {
        const t = sec(r?.time || r?.overallTime);
        if (t === null) continue;
        add({ swimmer: sw, date, source: 'training', protocol: `set:${ENERGY.includes(energy) ? energy : 'UNCLASSIFIED'}`, set_id: s?.id,
          set_name: s?.setName || '', energy, phase, stroke: strokeFamily(s?.stroke), pool: num(s?.poolLength) || 25, distance: num(s?.distance),
          rep: Math.trunc(Number(r?.rep) || 0), nreps: reps.length, sendoff: sendoffOf(s), time: t, cycles: cyclesOf(r), provenance: provenance(r),
          attendance: status, heart_rate: num(r?.heartRate), start: 'push', underwater_m: num(r?.underwaterDistanceTotal) });
      }
    }
  }
  // A-5 (v0.2.1): attendance decides whose results count (application rule, canonicalSwimmerEvidence.js): a test in a
  // session where the swimmer is recorded absent (latest attendance revision), or a race the swimmer is not entered in
  // (event attendeeIds), is an attendance CONFLICT - listed in issues, never scored.
  const deliv = new Map();
  const absentAt = (sw, sch) => {
    const k = str(sch).trim(); if (!k) return false;
    if (!deliv.has(sw)) deliv.set(sw, buildSwimmerScheduleDeliveryRatios(db, sw));
    const d = deliv.get(sw).get(k);
    return Boolean(d) && d.attended === false;
  };
  const BUILTIN_TEMPLATE = { 'builtin-max': 'Max', 'builtin-test-max': 'Max', 'builtin-repeatability': 'Repeatability', 'builtin-test-repeatability': 'Repeatability', 'builtin-aerobic-durability-check': 'Aerobic / Durability Check', 'builtin-test-aerobic-durability': 'Aerobic / Durability Check' };
  for (const t of db?.tests || []) {
    if (absentAt(t?.swimmerId, t?.scheduleId)) { issues.push({ swimmer: t?.swimmerId, record: t?.id, issue: 'attendance conflict: test result recorded for an absent swimmer (not scored)' }); continue; }
    // Records saved by the application's Test Entry form carry the built-in template only as templateId (A-6); the
    // demonstration records carry templateName. Both name the same fixed battery.
    const tmpl = str(t?.templateName || t?.testType || BUILTIN_TEMPLATE[str(t?.templateId)] || '');
    const d = num(t?.distance);
    const reps = t?.repResults || [];
    if (str(t?.testFamily) === 'technical' || str(t?.resultType) === 'Rating') { addRating(obs, t); continue; }
    let proto;
    if (tmpl.includes('Durability Check')) proto = 'A5x400';
    else if (str(t?.protocolId) === 'DUR-FL') proto = `DUR-FL:${str(t?.condition)}`;
    else proto = FIXED[`${tmpl.startsWith('Max') ? 'Max' : tmpl.startsWith('Repeat') ? 'Repeatability' : tmpl}|${Math.trunc(d || 0)}`];
    if (!proto) proto = `custom:${str(t?.testName || tmpl)}`;
    const date = str(t?.date).slice(0, 10);
    const status = att.get(`${t?.swimmerId}|${t?.scheduleId}`) || 'unknown';
    reps.forEach((r, i) => {
      const tt = sec(r?.overallTime || r?.time);
      if (tt === null) return;
      add({ swimmer: t?.swimmerId, date, source: 'testing', protocol: proto, set_id: t?.id, set_name: t?.testName || '', energy: '', phase: '',
        stroke: strokeFamily(t?.stroke || 'free'), pool: num(t?.poolLength) || 25, distance: d, rep: Math.trunc(Number(r?.rep) || i + 1), nreps: reps.length,
        sendoff: num(t?.sendOffSeconds) || DEFAULT_SENDOFF[proto] || null, time: tt, cycles: cyclesOf(r), provenance: provenance(r?.measurementSource ? r : t),
        attendance: status, heart_rate: num(r?.heartRate), underwater_m: num(r?.underwaterDistanceTotal), power_w: num(r?.measuredPowerW || t?.measuredPowerW),
        start: START_PROTOCOL[proto] || 'unknown', condition: t?.condition, preload_m: num(t?.preloadMetres), preload_min: num(t?.preloadMinutes),
        preload_composition: t?.preloadComposition || null });
    });
  }
  for (const f of db?.fixtures || []) {
    const fdate = str(f?.startDate || f?.date).slice(0, 10);
    for (const e of f?.events || []) {
      const d = num(e?.distance);
      const pool = num(e?.poolLength) || num(f?.poolLength) || 25;
      for (const [sw, r] of Object.entries(e?.resultsBySwimmer || {})) {
        const t = sec(r?.time || r?.resultTime || r?.totalTime);
        if (!t || !d || t < d / 3.0) continue;
        const entrants = (e?.attendeeIds || []).map((x) => str(x).trim()).filter(Boolean);
        if (entrants.length && !entrants.includes(str(sw).trim())) { issues.push({ swimmer: sw, record: e?.id, issue: 'attendance conflict: race result for a swimmer not entered in the event (not scored)' }); continue; }
        const splits = r?.splits || [];
        const cyc = splits.map((x) => cyclesOf(x));
        add({ swimmer: sw, date: str(e?.date || fdate).slice(0, 10), source: 'competition', protocol: `race:${Math.trunc(d)}`, set_id: e?.id, fixture_id: f?.id,
          set_name: e?.event || e?.eventLabel || '', energy: '', phase: '', stroke: strokeFamily(e?.stroke), pool, distance: d, rep: 1, nreps: 1,
          sendoff: null, time: t, cycles: cyc.length && cyc.every((c) => c) ? cyc.reduce((a, b) => a + b, 0) : cyclesOf(r), provenance: provenance(r),
          attendance: 'present', heart_rate: null, start: 'dive', breakout_time: num(r?.breakoutTime), breakout_distance: num(r?.breakoutDistance),
          splits: splits.map((x) => ({ time: sec(x?.time), cycles: cyclesOf(x) })), split_length: num(r?.splitLength) });
      }
    }
  }
  for (const c of db?.coachObservations || []) {
    if (str(c?.focus).toLowerCase().includes('technical') && num(c?.rating)) {
      const o = { swimmer: c?.swimmerId, date: str(c?.date).slice(0, 10), source: 'training', protocol: 'coach-observation', kind: 'rating',
        items: { overall: num(c?.rating) }, variable_items: 0, n_items: 1, rater: c?.coachId, provenance: 'coach-entered',
        mkey: key('obs', c?.id), distance: null, speed: null, dps: null, time: null, informal: true };
      if (PARAMS.scoreInformalCoachObservations) obs.push(o); else context.push(o);
    }
  }
  const seen = new Set(); let unique = [];
  for (const o of obs) {
    if (seen.has(o.mkey)) { issues.push({ swimmer: o.swimmer, record: o.set_id, issue: 'duplicate measurement ignored' }); continue; }
    seen.add(o.mkey); unique.push(o);
  }
  const sig = new Map(); const drop = new Set(); const bySet = new Map();
  for (const o of unique) {
    if (o.kind === 'rating' || !o.set_id) continue;
    const k = `${o.swimmer}\u0000${o.set_id}`;
    if (!bySet.has(k)) bySet.set(k, []);
    bySet.get(k).push(o);
  }
  for (const [k, rows] of bySet) {
    rows.sort((a, b) => (a.rep || 0) - (b.rep || 0));
    const [sw, sid] = k.split('\u0000');
    const s = `${sw}|${rows[0].date}|${rows[0].distance}|${rows.map((r) => pyRound(r.time, 2)).join(',')}`;
    if (sig.has(s)) { drop.add(k); issues.push({ swimmer: sw, record: sid, issue: `duplicate of ${sig.get(s)}: ignored` }); } else sig.set(s, sid);
  }
  unique = unique.filter((o) => !drop.has(`${o.swimmer}\u0000${o.set_id}`));
  return { observations: unique, issues, context };
}

function addRating(obs, t) {
  const vals = t?.resultValues || (t?.repResults || [{}])[0]?.resultValues || {};
  const items = {}; let variable = 0; let n = 0;
  for (const [k, v] of Object.entries(vals)) {
    if (k.endsWith('_rating') && num(v)) { items[k.slice(0, -7)] = num(v); n += 1; }
    if (k.endsWith('_observation') && str(v).trim().toLowerCase() === 'variable') variable += 1;
  }
  if (!Object.keys(items).length) return;
  const name = str(t?.testName || t?.templateName);
  const kind = name.includes('Turn') ? 'turn' : name.includes('Start') ? 'start' : 'technique';
  obs.push({ swimmer: t?.swimmerId, date: str(t?.date).slice(0, 10), source: 'testing', protocol: `technical:${kind}`, kind: 'rating', items,
    variable_items: variable, n_items: n, rater: t?.ratedBy || t?.createdBy, stroke: strokeFamily(t?.stroke || name), provenance: 'coach-entered',
    mkey: key('rating', t?.id), distance: null, speed: null, dps: null, time: null });
}
