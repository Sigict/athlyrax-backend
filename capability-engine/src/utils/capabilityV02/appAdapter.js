// AthlyraX capability engine v0.2 (EXPERIMENTAL) - the ONLY bridge between the verified v0.2 calculation and the app's
// radar contract (buildCanonicalIspRadars / resolveCanonicalRadarDisplay). It performs no calculation of its own beyond
// selecting outputs: every score comes from evaluateSwimmer (engine.js), verified against the Python reference.
//
// The app's four radar slots (RADAR_KINDS) carry the four v0.2 radars one-to-one (assignment section 19):
//   'training'    -> TRAINING radar: training stimulus (training_stimulus[d].index_owner_reference) where an owner-
//                    approved reference week exists (calibrated / calibrated (derived)); other axes unscored, with status.
//   'capability'  -> TESTING radar: the testing source (last battery) - shown in the slot formerly titled
//                    "Capability / ISP Evidence".
//   'competition' -> COMPETITION radar: the competition source (last 2 competitions). NEVER copied from Capability.
//   'integrated'  -> CAPABILITY radar: v0.2 capability over all three sources (0.30 / 0.50 / 0.20; 42 d / last battery /
//                    last 2 competitions).
// Expression and Repeatability (Model C) travel side by side in the v02 payload and are never combined.
import { buildObservations } from './ingest.js';
import { evaluateSwimmer, evaluateSquad, capabilityFromSources, DOMAINS, ENGINE_VERSION, LEVEL_DOMAINS } from './engine.js';
import { CALIBRATION_VERSION, APP_CALIBRATION_VERSION, PARAMS } from './calibration.js';

export const V02_SOURCE = 'athlyrax-capability-v0.2-experimental';
export const V02_DEPARTURES = Object.freeze([
  { id: 'A-1', text: 'Informal coach observations are context only and never alter a score (Book 3 p. 293).' },
  { id: 'A-2', text: 'Technical Control is a PROVISIONAL rating index from structured coach ratings, not a calibrated measurement.' },
  { id: 'A-3', text: 'Efficiency / Robustness training exposure is shown only where a set name or description records stroke-count or stroke-length intent; otherwise "intent not recorded".' },
]);
export const V02_LABELS = Object.freeze({
  experimental: 'Experimental calculation v0.2 (isolated test version; not validated against real swimmers)',
  underwater: 'Distance per cycle uses an ESTIMATED underwater convention (5 m push-off allowance per wall; dive breakout) unless underwater distance is recorded.',
  technical: 'Technical Control: provisional rating index (structured coach ratings 1-5 rescaled to 0-100).',
  modelC: 'Expression (performance level) and Repeatability (retention under the domain\'s repeated task) are different constructs on different scales; they are shown side by side and never combined into one number.',
  training: 'Training radar = training stimulus exposure against the owner-approved reference week (not capability). Axes without an approved reference week are not scored.',
});
const CONTEXT_FOR_DOMAIN = {
  aerobic_capacity: ['EN1', 'EN2', 'EN3'], anaerobic_capacity: ['LP', 'LT'], power_speed_expression: ['SP'], durability: ['prolonged'],
  technical_control: ['technical'], adaptability: ['constraint_varied'], efficiency: ['efficiency_intent'], robustness_of_efficiency: ['robustness_intent'],
};
const TRAINING_CALIBRATED = new Set(['calibrated', 'calibrated (derived)']);
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const today = () => new Date().toISOString().slice(0, 10);

