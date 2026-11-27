// AthlyraX Final Model C - evidence index: one observation per recorded repetition / test swim / race, read from the
// stored records without modifying them. Same ingestion rules as the approved simulation (attendance decides whose
// results count; absent-session results and races a swimmer was not entered in are quarantined; duplicate measurements
// and duplicated sets are counted once).
import { buildSwimmerScheduleDeliveryRatios } from '../swimmerTrainingDeliveryRatios.js';

const FIXED = { 'Max|25': 'M25', 'Max|50': 'M50', 'Max|100': 'M100', 'Max|200': 'M200', 'Max|400': 'M400',
  'Repeatability|25': 'R8x25', 'Repeatability|50': 'R8x50', 'Repeatability|100': 'R8x100' };
// Original protocol send-offs of the fixed battery (unchanged test protocols)
export const PROTOCOL_SENDOFF = Object.freeze({ M25: 90, M50: 180, M100: 300, M200: 480, M400: 720, R8x25: 30, R8x50: 60, R8x100: 90, A5x400: null });
const ENERGY = ['EN1', 'EN2', 'EN3', 'LP', 'LT', 'SP'];
const str = (v) => (v === null || v === undefined ? '' : String(v));
const BUILTIN_TEMPLATE = { 'builtin-max': 'Max', 'builtin-test-max': 'Max', 'builtin-repeatability': 'Repeatability', 'builtin-test-repeatability': 'Repeatability',
  'builtin-aerobic-durability-check': 'Aerobic / Durability Check', 'builtin-test-aerobic-durability': 'Aerobic / Durability Check' };

