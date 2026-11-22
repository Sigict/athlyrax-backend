// Club capability profile for the Athlete App, calculated on the server with the AthlyraX capability
// engine (an exact copy of the Coaching Software engine in ./capability-engine, see its manifest.json).
// The call matches the club's Individual Swimmer Profile (ISP): the linked swimmer, their squad and
// the current season window, so the athlete sees the same evidence-based profile as their coach.
// Nothing is estimated: axes without enough evidence stay unscored, with the engine's reason.
import { buildScopedAthlyraxCapabilitySnapshot } from './capability-engine/src/utils/scopedCapabilitySnapshot.js';
import { swimmingReportConfig } from './capability-engine/src/sports/swimming/swimmingReports.js';
import { officialCapabilityRadar } from './capability-engine/src/utils/officialCapabilityRadar.js';
import { swimmerSpeedLevel } from './capability-engine/src/utils/athlyraxCapabilityEngine.js';
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
  const squadId = text(swimmer.currentSquadId || swimmer.squadId || asArray(swimmer.currentSquadIds)[0] || asArray(swimmer.squadIds)[0]) || 'all';
  const calculationDate = season.end < today ? season.end : today;
  // ATHLYRAX_ATHLETE_CAPABILITY_SPEED_LEVEL: same rule as the club's ISP (ispCanonicalRadars.js).
  // Consistency metrics are placed on the world-record scale by the swimmer's speed level; with no timed
  // test or race in the window, the best timed swim of the previous 12 months sets it, and with none at
  // all those metrics stay Not Scored ("Needs a timed test or race") instead of a raw consistency score.
  const lookbackStart = new Date(Date.parse(`${calculationDate}T12:00:00Z`) - 364 * 86400000).toISOString().slice(0, 10);
  let fallbackSpeedLevel = null;
  try {
    const history = buildScopedAthlyraxCapabilitySnapshot({
      db, scope: { swimmerId, squadId, startDate: '', endDate: calculationDate }, activeWindow: { start: '', end: calculationDate },
      activeAccountId: '', activeTenantId: text(tenantId), calculationDate,
    });
    fallbackSpeedLevel = swimmerSpeedLevel(asArray(history?.axes).flatMap((axis) => asArray(axis?.metricRecords))
      .filter((record) => text(record?.date).slice(0, 10) >= lookbackStart));
  } catch { fallbackSpeedLevel = null; }
  const snapshot = buildScopedAthlyraxCapabilitySnapshot({
    fallbackSpeedLevel, requireSpeedLevel: true,
    db,
    scope: { swimmerId, squadId, seasonStartDate: season.start, startDate: season.start, endDate: season.end },
    activeWindow: { start: season.start, end: season.end },
    activeAccountId: '',
    activeTenantId: text(tenantId),
    calculationDate,
  });
  if (!snapshot || !snapshot.selectedSingleSwimmer) return null;
  // Displayed exactly as the club's ISP displays them (swimmersIspEvidence): the official ISP radar
  // rule scores an axis only with a finite score AND evidence; everything else is Not Scored.
  const official = officialCapabilityRadar(snapshot, asArray(snapshot.axes).map((axis) => axis.key));
  const axes = asArray(snapshot.axes).map((axis) => {
    const officialScore = official?.scores?.[axis.key];
    const evidenceCount = Math.max(0, Number(axis?.evidenceCount) || 0);
    const scored = evidenceCount > 0 && Number.isFinite(officialScore);
    return {
      id: text(axis.key || axis.id),
      label: text(axis.label || axis.name || axis.key),
      value: scored ? Math.round(officialScore) : null,
      validation: scored ? text(axis.validation || 'Not Scored') : 'Not Scored',
      evidenceCount,
      confidence: roundOrNull(axis.confidence),
      scored,
      reasons: asArray(axis.reasons).map(text).filter(Boolean).slice(0, 3),
    };
  });
  const scored = axes.filter((axis) => axis.scored);
  const loadSummary = snapshot.loadSummary || {};
  return {
    score: roundOrNull(snapshot.integratedScore),
    trend: null,
    headline: snapshot.integratedLabel || 'Integrated Capability',
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
    confidence: roundOrNull(snapshot.integratedConfidence),
    fullRadarAvailable: Boolean(snapshot.fullRadarAvailable),
    measuredAxes: scored.length,
    totalAxes: axes.length,
    evidence: {
      tests: Number(loadSummary.completedTestCount) || 0,
      competitions: Number(loadSummary.completedCompetitionCount) || 0,
      trainingSets: Number(loadSummary.canonicalSetCount) || 0,
    },
    engineVersion: text(snapshot.engineVersion),
    calibrationVersion: text(snapshot.calibrationVersion),
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