// Cache key for every v0.2 calculation: it changes whenever any input of the calculation changes - swimmers (sex, squad
// membership), schedules (dates), sessions, sets (send-offs, repetition times, stroke counts, delivered volume),
// attendance (status, volume, revisions), tests, competitions, coach observations, planner weeks (phase) and
// calibration - including an in-place change of one field of an existing record, from any workflow.
//
// L-09 (v0.2.2): the content is re-read on EVERY top-level calculation, so an edit followed by a recalculation in the
// same synchronous task is seen at once (no reliance on a later task, a reload or elapsed time). Inside ONE calculation
// (withEvidenceBatch: an individual profile, or a squad view looping over its swimmers) no outside code can run, so the
// content is read once for that call graph.
const SIGNATURE_KEYS = ['swimmers', 'squads', 'schedule', 'schedules', 'trainingSessions', 'trainingSessionSets', 'attendance', 'tests',
  'fixtures', 'coachObservations', 'trainingPlannerWeeks', 'trainingDemandCalibration', 'capabilityCalibration', 'efficiencyReferenceOverrides'];
const arrayIds = new WeakMap(); let nextArrayId = 1;
// Structural part (identity + length of every input array/object): exact and cheap.
function structuralSignature(db) {
  return SIGNATURE_KEYS.map((k) => {
    const v = db[k];
    if (!v || typeof v !== 'object') return `${k}:${v ?? '-'}`;
    if (!arrayIds.has(v)) { arrayIds.set(v, nextArrayId); nextArrayId += 1; }
    return `${k}:${arrayIds.get(v)}:${Array.isArray(v) ? v.length : Object.keys(v).length}`;
  }).join('|');
}
// Content part: the serialised inputs of this db object are kept and compared exactly (string equality); a different
// content gets a new content id. No hashing, so no collision is possible.
const contentState = new WeakMap(); let nextContentId = 1;
function contentId(db) {
  let json;
  try { json = JSON.stringify(SIGNATURE_KEYS.map((k) => db[k] ?? null)); } catch { return `uncacheable-${nextContentId++}`; }
  const prev = contentState.get(db);
  if (prev && prev.json === json) return prev.id;
  const id = nextContentId; nextContentId += 1;
  contentState.set(db, { json, id });
  return id;
}
let batchMemo = null; let batchDepth = 0;
export function withEvidenceBatch(fn) {
  batchDepth += 1;
  if (batchDepth === 1) batchMemo = new WeakMap();
  try { return fn(); } finally { batchDepth -= 1; if (batchDepth === 0) batchMemo = null; }
}
export function evidenceSignature(db) {
  if (!db || typeof db !== 'object') return 'none';
  const structure = structuralSignature(db);
  const hit = batchMemo?.get(db);
  if (hit && hit.structure === structure) return hit.sig;
  const sig = `${structure}#${contentId(db)}`;
  batchMemo?.set(db, { structure, sig });
  return sig;
}
const obsCache = new WeakMap();
export function observationsFor(db) {
  if (!db || typeof db !== 'object') return { observations: [], issues: [], context: [] };
  const sig = evidenceSignature(db);
  let hit = obsCache.get(db);
  if (!hit || hit.sig !== sig) { hit = { sig, ...buildObservations(db) }; obsCache.set(db, hit); }
  return hit;
}

const evalCache = new WeakMap();
// Evaluate one swimmer for an app window. asOf never passes today (no future evidence). Returns null when the window
// lies entirely after the assessment date (nothing can have been observed yet).
export function evaluateSwimmerForApp({ db, swimmerId, startDate, endDate, asOfDate = '' }) {
  if (!db || !swimmerId || !startDate) return null;
  const end = endDate || today();
  const asof = [end, asOfDate || today()].sort()[0];
  if (asof < startDate) return null;
  let perDb = evalCache.get(db);
  if (!perDb) { perDb = new Map(); evalCache.set(db, perDb); }
  const key = `${swimmerId}|${startDate}|${end}|${asof}|${evidenceSignature(db)}`;
  if (perDb.has(key)) return perDb.get(key);
  if (perDb.size > 500) perDb.clear();
  const { observations, context } = observationsFor(db);
  let result = null;
  try { result = evaluateSwimmer(db, observations, String(swimmerId), startDate, end, asof, { contextObservations: context }); }
  catch (error) { result = { error: String(error?.message || error), domains: null }; }
  perDb.set(key, result);
  return result;
}

