const asArray = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function submissionUser(row = {}) {
  return text(row.userId || row.username).toLowerCase();
}

function timestamp(row = {}) {
  const parsed = Date.parse(text(row.snapshotDate || row.createdAt || row.date));
  return Number.isFinite(parsed) ? parsed : 0;
}

function capabilityValues(row = {}) {
  const summary = row.summary && typeof row.summary === 'object'
    ? row.summary
    : (row.results && typeof row.results === 'object' ? row.results : row);
  const radar = summary?.radar && typeof summary.radar === 'object' ? summary.radar : {};
  const raw = asArray(radar.integrated).length
    ? radar.integrated
    : (asArray(radar.capability).length ? radar.capability : radar.displayCapability);
  return asArray(raw).map(clampPercent).filter((value) => value !== null);
}

function radarLabels(row = {}) {
  const summary = row.summary && typeof row.summary === 'object'
    ? row.summary
    : (row.results && typeof row.results === 'object' ? row.results : row);
  const labels = asArray(summary?.radar?.labels).map(text).filter(Boolean);
  return labels;
}

function average(values = []) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function latestRowsForUser(submissions = [], authUser = {}) {
  const username = text(authUser.username || authUser.email).toLowerCase();
  if (!username) return [];
  return asArray(submissions)
    .filter((row) => submissionUser(row) === username)
    .sort((a, b) => timestamp(b) - timestamp(a));
}

export function buildAthleteCapabilityProjection(submissions = [], authUser = {}) {
  const rows = latestRowsForUser(submissions, authUser);
  if (!rows.length) return { integratedProfile: null, disciplines: [] };

  const current = rows[0];
  const values = capabilityValues(current);
  const labels = radarLabels(current);
  if (!values.length) return { integratedProfile: null, disciplines: [] };

  const previousValues = rows.length > 1 ? capabilityValues(rows[1]) : [];
  const currentScore = average(values);
  const previousScore = average(previousValues);
  const trend = currentScore !== null && previousScore !== null ? currentScore - previousScore : null;
  const metricRows = values.map((value, index) => ({
    label: labels[index] || `Capability ${index + 1}`,
    value,
  }));

  return {
    integratedProfile: {
      score: currentScore,
      trend,
      headline: 'Integrated capability profile',
      summary: 'Server-calculated capability from the athlete’s latest saved AthlyraX Snapshot.',
      source: 'athlyrax_snapshot',
      snapshotId: text(current.id),
      snapshotDate: text(current.snapshotDate || current.createdAt || current.date),
      axes: metricRows,
    },
    disciplines: [{
      id: 'swimming',
      name: 'Swimming',
      status: 'active',
      score: currentScore,
      trend,
      summary: 'Swimming capability profile',
      metrics: metricRows,
      graph: {
        labels: metricRows.map((row) => row.label),
        values: metricRows.map((row) => row.value),
      },
      source: 'athlyrax_snapshot',
    }],
  };
}
