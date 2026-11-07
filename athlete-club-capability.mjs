// Club capability profile for the Athlete App, calculated on the server with the AthlyraX capability
// engine (an exact copy of the Coaching Software engine in ./capability-engine, see its manifest.json).
// The call matches the club's Individual Swimmer Profile (ISP): the linked swimmer, their squad and
// the current season window, so the athlete sees the same evidence-based profile as their coach.
// Nothing is estimated: axes without enough evidence stay unscored, with the engine's reason.
import { buildScopedAthlyraxCapabilitySnapshot } from './capability-engine/src/utils/scopedCapabilitySnapshot.js';
import { swimmingReportConfig } from './capability-engine/src/sports/swimming/swimmingReports.js';

const text = (value) => String(value ?? '').trim();
const asArray = (value) => (Array.isArray(value) ? value : []);
const roundOrNull = (value) => (Number.isFinite(Number(value)) && value !== null ? Math.round(Number(value)) : null);

export function currentCapabilitySeason(config = swimmingReportConfig) {
  const season = config?.currentSeason || {};
  return { key: text(season.key), label: text(season.label), start: text(season.start), end: text(season.end) };
}

export function buildClubCapabilityProfile(db = {}, swimmer = {}, { season = currentCapabilitySeason(), today = new Date().toISOString().slice(0, 10), tenantId = '' } = {}) {
  const swimmerId = text(swimmer.id);
  if (!swimmerId || !season.start || !season.end) return null;
  const squadId = text(swimmer.currentSquadId || swimmer.squadId || asArray(swimmer.currentSquadIds)[0] || asArray(swimmer.squadIds)[0]) || 'all';
  const calculationDate = season.end < today ? season.end : today;
  const snapshot = buildScopedAthlyraxCapabilitySnapshot({
    db,
    scope: { swimmerId, squadId, seasonStartDate: season.start, startDate: season.start, endDate: season.end },
    activeWindow: { start: season.start, end: season.end },
    activeAccountId: '',
    activeTenantId: text(tenantId),
    calculationDate,
  });
  if (!snapshot || !snapshot.selectedSingleSwimmer) return null;
  const axes = asArray(snapshot.axes).map((axis) => ({
    id: text(axis.key || axis.id),
    label: text(axis.label || axis.name || axis.key),
    value: roundOrNull(axis.score),
    confidence: roundOrNull(axis.confidence),
    scored: Number.isFinite(axis.score),
    reasons: asArray(axis.reasons).map(text).filter(Boolean).slice(0, 3),
  }));
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
    evidenceType: 'validated',
    sourceLabel: 'Club evidence: coach-recorded tests, training and competitions',
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