function trainingAxis(result, d) {
  const st = result.domains[d].training_stimulus || {};
  const cur = result.training_ledger?.current || {};
  // Zero versus unknown workload (D10): an index is shown only when the attendance of at least one prescribed set is
  // known (coverage > 0). All sets known absent -> a real 0; no attendance known at all -> unscored (unknown), never 0.
  const coverage = cur.attendance_coverage;
  const known = typeof coverage === 'number' && coverage > 0;
  const calibrated = TRAINING_CALIBRATED.has(st.calibration);
  const score = calibrated && known && finite(st.index_owner_reference) ? st.index_owner_reference : Number.NaN;
  const status = !calibrated ? (st.calibration || 'unavailable') : !known ? 'unknown workload (no attendance recorded)'
    : coverage < 1 ? `${st.calibration}; lower bound (attendance known for ${Math.round(100 * coverage)} % of sets)` : st.calibration;
  return { score, count: finite(score) ? 1 : 0, status, referenceStatus: st.reference_status || '',
    metresPerWeek: finite(st.metres_per_week) ? st.metres_per_week : null };
}

// The four app radar series, their evidence counts and the full v0.2 payload, from ONE evaluateSwimmer result.
export function radarsFromV02(result) {
  const blank = () => Object.fromEntries(DOMAINS.map((d) => [d, Number.NaN]));
  const zero = () => Object.fromEntries(DOMAINS.map((d) => [d, 0]));
  const out = { training: blank(), capability: blank(), competition: blank(), integrated: blank(),
    counts: { training: zero(), capability: zero(), competition: zero(), integrated: zero(), testing: zero() }, v02: null };
  if (!result?.domains) {
    out.v02 = { source: V02_SOURCE, engine: ENGINE_VERSION, error: result?.error || 'no assessment (window after the assessment date)' };
    return out;
  }
  const domains = {};
  for (const d of DOMAINS) {
    const r = result.domains[d];
    const t = trainingAxis(result, d);
    out.training[d] = t.score; out.counts.training[d] = t.count;
    const test = capabilityFromSources(r, ['testing']);
    if (finite(test.value)) { out.capability[d] = test.value; out.counts.capability[d] = test.n; }
    out.counts.testing[d] = test.n;
    const comp = capabilityFromSources(r, ['competition']);
    if (finite(comp.value)) { out.competition[d] = comp.value; out.counts.competition[d] = comp.n; }
    if (finite(r.capability)) { out.integrated[d] = r.capability; out.counts.integrated[d] = r.confidence.n_items; }
    domains[d] = {
      integrated: r.capability, trainingExecutionSource: r.training_execution, testingSource: r.testing, competitionSource: r.competition,
      radarSlots: { training: 'training stimulus', capability: 'testing source', competition: 'competition source', integrated: 'capability (all sources)' },
      pairedProfile: r.paired_profile ? { expression: r.paired_profile.expression, repeatability: r.paired_profile.capacity_related_repeatability,
        expressionDevelopment: r.development?.class ?? null, repeatabilityDevelopment: r.paired_profile.repeatability_development?.class ?? null,
        repeatabilityChange: r.paired_profile.repeatability_development?.change ?? null,
        repeatabilityBasis: r.paired_profile.capacity_basis, composite: r.paired_profile.composite } : null,
      level: r.level, decision: r.decision,
      development: { class: r.development.class, change: r.development.change ?? null, ci90: r.development.ci90 ?? null, swc: r.development.swc ?? null,
        spanDays: r.development.span_days ?? null, plateau: r.development.plateau ?? null, nObs: r.development.n_obs },
      confidence: r.confidence, trainingStimulus: { ...r.training_stimulus, displayed: t.score, status: t.status },
      components: r.components,
    };
  }
  out.v02 = { source: V02_SOURCE, engine: result.engine, calibration: result.calibration, appCalibration: result.app_calibration,
    window: result.window, asOf: result.asof, phaseAtAssessment: result.phase_at_assessment, config: result.config,
    sourceWeights: { ...PARAMS.sourceWeights }, reviewWindows: { training: '42 days', testing: 'last battery (tests within 14 days of the latest)', competition: 'last 2 competitions' },
    domains, trainingLedger: result.training_ledger, trainingExecution: result.training_execution, trainingStimulusMeta: result.training_stimulus_meta,
    departures: V02_DEPARTURES, labels: V02_LABELS };
  return out;
}

