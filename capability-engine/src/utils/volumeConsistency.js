function defaultToNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasDefinedValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function resolveCanonicalSetRepsValue(row) {
  return hasDefinedValue(row?.reps) ? row.reps : '';
}

export function resolveCanonicalSetPlannedVolume(row, {
  toNumber = defaultToNumber,
} = {}) {
  // The visible Planner numeric fields define the set. Comment/description,
  // structural text, legacy aliases and cached parent/row totals are never
  // permitted to manufacture planned volume.
  if (!hasDefinedValue(row?.distance)) return 0;

  const distance = Math.max(0, toNumber(row?.distance));
  if (distance <= 0) return 0;

  const reps = Math.max(1, hasDefinedValue(row?.reps) ? toNumber(row?.reps) : 1);
  const rounds = Math.max(1, hasDefinedValue(row?.rounds) ? toNumber(row?.rounds) : 1);
  return Math.max(0, distance * reps * rounds);
}

export function canonicalDenominatorAggregation(rows, {
  toNumber = defaultToNumber,
  deriveSetRowTotals,
  getPlannedVolume,
  getDeliveredVolume,
  deliveredWhen,
} = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const readPlanned = typeof getPlannedVolume === 'function'
    ? getPlannedVolume
    : ((row) => resolveCanonicalSetPlannedVolume(row, { toNumber, deriveSetRowTotals }));

  const readDelivered = typeof getDeliveredVolume === 'function'
    ? getDeliveredVolume
    : ((row) => {
      const explicitDelivered = Math.max(0, toNumber(
        row?.deliveredVolume
        ?? row?.volumeDelivered
        ?? row?.actualVolume
        ?? row?.completedVolume
        ?? row?.swamVolume
        ?? row?.volumeSwam,
        0,
      ));
      if (explicitDelivered > 0) return explicitDelivered;

      const planned = Math.max(0, toNumber(readPlanned(row), 0));
      if (row?.hasResult) return planned;
      if (typeof deliveredWhen === 'function' && deliveredWhen(row)) return planned;
      return 0;
    });

  const totals = safeRows.reduce((sum, row) => {
    const delivered = Math.max(0, toNumber(readDelivered(row), 0));
    const planned = Math.max(0, toNumber(readPlanned(row), 0));
    return {
      delivered: sum.delivered + delivered,
      planned: sum.planned + planned,
    };
  }, { delivered: 0, planned: 0 });

  return normalizeDeliveredPlanned(totals.delivered, totals.planned, toNumber);
}

export function normalizeDeliveredPlanned(deliveredValue, plannedValue, toNumber = defaultToNumber) {
  const delivered = Math.max(0, toNumber(deliveredValue));
  const plannedRaw = Math.max(0, toNumber(plannedValue));
  if (delivered <= 0 && plannedRaw <= 0) {
    return { delivered: 0, planned: 0 };
  }
  return {
    delivered,
    planned: Math.max(plannedRaw, delivered),
  };
}

export function aggregateDeliveredPlanned(rows, {
  toNumber = defaultToNumber,
  getDeliveredVolume,
  getPlannedVolume,
  deriveSetRowTotals,
} = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const readDelivered = typeof getDeliveredVolume === 'function'
    ? getDeliveredVolume
    : ((row) => row?.deliveredVolume ?? row?.volumeDelivered ?? row?.swamVolume ?? row?.volumeSwam ?? 0);
  const readPlanned = typeof getPlannedVolume === 'function'
    ? getPlannedVolume
    : ((row) => resolveCanonicalSetPlannedVolume(row, { toNumber, deriveSetRowTotals }));

  const totals = safeRows.reduce((sum, row) => {
    const delivered = Math.max(0, toNumber(readDelivered(row)));
    const planned = Math.max(0, toNumber(readPlanned(row)));
    return {
      delivered: sum.delivered + delivered,
      planned: sum.planned + planned,
    };
  }, { delivered: 0, planned: 0 });

  return normalizeDeliveredPlanned(totals.delivered, totals.planned, toNumber);
}
