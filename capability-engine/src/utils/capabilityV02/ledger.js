// AthlyraX capability engine v0.2 (EXPERIMENTAL) - training ledger. Port of src/candidate/ledger.py.
// One physical workload row per (swimmer, set); prescribed, attendance-estimated and measured quantities kept apart;
// contexts overlap and are NEVER summed as physical metres.
// Intentional departure A-3 (assignment 12.3): additional intent contexts 'efficiency_intent' / 'robustness_intent' /
// 'technical' from the set's recorded name or description only; absent intent -> reported as "intent not recorded".
import { PARAMS } from './calibration.js';
import { scheduleDateIndex, setDateOf } from './ingest.js';
// v0.2.1 (O-1): the application's OWNER DELIVERY RULE is the single authority for delivered physical metres (Training
// graph, ISP summary, evidence cards and this measured-capability ledger all use it).
import { buildSwimmerScheduleDeliveryRatios, resolveSwimmerSetCompletion } from '../swimmerTrainingDeliveryRatios.js';
import { sendoffOf, sec, pyRound } from './ingest.js';

export const CODES = ['EN1', 'EN2', 'EN3', 'LP', 'LT', 'SP'];
const PRESENT = new Set(['present', 'attended', 'yes', 'full']);
const ABSENT = new Set(['absent', 'no', 'missed', 'excused', 'injured', 'ill', 'sick']);
const str = (v) => (v === null || v === undefined ? '' : String(v));
const EFF_RE = /(stroke[ -]?count|distance per (stroke|cycle)|\bdps\b|efficien|stroke length|count strokes)/i;
const TECH_RE = /(technic|drill|technique)/i;