// Evidence keys behind each radar slot and axis (review-window items; counts equal these lengths for scored axes).
export function evidenceKeysByKind(result) {
  const out = { capability: {}, competition: {}, integrated: {}, trainingExecution: {} };
  for (const d of DOMAINS) {
    const k = result?.domains?.[d]?.per_source_keys || {};
    out.capability[d] = [...(k.testing || [])];
    out.competition[d] = [...(k.competition || [])];
    out.trainingExecution[d] = [...(k.training || [])];
    out.integrated[d] = [...(k.training || []), ...(k.testing || []), ...(k.competition || [])];
  }
  return out;
}
export function trainingRecordIdsByDomain(result) {
  const rows = (result?.ledger_rows || []).filter((r) => !r.duplicate_of && Number(r.unique_m) > 0);
  return Object.fromEntries(DOMAINS.map((d) => [d, rows.filter((r) => (r.contexts || []).some((c) => CONTEXT_FOR_DOMAIN[d].includes(c))).map((r) => r.set)]));
}
export { CONTEXT_FOR_DOMAIN };

// Squad: every swimmer counts ONCE. Per kind and axis the squad value is the MEDIAN of the swimmers' displayed values
// (equal weight per swimmer; no count weighting, so a swimmer with more repetitions has no more weight). The count is
// the number of swimmers with a value. Distribution (q1, q3) and the v0.2 evaluateSquad summary travel alongside.
export function squadFromProfiles(profiles, v02Results) {
  const kinds = ['training', 'competition', 'capability', 'integrated'];
  const out = { distribution: {}, scores: {}, counts: {} };
  for (const kind of kinds) {
    out.scores[kind] = {}; out.counts[kind] = {}; out.distribution[kind] = {};
    for (const d of DOMAINS) {
      const vals = profiles.map((p) => ({ score: Number(p?.[kind]?.[d]), count: Number(p?.axisEvidenceCounts?.[kind]?.[d]) }))
        .filter((r) => (r.count > 0 || (kind === 'training' && r.score === 0)) && Number.isFinite(r.score) && r.score >= 0)
        .map((r) => r.score).sort((a, b) => a - b);
      const n = vals.length;
      const q = (p) => (n ? vals[Math.min(n - 1, Math.floor(p * (n - 1) + 0.5))] : Number.NaN);
      // Same order-statistic rule as the reference evaluate_squad (index round(0.5 (n - 1)); upper middle for even n).
      const med = q(0.5);
      out.scores[kind][d] = med; out.counts[kind][d] = n;
      out.distribution[kind][d] = { median: med, q1: q(0.25), q3: q(0.75), nScored: n, nSwimmers: profiles.length };
    }
  }
  const valid = v02Results.filter((r) => r?.domains);
  out.v02Squad = valid.length ? evaluateSquad(valid) : null;
  return out;
}
export { LEVEL_DOMAINS, DOMAINS, CALIBRATION_VERSION, APP_CALIBRATION_VERSION };

