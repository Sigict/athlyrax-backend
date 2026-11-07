import { ATHLYRAX_AXIS_DEFINITIONS, buildAthlyraxCapabilitySnapshot } from './athlyraxCapabilityEngine.js';
import { getSwimmerSquadIdOnDate } from './swimmerSquadHistory.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveSwimmerId(row) {
  return normalize(
    row?.swimmerId
    || row?.athleteId
    || row?.participantId
    || row?.subjectId
    || row?.profileId
    || row?.metadata?.swimmerId
    || row?.meta?.swimmerId,
  );
}

function resolveOwnership(row) {
  return {
    accountId: normalize(
      row?.accountId
      || row?.ownerAccountId
      || row?.accountScope
      || row?.ownerUsername
      || row?.metadata?.accountId
      || row?.meta?.accountId,
    ),
    tenantId: normalize(
      row?.tenantId
      || row?.ownerTenantId
      || row?.tenantScope
      || row?.metadata?.tenantId
      || row?.meta?.tenantId,
    ),
  };
}

function matchesIndividualMetricScope(row, selectedSwimmerId, activeAccountId, activeTenantId) {
  if (!row || typeof row !== 'object') return false;
  const expectedSwimmer = normalize(selectedSwimmerId);
  if (!expectedSwimmer || expectedSwimmer === 'all' || expectedSwimmer === '__all__') return false;

  // Individual capability metrics must identify their swimmer. Anonymous or
  // scope-wide metric rows cannot be attached to one athlete by inference.
  const actualSwimmer = resolveSwimmerId(row);
  if (!actualSwimmer || actualSwimmer !== expectedSwimmer) return false;

  const ownership = resolveOwnership(row);
  const expectedAccount = normalize(activeAccountId);
  const expectedTenant = normalize(activeTenantId);
  if (expectedAccount && ownership.accountId && ownership.accountId !== expectedAccount) return false;
  if (expectedTenant && ownership.tenantId && ownership.tenantId !== expectedTenant) return false;
  return true;
}

export function buildScopedCapabilityDbView({
  db = {},
  selectedSwimmerId = '',
  activeAccountId = '',
  activeTenantId = '',
} = {}) {
  const filterMetrics = (rows) => asArray(rows).filter((row) => matchesIndividualMetricScope(
    row,
    selectedSwimmerId,
    activeAccountId,
    activeTenantId,
  ));

  return {
    ...db,
    capabilityMetricRecords: filterMetrics(db?.capabilityMetricRecords),
    metricResults: filterMetrics(db?.metricResults),
    capabilityMetrics: filterMetrics(db?.capabilityMetrics),
  };
}

function isAllSwimmers(value) {
  const token = normalize(value);
  return !token || token === 'all' || token === '__all__';
}

function isSpecificSquad(value) {
  const token = normalize(value);
  return Boolean(token) && token !== 'all' && token !== '__all__';
}

// No confidence classes are specified (S14); the label says only whether
// the aggregate axis was scored.
function validationLabel() {
  return 'Scored';
}

function buildLongitudinalCapabilityOptions(options, scope) {
  const activeWindow = options?.activeWindow && typeof options.activeWindow === 'object'
    ? options.activeWindow
    : {};
  const historyStart = String(
    scope?.capabilityHistoryStart
    || scope?.seasonStartDate
    || scope?.seasonStart
    || scope?.selectedSeasonStart
    || scope?.timelineStartDate
    || scope?.timelineStart
    || scope?.targetCycleStart
    || scope?.cycleStart
    || ''
  ).trim();
  const historyEnd = String(
    activeWindow?.end
    || scope?.endDate
    || options?.calculationDate
    || ''
  ).trim();

  // Capability is a state, not a one-week event. The graph window determines
  // the state date (historyEnd), while valid earlier tests/metrics remain in
  // the evidence history and are naturally down-weighted by engine recency.
  return {
    ...options,
    activeWindow: {
      ...activeWindow,
      start: historyStart,
      end: historyEnd,
    },
    scope: {
      ...scope,
      startDate: historyStart,
      endDate: historyEnd || String(scope?.endDate || '').trim(),
    },
  };
}

