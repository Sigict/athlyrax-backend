// Club capability profile for the Athlete App, calculated on the server.
// EXPERIMENTAL isolated branch: the calculation is AthlyraX capability engine v0.2, a byte-identical copy of the
// website's src/utils/capabilityV02 in ./capability-engine (see manifest.json experimentalV02), so the athlete sees the
// same evidence-based profile as their coach's Analysis / ISP. Axes without enough evidence stay unscored.
import { swimmingReportConfig } from './capability-engine/src/sports/swimming/swimmingReports.js';
import { evaluateSwimmerForApp, radarsFromV02, observationsFor, DOMAINS as V02_DOMAINS } from './capability-engine/src/utils/capabilityV02/appAdapter.js';
import { ATHLYRAX_AXES_SNAKE } from './capability-engine/src/utils/axisModel.js';
import { isSyntheticDemoDb } from './capability-engine/src/utils/demoSetSendOffs.js';
import { demoRobustnessV32Pending } from './capability-engine/src/utils/demoRobustnessV32Upgrade.js';

// Owner decision 22-11-2026: no "synthetic" wording on any screen; the demo club's profile shows the same source line as
// every club. Until the one-time server update of the demo club has completed, the profile says so explicitly.
export const SYNTHETIC_DEMO_PROFILE_LABEL = 'Club evidence: coach-recorded tests, training and competitions';
export const DEMO_UPDATE_PENDING_PROFILE_LABEL = 'Demo data update incomplete: the one-time server update of the demonstration club has not '
  + 'completed, so these values are not final.';

const text = (value) => String(value ?? '').trim();
const asArray = (value) => (Array.isArray(value) ? value : []);
const roundOrNull = (value) => (Number.isFinite(Number(value)) && value !== null ? Math.round(Number(value)) : null);

export function currentCapabilitySeason(config = swimmingReportConfig, today = new Date().toISOString().slice(0, 10)) {
  // The copied swimming report config may still contain a historical season.
  // Athlete Home must assess the ACTIVE season, not silently discard all of a
  // swimmer's current-year club evidence. September starts the swimming season.
  const key = text(today).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || Number.isNaN(Date.parse(key + 'T12:00:00Z'))) {
    const fallback = config?.currentSeason || {};
    return { key: text(fallback.key), label: text(fallback.label), start: text(fallback.start), end: text(fallback.end) };
  }
  const year = Number(key.slice(0, 4));
  const startYear = Number(key.slice(5, 7)) >= 9 ? year : year - 1;
  const endYear = startYear + 1;
  return {
    key: `${startYear}-${endYear}`,
    label: `${startYear}/${String(endYear).slice(-2)}`,
    start: `${startYear}-09-01`,
    end: `${endYear}-08-31`,
  };
}

export function buildClubCapabilityProfile(db = {}, swimmer = {}, { season = currentCapabilitySeason(), today = new Date().toISOString().slice(0, 10), tenantId = '' } = {}) {
  const swimmerId = text(swimmer.id);
  if (!swimmerId || !season.start || !season.end) return null;
  const calculationDate = season.end < today ? season.end : today;
  // EXPERIMENTAL v0.2 (isolated branch): the Athlete App shows the SAME calculation as the club's Analysis / ISP
  // (capability-engine/src/utils/capabilityV02, byte-identical to the website; see manifest.json). The integrated
  // radar (training 0.30 / testing 0.50 / competition 0.20) is shown per axis. No overall composite number is formed.
  void tenantId;
  const result = evaluateSwimmerForApp({ db, swimmerId, startDate: season.start, endDate: season.end, asOfDate: calculationDate });
  if (!result?.domains) return null;
  const radars = radarsFromV02(result);
  const labels = Object.fromEntries(ATHLYRAX_AXES_SNAKE.map((axis) => [axis.key, axis.label]));
  const axes = V02_DOMAINS.map((key) => {
    const value = radars.integrated[key];
    const evidenceCount = Math.max(0, Number(radars.counts.integrated[key]) || 0);
    const scored = evidenceCount > 0 && Number.isFinite(value);
    const domain = radars.v02.domains[key];
    return {
      id: key,
      label: labels[key] || key,
      value: scored ? Math.round(value) : null,
      validation: scored ? text(domain?.confidence?.sufficiency || 'measured') : 'Not Scored',
      evidenceCount,
      confidence: null,
      scored,
      decision: domain?.decision || null,
      paired: domain?.pairedProfile ? { expression: roundOrNull(domain.pairedProfile.expression), repeatability: roundOrNull(domain.pairedProfile.repeatability) } : null,
      reasons: [text(domain?.development?.class), text(domain?.development?.plateau)].filter(Boolean).slice(0, 3),
    };
  });
  const scored = axes.filter((axis) => axis.scored);
  const evidence = {
    tests: new Set(observationsFor(db).observations.filter((o) => o.swimmer === swimmerId && o.source === 'testing' && o.date >= season.start && o.date <= calculationDate).map((o) => o.set_id)).size,
    competitions: new Set(observationsFor(db).observations.filter((o) => o.swimmer === swimmerId && o.source === 'competition' && o.date >= season.start && o.date <= calculationDate).map((o) => o.set_id)).size,
    trainingSets: asArray(result.ledger_rows).filter((row) => !row.duplicate_of).length,
  };
  return {
    score: null,
    trend: null,
    headline: 'Integrated Capability (experimental v0.2)',
    summary: scored.length
      ? `${scored.length} of ${axes.length} capability areas measured from your club evidence (${season.label || season.key} season).`
      : `Not enough club evidence yet to measure a capability area (${season.label || season.key} season).`,
    source: 'club_evidence',
    ...(isSyntheticDemoDb(db) && demoRobustnessV32Pending(db)
      ? { evidenceType: 'synthetic-demonstration-update-pending', sourceLabel: DEMO_UPDATE_PENDING_PROFILE_LABEL }
      : isSyntheticDemoDb(db)
      ? { evidenceType: 'synthetic-demonstration', sourceLabel: SYNTHETIC_DEMO_PROFILE_LABEL }
      : { evidenceType: 'validated', sourceLabel: 'Club evidence: coach-recorded tests, training and competitions' }),
    season,
    calculationDate,
    confidence: null,
    fullRadarAvailable: scored.length === axes.length,
    measuredAxes: scored.length,
    totalAxes: axes.length,
    evidence,
    engineVersion: text(result.engine),
    calibrationVersion: text(result.app_calibration || result.calibration),
    experimental: true,
    axes,
  };
}

export function clubSwimmingDiscipline(profile) {
  if (!profile) return null;
  const metrics = profile.axes.map((axis) => ({ label: axis.label, value: axis.scored ? axis.value : 'Not measured yet' }));
  return {
    id: 'swimming',
    name: 'Swimming',
    status: 'active',
    score: profile.score,
    trend: null,
    summary: profile.summary,
    metrics,
    graph: profile.axes.some((axis) => axis.scored)
      ? { labels: profile.axes.map((axis) => axis.label), values: profile.axes.map((axis) => (axis.scored ? axis.value : null)) }
      : null,
    source: 'club_evidence',
    evidenceType: 'validated',
  };
}