// Measured TRAINING-EXECUTION evidence per axis (the recorded swims of ordinary training that feed measured Capability),
// expressed as app training-set ids. This is the "measured-quality" information shown beside the Training demand
// graph; it is never part of the Training demand score. Technical Control has no training-based measurement
// (structured ratings only; D3), so it is never "measured" from repetition times or stroke-count stability.
const TRAINING_EXECUTION_REQUIREMENT = {
  technical_control: 'a structured technical assessment (training repetition times or stroke-count stability are not technical evidence)',
  efficiency: '>= 8 stroke-counted unfatigued freestyle swims over a 0.05 m/s speed range and a 200 m Max speed in the window',
  robustness_of_efficiency: 'a set of >= 4 repetitions with >= 15 counted cycles per repetition',
  aerobic_capacity: 'a timed EN2/EN3 set of >= 4 repetitions (retention)',
  anaerobic_capacity: 'a timed LP/LT set of >= 4 repetitions (retention)',
  power_speed_expression: 'a timed SP set of >= 4 repetitions (retention)',
  adaptability: 'the same set swum twice within 14 days with a send-off changed by >= 2 %',
  durability: 'a timed set lasting >= 20 minutes',
};
export function trainingExecutionEvidence(result, observations = [], swimmerId = '') {
  const out = Object.fromEntries(DOMAINS.map((d) => [d, { setIds: [], items: 0, requirement: TRAINING_EXECUTION_REQUIREMENT[d] }]));
  if (!result?.domains) return out;
  const [start] = result.window || [];
  const eff = result.asof;
  const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  const inTrainingWindow = (date) => date && date >= start && date <= eff && days(date, eff) <= 42;
  const setOfKey = (k) => (String(k).startsWith('set:') ? [String(k).slice(4)] : String(k).startsWith('pair:') ? String(k).slice(5).split(':') : []);
  for (const d of DOMAINS) {
    const keys = result.domains[d].per_source_keys?.training || [];
    let ids = keys.flatMap(setOfKey);
    let items = keys.length;
    if (d === 'efficiency' && keys.length) {
      // The engine fits the speed-stroke model on EVERY fresh 25 m free swim in the analysis window (engine
      // efficiencyRobustness(hist, sex, win)); only the resulting item is dated inside the 42-day review. The
      // provenance is therefore every such training swim in the window (same filter as evidenceRecordsByKind).
      const fresh = (o) => (o.nreps || 1) <= 1 || (o.rep || 1) <= Math.max(1, Math.floor((o.nreps || 1) / 3));
      const sourceKeys = keys.map(String);
      ids = sourceKeys.some((k) => k === 'dpsmodel:training' || k === 'dpsmodel:pooled')
        ? observations.filter((o) => o.swimmer === swimmerId && o.source === 'training' && o.dps && o.speed && o.stroke === 'free'
          && (o.pool || 25) === 25 && fresh(o) && o.date >= start && o.date <= eff).map((o) => String(o.set_id))
        : [];
    }
    if (['aerobic_capacity', 'anaerobic_capacity', 'power_speed_expression'].includes(d)) {
      const rit = (result.domains[d].components?.retention_items || []).filter((i) => i.source === 'training' && inTrainingWindow(i.date));
      ids = rit.flatMap((i) => setOfKey(i.key)); items = rit.length;
    }
    out[d] = { setIds: [...new Set(ids.filter(Boolean))], items, requirement: TRAINING_EXECUTION_REQUIREMENT[d] };
  }
  return out;
}