function resolveSquadSwimmers(db, squadId, onDate) {
  const expectedSquad = String(squadId || '').trim();
  if (!expectedSquad) return [];
  return asArray(db?.swimmers).filter((swimmer) => {
    const swimmerId = String(swimmer?.id || '').trim();
    if (!swimmerId) return false;
    const historicalSquad = String(getSwimmerSquadIdOnDate(swimmer, onDate) || '').trim();
    const directSquads = [
      swimmer?.currentSquadId,
      swimmer?.squadId,
      swimmer?.primarySquadId,
      ...asArray(swimmer?.squadIds),
    ].map((value) => String(value || '').trim()).filter(Boolean);
    return historicalSquad === expectedSquad || directSquads.includes(expectedSquad);
  });
}

function aggregateSquadAxes(snapshots) {
  return ATHLYRAX_AXIS_DEFINITIONS.map((definition) => {
    const contributions = snapshots
      .map((snapshot) => snapshot?.axes?.find((axis) => axis?.key === definition.key) || null)
      .filter((axis) => Number(axis?.evidenceCount) > 0
        && axis?.score !== null
        && axis?.score !== undefined
        && String(axis.score).trim() !== ''
        && Number.isFinite(Number(axis.score)));

    if (!contributions.length) {
      return {
        key: definition.key,
        label: definition.label,
        score: null,
        confidence: 0,
        validation: 'Not Scored',
        evidenceCount: 0,
        completeness: 0,
        recencyCoverage: 0,
        sourceAgreement: 0,
        availableMetrics: [],
        omittedMetrics: Object.keys(definition.metrics),
        reasons: [`No swimmer in the selected squad has valid ${definition.label} evidence in this window.`],
        metricRecords: [],
        metricSummaries: [],
        contributingSwimmerCount: 0,
      };
    }

    // Same weighting as the canonical squad aggregate (canonicalGroupIspRadars):
    // each swimmer's axis score weighted by its evidence count. The engine's
    // internal confidence (0.35·completeness + 0.35·recency + 0.30·agreement)
    // has no documented source and no longer weights capability scores (S14).
    const weighted = contributions.map((axis) => ({ axis, weight: Math.max(1, Number(axis?.evidenceCount) || 1) }));
    const denominator = weighted.reduce((sum, item) => sum + item.weight, 0);
    const score = denominator > 0
      ? weighted.reduce((sum, item) => sum + (Number(item.axis.score) * item.weight), 0) / denominator
      : null;
    const confidence = denominator > 0
      ? weighted.reduce((sum, item) => sum + ((Number(item.axis.confidence) || 0) * item.weight), 0) / denominator
      : 0;
    const availableMetrics = Array.from(new Set(contributions.flatMap((axis) => asArray(axis?.availableMetrics))));
    const metricRecords = contributions.flatMap((axis) => asArray(axis?.metricRecords));
    const metricSummaries = contributions.flatMap((axis) => asArray(axis?.metricSummaries));

    return {
      key: definition.key,
      label: definition.label,
      score,
      confidence,
      validation: score === null ? 'Not Scored' : validationLabel(confidence),
      evidenceCount: contributions.reduce((sum, axis) => sum + Math.max(0, Number(axis?.evidenceCount) || 0), 0),
      completeness: contributions.reduce((sum, axis) => sum + (Number(axis?.completeness) || 0), 0) / contributions.length,
      recencyCoverage: contributions.reduce((sum, axis) => sum + (Number(axis?.recencyCoverage) || 0), 0) / contributions.length,
      sourceAgreement: contributions.reduce((sum, axis) => sum + (Number(axis?.sourceAgreement) || 0), 0) / contributions.length,
      availableMetrics,
      omittedMetrics: Object.keys(definition.metrics).filter((metric) => !availableMetrics.includes(metric)),
      reasons: [`Squad aggregate of ${contributions.length} swimmer(s) with valid individual evidence.`],
      metricRecords,
      metricSummaries,
      contributingSwimmerCount: contributions.length,
    };
  });
}