function status(a) {
  if (!a) return 'unrecorded';
  const st = str(a.status).trim().toLowerCase();
  if (ABSENT.has(st) || a.attended === false || a.present === false) return 'absent';
  if (st === 'partial') return 'partial';
  if (PRESENT.has(st) || a.attended === true || a.present === true) return 'present';
  return `unrecognised:${st}`;
}
export function isoWeek(d) {
  const dt = new Date(`${d}T00:00:00Z`); const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const y = dt.getUTCFullYear(); const y0 = new Date(Date.UTC(y, 0, 1));
  const w = Math.ceil(((dt - y0) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

export function buildLedger(db, swimmerId, start, end, cs = null) {
  const deliv = buildSwimmerScheduleDeliveryRatios(db, swimmerId);
  const sw = (db?.swimmers || []).find((s) => s?.id === swimmerId) || {};
  const squads = new Set([sw.currentSquadId, ...(sw.squadIds || [])]);
  const rows = []; const seen = new Map();
  const schedDates = scheduleDateIndex(db);
  for (const s of db?.trainingSessionSets || []) {
    const dt = setDateOf(s, schedDates);
    if (!dt || !(start <= dt && dt <= end) || s?.isTestSet || str(s?.setType).toLowerCase() === 'test') continue;
    const dAtt = deliv.get(str(s?.scheduleId));
    const a = dAtt ? dAtt.row : undefined;
    const inSquad = [s?.squadId, ...(s?.squadIds || [])].some((q) => squads.has(q));
    if (!a && !inSquad) continue;
    const reps = Number(s?.reps) || 0; const dist = Number(s?.distance) || 0; const rounds = Number(s?.rounds) || 1;
    const prescribed = reps * dist * rounds;
    let st = status(a);
    if (dAtt && dAtt.attended === false) st = 'absent';
    const res = ((s?.resultsBySwimmer || {})[swimmerId] || {}).reps || [];
    const times = res.map((r) => sec(r?.time || r?.overallTime)).filter((t) => t);
    const measured = times.length ? times.length * dist : 0;
    const completion = resolveSwimmerSetCompletion(s, prescribed, dAtt);
    let est = completion.completed;
    const dbasis = completion.basis;
    let basis = { recorded: 'recorded delivery', assumed: 'attended, no metres recorded: programmed metres assumed (owner rule)',
      absent: 'recorded absent', unknown: 'unknown' }[dbasis];
    if (est === null && measured > 0) { est = measured; basis = 'results-evidenced (attendance unrecorded): lower bound'; }
    if (st === 'absent' && measured > 0) basis = 'CONTRADICTION: results recorded for an absence (excluded)';
    if (est !== null && dbasis === 'recorded' && measured > est + 1e-9) basis = 'INCONSISTENT: recorded repetitions exceed the partial-attendance estimate (estimate kept, flagged)';
    const pos = s?.order ?? s?.setOrder ?? s?.setIndex ?? s?.position ?? null;
    const k = JSON.stringify([s?.scheduleId, pos, s?.setName, reps, dist, rounds, str(s?.energy), times.map((t) => pyRound(t, 2))]);
    if (seen.has(k)) { rows.push({ set: s?.id, date: dt, duplicate_of: seen.get(k), unique_m: 0 }); continue; }
    seen.set(k, s?.id);
    const so = sendoffOf(s);
    const energy = str(s?.energy || s?.energySystem).toUpperCase();
    const meanT = times.length ? times.reduce((x, y) => x + y, 0) / times.length : null;
    const rest = so && meanT ? so - meanT : null;
    const iw = cs && times.length ? times.reduce((acc, t) => acc + dist * ((dist / t) / cs) ** 2, 0) : null;
    const name = `${str(s?.setName)} ${str(s?.description)}`;
    const ctx = new Set([CODES.includes(energy) ? energy : 'UNCLASSIFIED']);
    if (TECH_RE.test(str(s?.setName))) ctx.add('technical');
    if (so && (reps * rounds * so) / 60 >= PARAMS.durabilityMinMinutes) ctx.add('prolonged');
    if (EFF_RE.test(name)) { ctx.add('efficiency_intent'); if (reps * rounds >= 4) ctx.add('robustness_intent'); }
    const contradiction = st === 'absent' && measured > 0;
    rows.push({ set: s?.id, date: dt, week: isoWeek(dt), energy: CODES.includes(energy) ? energy : 'UNCLASSIFIED', prescribed_m: prescribed,
      attendance: st, estimated_delivered_m: est, delivery_basis: basis, measured_executed_m: measured, n_recorded_reps: times.length, reps, distance: dist,
      sendoff_s: so, sendoff_status: so ? 'recorded' : 'UNKNOWN (no sendOff field)', mean_rep_time_s: meanT, mean_rest_s: rest,
      rest_flag: rest !== null && rest < 0 ? 'IMPOSSIBLE: swim time exceeds send-off' : null, duration_min: so ? (reps * rounds * so) / 60 : null,
      intensity_weighted_m: iw, contexts: [...ctx].sort(), phase: str(s?.phase).toUpperCase() || null,
      unique_m: est !== null && !contradiction ? est : 0, unique_m_known: est !== null });
  }
  return rows;
}

export function summarise(rows, start, end) {
  const weeks = Math.max(1e-9, (days(start, end) + 1) / 7);
  const live = rows.filter((r) => !r.duplicate_of);
  const known = live.filter((r) => r.unique_m_known);
  const ctx = {}; const perWeek = {};
  for (const r of known) {
    for (const c of r.contexts) ctx[c] = (ctx[c] || 0) + r.unique_m;
    perWeek[r.week] = (perWeek[r.week] || 0) + r.unique_m;
  }
  const iw = known.map((r) => r.intensity_weighted_m).filter((x) => x !== null && x !== undefined);
  const total = known.reduce((a, r) => a + r.unique_m, 0);
  return {
    unique_physical_m: total, unique_physical_m_per_week: total / weeks,
    measured_executed_m: known.reduce((a, r) => a + r.measured_executed_m, 0),
    prescribed_m_attended_or_squad: live.reduce((a, r) => a + r.prescribed_m, 0),
    unknown_workload_prescribed_m: live.filter((r) => !r.unique_m_known).reduce((a, r) => a + r.prescribed_m, 0),
    attendance_coverage: live.length ? known.length / live.length : null,
    duplicates_ignored: rows.filter((r) => r.duplicate_of).length,
    context_exposure_m_per_week: Object.fromEntries(Object.keys(ctx).sort().map((k) => [k, ctx[k] / weeks])),
    context_note: 'contexts OVERLAP (one set may be EN1, technical and prolonged): never add them as physical metres',
    intensity_weighted_m_per_week: iw.length ? iw.reduce((a, b) => a + b, 0) / weeks : null,
    iso_week_unique_m: Object.fromEntries(Object.keys(perWeek).sort().map((k) => [k, perWeek[k]])), weeks,
    impossible_recovery_sets: known.filter((r) => r.rest_flag).length,
    unknown_sendoff_sets: known.filter((r) => !r.sendoff_s).length,
    sets_with_intent_text: live.filter((r) => r.contexts.includes('efficiency_intent')).length,
  };
}

export function workloadChange(cur, prev) {
  if (!prev || !cur) return { category: 'unknown (no comparison period)', ratio: null };
  const c = cur.unique_physical_m_per_week; const p = prev.unique_physical_m_per_week;
  if (cur.attendance_coverage === null || (cur.attendance_coverage || 0) < 0.5) return { category: 'unknown (attendance coverage < 50 % in the current window)', ratio: null };
  if (prev.attendance_coverage === null) return { category: 'no valid previous period (no training records)', ratio: null };
  if ((prev.attendance_coverage || 0) < 0.5) return { category: 'unknown (attendance coverage < 50 % in the previous window)', ratio: null };
  if (p === 0 && c === 0) return { category: 'zero training in both periods', ratio: null };
  if (p === 0) return { category: 'increased (from zero)', ratio: null };
  const r = c / p;
  const cat = c === 0 ? 'zero training' : r < PARAMS.loadReducedRatio ? 'reduced' : r > PARAMS.loadIncreasedRatio ? 'increased' : 'unchanged';
  return { category: cat, ratio: r };
}

export function trainingRadar(summary, prevSummary) {
  const ref = PARAMS.referenceWeekMetres;
  const cx = summary.context_exposure_m_per_week; const px = prevSummary?.context_exposure_m_per_week || {};
  const personal = (keys) => { const cur = keys.reduce((a, k) => a + (cx[k] || 0), 0); const pre = keys.reduce((a, k) => a + (px[k] || 0), 0); return pre ? (100 * cur) / pre : null; };
  const out = {};
  const en = { EN1: cx.EN1 || 0, EN2: cx.EN2 || 0, EN3: cx.EN3 || 0 };
  const enSum = en.EN1 + en.EN2 + en.EN3;
  out.aerobic_capacity = { metres_per_week: enSum, components_m_per_week: en,
    index_owner_reference: Math.min(100, (100 * enSum) / (ref.EN1 + ref.EN2 + ref.EN3)),
    component_index_owner_reference: Object.fromEntries(Object.entries(en).map(([k, v]) => [k, ref[k] ? Math.min(100, (100 * v) / ref[k]) : null])),
    reference_status: 'owner-approved reference week', calibration: 'calibrated' };
  const hi = { LP: cx.LP || 0, LT: cx.LT || 0 };
  out.anaerobic_capacity = { metres_per_week: hi.LP + hi.LT, components_m_per_week: hi, index_owner_reference: null,
    personal_relative_index_provisional: personal(['LP', 'LT']),
    reference_status: 'UNAVAILABLE in the owner reference week (LP = LT = 0); raw metres + PROVISIONAL personal-relative index', calibration: 'uncalibrated' };
  out.power_speed_expression = { metres_per_week: cx.SP || 0, index_owner_reference: Math.min(100, (100 * (cx.SP || 0)) / ref.SP), reference_status: 'owner-approved reference week', calibration: 'calibrated' };
  out.durability = { metres_per_week: cx.prolonged || 0, index_owner_reference: Math.min(100, (100 * (cx.prolonged || 0)) / ref.PROLONGED),
    reference_status: 'derived from the owner reference week (sets >= 20 min); PROVISIONAL eligibility', calibration: 'calibrated (derived)' };
  out.technical_control = { metres_per_week: cx.technical || 0, index_owner_reference: null, personal_relative_index_provisional: personal(['technical']),
    reference_status: 'UNAVAILABLE (no owner reference dose for technical work)', calibration: 'uncalibrated' };
  out.adaptability = { metres_per_week: cx.constraint_varied || 0, index_owner_reference: null, personal_relative_index_provisional: personal(['constraint_varied']),
    reference_status: 'UNAVAILABLE', calibration: 'uncalibrated' };
  const intentKnown = (summary.sets_with_intent_text || 0) > 0;
  out.efficiency = { metres_per_week: intentKnown ? cx.efficiency_intent || 0 : null, index_owner_reference: null, personal_relative_index_provisional: intentKnown ? personal(['efficiency_intent']) : null,
    reference_status: intentKnown ? 'UNAVAILABLE reference; exposure from sets whose recorded name/description states stroke-count / stroke-length intent' : 'INTENT NOT RECORDED in any set: classification unavailable (stroke-counted swimming in any set still provides capability evidence)',
    calibration: intentKnown ? 'uncalibrated' : 'unavailable' };
  out.robustness_of_efficiency = { metres_per_week: intentKnown ? cx.robustness_intent || 0 : null, index_owner_reference: null, personal_relative_index_provisional: intentKnown ? personal(['robustness_intent']) : null,
    reference_status: intentKnown ? 'UNAVAILABLE reference; repeated (>= 4 rep) sets with recorded stroke-count intent' : 'INTENT NOT RECORDED in any set: classification unavailable',
    calibration: intentKnown ? 'uncalibrated' : 'unavailable' };
  return out;
}

export function markConstraintVaried(rows) {
  const last = new Map();
  for (const r of [...rows].filter((x) => !x.duplicate_of).sort((a, b) => a.date.localeCompare(b.date))) {
    const k = `${r.distance}|${r.reps}|${r.energy}`;
    const prev = last.get(k);
    if (prev && r.sendoff_s && prev[1] && days(prev[0], r.date) <= PARAMS.adaptabilityPairWindowDays) {
      if ((Math.abs(r.sendoff_s - prev[1]) / Math.max(r.sendoff_s, prev[1])) * 100 >= PARAMS.adaptabilityMinChangeContinuousPct) r.contexts = [...new Set([...r.contexts, 'constraint_varied'])].sort();
    }
    if (r.sendoff_s) last.set(k, [r.date, r.sendoff_s]);
  }
  return rows;
}