export function sec(v) {
  const s = str(v).trim(); if (!s) return null;
  const p = s.split(':').map((x) => (/^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/.test(x) ? Number(x) : Number.NaN));
  if (p.some((x) => Number.isNaN(x))) return null;
  const t = p.length === 2 ? p[0] * 60 + p[1] : p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0];
  return t > 0 ? t : null;
}
const num = (v) => { if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
export function strokeFamily(s) {
  const t = str(s).toLowerCase();
  if (t.includes('breast')) return 'breast'; if (t.includes('back')) return 'back'; if (t.includes('fly') || t.includes('butter')) return 'fly';
  if (t.includes('medley') || t === 'im') return 'medley'; if (t.includes('free') || t.includes('crawl') || t === 'fr') return 'free';
  return 'unknown';
}
const sendoffOf = (s) => { const v = sec(s?.sendOff); if (v) return v; const w = num(s?.sendOffSeconds); return w && w > 0 ? w : null; };
const r2 = (x) => { const f = 100; const y = x * f; const fl = Math.floor(y); const diff = y - fl; const r = diff > 0.5 ? fl + 1 : diff < 0.5 ? fl : (fl % 2 === 0 ? fl : fl + 1); return r / f; };
function scheduleDateIndex(db) {
  const m = new Map();
  for (const sc of [...(db?.schedule || []), ...(db?.schedules || [])]) { const d = str(sc?.scheduleDate || sc?.date || sc?.startDate).slice(0, 10); if (sc?.id && d) m.set(sc.id, d); }
  return m;
}

export function buildObservations(db) {
  const swimmers = new Map((db?.swimmers || []).map((s) => [s.id, s]));
  const att = new Map();
  for (const a of db?.attendance || []) { const st = str(a?.status).toLowerCase(); att.set(`${a?.swimmerId}|${a?.scheduleId}`, st === 'absent' ? 'absent' : st === 'partial' ? 'partial' : st === 'present' ? 'present' : 'unknown'); }
  const obs = []; const issues = []; const dates = scheduleDateIndex(db);
  const add = (o) => { const sw = swimmers.get(o.swimmer) || {}; o.sex = str(sw.sex || sw.gender).toLowerCase(); o.speed = o.time && o.distance ? o.distance / o.time : null;
    o.mkey = [o.swimmer, o.set_id, o.rep, r2(o.time || 0)].map(str).join('|'); obs.push(o); };
  for (const s of db?.trainingSessionSets || []) {
    if (s?.isTestSet === true || str(s?.setType).toLowerCase() === 'test') continue;
    const date = str(s?.scheduleDate || s?.date).slice(0, 10) || dates.get(s?.scheduleId) || dates.get(s?.trainingScheduleId) || '';
    const energy = str(s?.energy || s?.energySystem).toUpperCase();
    for (const [sw, res] of Object.entries(s?.resultsBySwimmer || {})) {
      const reps = res?.reps || []; if (!reps.length) continue;
      const status = att.get(`${sw}|${s?.scheduleId}`) || 'unknown';
      if (status === 'absent') { issues.push({ swimmer: sw, record: s?.id, issue: 'results recorded for an absence: not scored' }); continue; }
      for (const r of reps) {
        const t = sec(r?.time || r?.overallTime); if (t === null) continue;
        add({ swimmer: sw, date, source: 'training', protocol: `set:${ENERGY.includes(energy) ? energy : 'UNCLASSIFIED'}`, set_id: s?.id, energy,
          stroke: strokeFamily(s?.stroke), pool: num(s?.poolLength) || 25, distance: num(s?.distance), rep: Math.trunc(Number(r?.rep) || 0), sendoff: sendoffOf(s), time: t });
      }
    }
  }
  const deliv = new Map();
  const absentAt = (sw, sch) => { const k = str(sch).trim(); if (!k) return false; if (!deliv.has(sw)) deliv.set(sw, buildSwimmerScheduleDeliveryRatios(db, sw)); const d = deliv.get(sw).get(k); return Boolean(d) && d.attended === false; };
  for (const t of db?.tests || []) {
    if (absentAt(t?.swimmerId, t?.scheduleId)) { issues.push({ swimmer: t?.swimmerId, record: t?.id, issue: 'test result recorded for an absent swimmer: not scored' }); continue; }
    const tmpl = str(t?.templateName || t?.testType || BUILTIN_TEMPLATE[str(t?.templateId)] || '');
    const d = num(t?.distance); const reps = t?.repResults || [];
    if (str(t?.testFamily) === 'technical' || str(t?.resultType) === 'Rating') continue;
    let proto;
    if (tmpl.includes('Durability Check')) proto = 'A5x400';
    else if (str(t?.protocolId) === 'DUR-FL') proto = `DUR-FL:${str(t?.condition)}`;
    else proto = FIXED[`${tmpl.startsWith('Max') ? 'Max' : tmpl.startsWith('Repeat') ? 'Repeatability' : tmpl}|${Math.trunc(d || 0)}`];
    if (!proto) proto = `custom:${str(t?.testName || tmpl)}`;
    const date = str(t?.date).slice(0, 10);
    reps.forEach((r, i) => {
      const tt = sec(r?.overallTime || r?.time); if (tt === null) return;
      add({ swimmer: t?.swimmerId, date, source: 'testing', protocol: proto, set_id: t?.id, energy: '', stroke: strokeFamily(t?.stroke || 'free'), pool: num(t?.poolLength) || 25,
        distance: d, rep: Math.trunc(Number(r?.rep) || i + 1), sendoff: num(t?.sendOffSeconds) || PROTOCOL_SENDOFF[proto] || null, time: tt, testName: str(t?.testName || tmpl) });
    });
  }
  for (const f of db?.fixtures || []) {
    const fdate = str(f?.startDate || f?.date).slice(0, 10);
    for (const e of f?.events || []) {
      const d = num(e?.distance); const pool = num(e?.poolLength) || num(f?.poolLength) || 25;
      for (const [sw, r] of Object.entries(e?.resultsBySwimmer || {})) {
        const t = sec(r?.time || r?.resultTime || r?.totalTime); if (!t || !d || t < d / 3.0) continue;
        const entrants = (e?.attendeeIds || []).map((x) => str(x).trim()).filter(Boolean);
        if (entrants.length && !entrants.includes(str(sw).trim())) { issues.push({ swimmer: sw, record: e?.id, issue: 'race result for a swimmer not entered in the event: not scored' }); continue; }
        add({ swimmer: sw, date: str(e?.date || fdate).slice(0, 10), source: 'competition', protocol: `race:${Math.trunc(d)}`, set_id: e?.id, fixture_id: f?.id, energy: '',
          stroke: strokeFamily(e?.stroke), pool, distance: d, rep: 1, sendoff: null, time: t, splits: (r?.splits || []).map((x) => ({ time: sec(x?.time) })),
          competition: str(f?.name || f?.title || f?.fixtureName || ''), eventLabel: str(e?.event || e?.eventLabel || ''), pb: Boolean(r?.pb || r?.personalBest) });
      }
    }
  }
  const seen = new Set(); let unique = [];
  for (const o of obs) { if (seen.has(o.mkey)) { issues.push({ swimmer: o.swimmer, record: o.set_id, issue: 'duplicate measurement ignored' }); continue; } seen.add(o.mkey); unique.push(o); }
  const sig = new Map(); const drop = new Set(); const bySet = new Map();
  for (const o of unique) { if (!o.set_id) continue; const k = `${o.swimmer}\u0000${o.set_id}`; if (!bySet.has(k)) bySet.set(k, []); bySet.get(k).push(o); }
  for (const [k, rows] of bySet) {
    rows.sort((a, b) => (a.rep || 0) - (b.rep || 0)); const [sw, sid] = k.split('\u0000');
    const s = `${sw}|${rows[0].date}|${rows[0].distance}|${rows.map((r) => r2(r.time)).join(',')}`;
    if (sig.has(s)) { drop.add(k); issues.push({ swimmer: sw, record: sid, issue: `duplicate of ${sig.get(s)}: ignored` }); } else sig.set(s, sid);
  }
  unique = unique.filter((o) => !drop.has(`${o.swimmer}\u0000${o.set_id}`));
  return { observations: unique, issues };
}

// Cached per db object and content signature (records are never mutated here).
const cache = new WeakMap();
// Identity + length of every input collection: a replaced collection (the application's immutable update path) or a
// changed length invalidates the index. The Analysis memoisation already keys on the db object itself.
const KEYS = ['swimmers', 'schedule', 'schedules', 'trainingSessionSets', 'attendance', 'tests', 'fixtures'];
const ids = new WeakMap(); let nextId = 1;
function contentSignature(db) {
  return KEYS.map((k) => { const v = db?.[k]; if (!v || typeof v !== 'object') return '-'; if (!ids.has(v)) { ids.set(v, nextId); nextId += 1; } return `${ids.get(v)}:${Array.isArray(v) ? v.length : Object.keys(v).length}`; })
    .join('|') + `|${db?.revision ?? db?.__revision ?? ''}`;
}
export function observationsFor(db) {
  if (!db || typeof db !== 'object') return { observations: [], issues: [] };
  const sig = contentSignature(db); const hit = cache.get(db);
  if (hit && hit.sig === sig) return hit;
  const built = { sig, ...buildObservations(db) };
  // per-swimmer observation lists and the set lookup, built once per database (read-only)
  built.bySwimmer = new Map(); for (const o of built.observations) { const k = String(o.swimmer); if (!built.bySwimmer.has(k)) built.bySwimmer.set(k, []); built.bySwimmer.get(k).push(o); }
  built.setById = new Map((db?.trainingSessionSets || []).map((x) => [String(x.id), x]));
  cache.set(db, built); return built;
}

// Race halves from stored splits (cumulative or per-lap, detected against the official time).
export function raceHalves(o, toleranceSeconds) {
  if (o?.source !== 'competition' || !Array.isArray(o.splits) || o.splits.length < 2 || !(o.time > 0)) return null;
  const v = o.splits.map((x) => Number(x?.time)); if (v.some((t) => !(t > 0))) return null;
  let laps; const sum = v.reduce((a, b) => a + b, 0);
  if (Math.abs(v[v.length - 1] - o.time) < toleranceSeconds) laps = v.map((t, i) => t - (i ? v[i - 1] : 0));
  else if (Math.abs(sum - o.time) < toleranceSeconds) laps = v; else return null;
  if (laps.length % 2 || laps.some((x) => !(x > 0))) return null;
  const h = laps.length / 2; return [laps.slice(0, h).reduce((a, b) => a + b, 0), laps.slice(h).reduce((a, b) => a + b, 0)];
}

export function evidenceIndex(observations, swimmerId, db, cfg, prebuilt = null) {
  const setById = prebuilt?.setById || new Map((db?.trainingSessionSets || []).map((x) => [String(x.id), x]));
  const mine = prebuilt?.bySwimmer ? (prebuilt.bySwimmer.get(String(swimmerId)) || []).filter((o) => o.swimmer === swimmerId) : observations.filter((o) => o.swimmer === swimmerId);
  const by = new Map();
  for (const o of mine) { const key = o.source === 'competition' ? `${o.fixture_id}:${o.set_id}:${swimmerId}` : String(o.set_id); if (!by.has(key)) by.set(key, []); by.get(key).push(o); }
  const out = new Map();
  for (const [k, rows] of by) {
    const r0 = rows[0]; const sp = rows.map((r) => r.speed).filter((v) => v > 0); const tm = rows.map((r) => r.time).filter((v) => v > 0);
    const x = setById.get(String(r0.set_id));
    out.set(k, { key: k, source: r0.source, protocol: r0.protocol, energy: String(r0.energy || '').toUpperCase(), distance: r0.distance, stroke: r0.stroke,
      pool: r0.pool, sendoff: r0.sendoff, nreps: rows.length, date: r0.date, meanSpeed: sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : null,
      repSpeeds: [...rows].sort((a, b) => (a.rep || 0) - (b.rep || 0)).map((r) => r.speed).filter((v) => v > 0), splits: r0.splits || null,
      prescription: x ? { targetPace: sec(x.targetPace), rest: sec(x.rest), modality: String(x.modality || '').toLowerCase(), setName: String(x.setName || '') } : null,
      halves: raceHalves(r0, cfg.references.splitToleranceSeconds), meanTime: tm.length ? tm.reduce((a, b) => a + b, 0) / tm.length : null,
      metres: rows.length * (r0.distance || 0), sex: r0.sex, fixtureId: r0.fixture_id || null, eventId: r0.source === 'competition' ? r0.set_id : null,
      competition: r0.competition || '', eventLabel: r0.eventLabel || '', pb: Boolean(r0.pb), testName: r0.testName || '' });
  }
  return { byKey: out, mine };
}