// Within-swimmer Efficiency TREND evidence (existing application function), from the v0.2 development series: each
// session's stroke length moved to ONE fixed speed with the swimmer's own speed-stroke slope. Consecutive sessions of the
// same comparable group (same protocol / set) give a change; split by the source of the swims (testing = the Testing
// radar slot, competition, training). Supporting evidence only - never a radar value.
export function efficiencyTrendRows(result, observations = [], swimmerId = '') {
  const out = { capability: [], competition: [], training: [], integrated: [] };
  const items = result?.domains?.efficiency?.components?.development_items || [];
  if (!items.length) return out;
  const [start] = result.window || []; const eff = result.asof;
  const sourceBySet = new Map();
  for (const o of observations) if (o.swimmer === swimmerId) sourceBySet.set(String(o.set_id ?? o.mkey), o.source);
  const groups = new Map();
  for (const i of items) {
    if (!(i.date >= start && i.date <= eff) || !Number.isFinite(i.value)) continue;
    const sid = String(i.key).replace(/^sess:/, '');
    const source = sourceBySet.get(sid) || 'training';
    const g = `${source}|${i.raw?.group || ''}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ ...i, source, sid });
  }
  for (const rows of groups.values()) {
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (let k = 1; k < rows.length; k += 1) {
      const a = rows[k - 1]; const b = rows[k];
      const row = { kind: 'trend', axis: 'efficiency', metric: 'distance per cycle at one fixed speed (% of elite DPS)', source: b.source,
        group: b.raw?.group || '', baselineDate: a.date, date: b.date, baselineValue: a.value, observedValue: b.value,
        changePct: a.value ? (100 * (b.value - a.value)) / a.value : null, recordIds: [a.sid, b.sid] };
      const slot = b.source === 'testing' ? 'capability' : b.source;
      if (out[slot]) out[slot].push(row);
      out.integrated.push(row);
    }
  }
  return out;
}

// Software-Owner calibration PREVIEW (assignment 20). The previous control multiplied the CV of stability-scored metrics;
// v0.2 has no CV-scored capability metric, so the control is reconciled per axis with the v0.2 provisional parameter that
// sets the same kind of sensitivity (loss-to-index slope), or stated unavailable. The preview evaluates WITHOUT the cache
// and restores the parameter in all cases: published values can never change through it.
export const MEASURED_PREVIEW_PARAMETER = Object.freeze({
  robustness_of_efficiency: { param: 'dpsLossIndexSlope', label: 'Robustness scale: DPS-loss index slope', affects: 'value' },
  durability: { param: 'durabilityIndexSlopePerKm', label: 'Durability scale: loss-per-km index slope', affects: 'value' },
  adaptability: { param: 'adaptabilityIndexSlope', label: 'Adaptability scale: speed-loss index slope', affects: 'value' },
  aerobic_capacity: { param: 'fadeIndexSlope', label: 'Repeatability scale: retention index slope (Expression unaffected)', affects: 'repeatability' },
  anaerobic_capacity: { param: 'fadeIndexSlope', label: 'Repeatability scale: retention index slope (Expression unaffected)', affects: 'repeatability' },
  power_speed_expression: { param: 'fadeIndexSlope', label: 'Repeatability scale: retention index slope (Expression unaffected)', affects: 'repeatability' },
  technical_control: null,
  efficiency: null,
});
export const MEASURED_PREVIEW_UNAVAILABLE = Object.freeze({
  technical_control: 'Unavailable in v0.2: Technical Control is a provisional rating index with no stability coefficient.',
  efficiency: 'Unavailable in v0.2: Efficiency is distance per cycle at a matched speed; it has no stability coefficient.',
});
export function previewMeasuredParameter({ db, swimmerId, startDate, endDate, asOfDate = '', axis, factor }) {
  const spec = MEASURED_PREVIEW_PARAMETER[axis];
  if (!spec || !Number.isFinite(factor)) return null;
  const end = endDate || new Date().toISOString().slice(0, 10);
  const asof = [end, asOfDate || new Date().toISOString().slice(0, 10)].sort()[0];
  if (!db || !swimmerId || !startDate || asof < startDate) return null;
  const saved = PARAMS[spec.param];
  try {
    PARAMS[spec.param] = saved * factor;
    const { observations, context } = observationsFor(db);
    const result = evaluateSwimmer(db, observations, String(swimmerId), startDate, end, asof, { contextObservations: context });
    return { spec, factor, radars: radarsFromV02(result) };
  } finally { PARAMS[spec.param] = saved; }
}

// Evidence status of every test record in the window (O-2): fixed battery, supplementary evidence used by a v0.2
// indicator (domain listed), or retained but not scored (reason). Nothing is discarded; custom tests stay available.
const FIXED = new Set(['M25', 'M50', 'M100', 'M200', 'M400', 'R8x25', 'R8x50', 'R8x100']);
export function testEvidenceStatus(result, observations = [], swimmerId = '') {
  if (!result?.domains) return [];
  const [start] = result.window || []; const eff = result.asof;
  const used = new Map();
  for (const d of DOMAINS) for (const k of result.domains[d].per_source_keys?.testing || []) {
    const id = String(k).startsWith('set:') ? String(k).slice(4) : String(k).split('|')[1];
    if (!used.has(id)) used.set(id, new Set());
    used.get(id).add(d);
  }
  const byTest = new Map();
  for (const o of observations) if (o.swimmer === swimmerId && o.source === 'testing' && o.date >= start && o.date <= eff) {
    const id = String(o.set_id ?? o.mkey);
    if (!byTest.has(id)) byTest.set(id, { id, date: o.date, protocol: o.protocol, name: o.set_name, reps: 0 });
    byTest.get(id).reps += 1;
  }
  return [...byTest.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((t) => {
    const domains = [...(used.get(t.id) || [])];
    const cls = FIXED.has(t.protocol) ? 'fixed battery' : t.protocol === 'A5x400' ? 'optional battery (5x400)'
      : String(t.protocol).startsWith('DUR-FL') ? 'supplementary: fresh-vs-loaded' : String(t.protocol).startsWith('technical') ? 'structured technical assessment' : 'supplementary: custom test';
    return { ...t, class: cls, usedIn: domains,
      status: domains.length ? `used (${domains.join(', ')})` : FIXED.has(t.protocol) ? 'in the battery; outside the last-battery review window'
        : 'retained, not scored: its structure does not meet a v0.2 indicator requirement (e.g. >= 4 stroke-counted repetitions for Robustness, a protocol mapping for Expression)' };
  });
}

// Evidence RECORDS behind each radar slot and axis (assignment 18): every v0.2 evidence item is mapped to the application
// records it was computed from - test id, training set id, "fixture:event:swimmer" for a race, the rated assessment id;
// a model item (distance-per-cycle model of one source) expands to the swims that fed it. Counts are the number of
// distinct records, so a displayed count always equals the listed records.
export function evidenceRecordsByKind(result, observations = [], swimmerId = '') {
  const out = { capability: {}, competition: {}, integrated: {}, trainingExecution: {} };
  if (!result?.domains) { for (const k of Object.keys(out)) for (const d of DOMAINS) out[k][d] = []; return out; }
  const [start] = result.window || []; const eff = result.asof;
  const mine = observations.filter((o) => o.swimmer === swimmerId);
  const raceId = new Map(mine.filter((o) => o.source === 'competition').map((o) => [String(o.set_id), `${o.fixture_id}:${o.set_id}:${swimmerId}`]));
  const fresh = (o) => (o.nreps || 1) <= 1 || (o.rep || 1) <= Math.max(1, Math.floor((o.nreps || 1) / 3));
  const modelSwims = (src) => mine.filter((o) => (src === 'pooled' || o.source === src) && o.dps && o.speed && o.stroke === 'free' && (o.pool || 25) === 25
    && fresh(o) && o.date >= start && o.date <= eff).map((o) => (o.source === 'competition' ? raceId.get(String(o.set_id)) : String(o.set_id)));
  const recordsOf = (key) => {
    const k = String(key);
    if (k.startsWith('set:')) { const id = k.slice(4); return [raceId.get(id) || id]; }
    if (k.startsWith('pair:')) return k.slice(5).split(':');
    if (k.startsWith('dpsmodel:')) return modelSwims(k.slice(9));
    if (k.startsWith('rating|')) return [k.slice(7)];
    const parts = k.split('|');
    if (parts.length >= 4) return [raceId.get(parts[1]) || parts[1]];
    return [k];
  };
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  for (const d of DOMAINS) {
    const keys = result.domains[d].per_source_keys || {};
    const t = uniq((keys.training || []).flatMap(recordsOf)); const te = uniq((keys.testing || []).flatMap(recordsOf)); const c = uniq((keys.competition || []).flatMap(recordsOf));
    out.trainingExecution[d] = t; out.capability[d] = te; out.competition[d] = c; out.integrated[d] = uniq([...t, ...te, ...c]);
  }
  return out;
}