function buildSquadAggregateSnapshot(options, selectedSquadId) {
  const scope = options?.scope && typeof options.scope === 'object' ? options.scope : {};
  const calculationDate = options?.calculationDate || options?.activeWindow?.end || scope?.endDate || '';
  const swimmers = resolveSquadSwimmers(options?.db || {}, selectedSquadId, calculationDate);
  const longitudinalOptions = buildLongitudinalCapabilityOptions(options, scope);
  const swimmerSnapshots = swimmers.map((swimmer) => {
    const swimmerId = String(swimmer?.id || '').trim();
    const scopedDb = buildScopedCapabilityDbView({
      db: options?.db || {},
      selectedSwimmerId: swimmerId,
      activeAccountId: options?.activeAccountId || '',
      activeTenantId: options?.activeTenantId || '',
    });
    return buildAthlyraxCapabilitySnapshot({
      ...longitudinalOptions,
      db: scopedDb,
      scope: { ...longitudinalOptions.scope, swimmerId, squadId: selectedSquadId },
    });
  });

  // Build the squad load once from the selected graph window. Summing each
  // swimmer capability history would multiply the same squad programme.
  const squadLoadSnapshot = buildAthlyraxCapabilitySnapshot({
    ...options,
    scope: { ...scope, swimmerId: 'all', squadId: selectedSquadId },
  });
  const axes = aggregateSquadAxes(swimmerSnapshots);
  const validAxes = axes.filter((axis) => axis?.score !== null && axis?.score !== undefined && String(axis.score).trim() !== '' && Number.isFinite(Number(axis.score)));
  const integratedScore = validAxes.length
    ? validAxes.reduce((sum, axis) => sum + Number(axis.score), 0) / validAxes.length
    : null;
  const integratedConfidence = validAxes.length
    ? validAxes.reduce((sum, axis) => sum + (Number(axis.confidence) || 0), 0) / validAxes.length
    : 0;

  return {
    ...squadLoadSnapshot,
    selectedSwimmerId: 'all',
    selectedSquadId,
    selectedSingleSwimmer: false,
    aggregateScope: 'squad',
    contributingSwimmerCount: swimmerSnapshots.length,
    axes,
    validAxisCount: validAxes.length,
    fullRadarAvailable: validAxes.length === ATHLYRAX_AXIS_DEFINITIONS.length,
    integratedScore,
    integratedConfidence,
    integratedLabel: 'Squad Capability Aggregate',
    decision: validAxes.length === ATHLYRAX_AXIS_DEFINITIONS.length && integratedConfidence >= 55
      ? 'Interpret with validation context'
      : 'Do Not Interpret',
    swimmerSnapshots,
  };
}

export function buildScopedAthlyraxCapabilitySnapshot(options = {}) {
  const scope = options?.scope && typeof options.scope === 'object' ? options.scope : {};
  const selectedSwimmerId = String(scope?.swimmerId || scope?.swimmer || 'all').trim();
  const selectedSquadId = String(scope?.squadId || scope?.squad || 'all').trim();

  if (isAllSwimmers(selectedSwimmerId) && isSpecificSquad(selectedSquadId)) {
    return buildSquadAggregateSnapshot(options, selectedSquadId);
  }

  const scopedDb = buildScopedCapabilityDbView({
    db: options?.db || {},
    selectedSwimmerId,
    activeAccountId: options?.activeAccountId || '',
    activeTenantId: options?.activeTenantId || '',
  });
  const longitudinalOptions = buildLongitudinalCapabilityOptions(options, scope);

  return buildAthlyraxCapabilitySnapshot({
    ...longitudinalOptions,
    db: scopedDb,
  });
}
