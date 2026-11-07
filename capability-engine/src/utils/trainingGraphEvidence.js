const DELIVERED_VOLUME_FIELDS = [
  'volumeSwam',
  'swamVolume',
  'completedVolume',
  'volumeCompleted',
  'deliveredVolume',
  'actualVolume',
];

function toFiniteNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function hasPositiveAttendanceEvidence(row) {
  if (!row || typeof row !== 'object') return false;

  const explicitNegative = [
    row?.present,
    row?.attended,
    row?.wasPresent,
    row?.isPresent,
  ].some((value) => value === false);
  if (explicitNegative) return false;

  const explicitPositive = [
    row?.present,
    row?.attended,
    row?.wasPresent,
    row?.isPresent,
  ].some((value) => value === true);
  if (explicitPositive) return true;

  const status = String(
    row?.status
    || row?.attendanceStatus
    || row?.attendanceClass
    || row?.completionStatus
    || row?.sessionStatus
    || '',
  ).trim().toLowerCase();

  if (!status) return false;
  if (/(absent|missed|no[\s-]?show|not[\s-]?completed|planned|scheduled|cancelled|canceled|injured|sick|excused)/i.test(status)) {
    return false;
  }

  return /(present|attended|complete|completed|yes|here|late|partial)/i.test(status);
}

export function hasExplicitDeliveredTrainingVolume(row) {
  return DELIVERED_VOLUME_FIELDS.some((field) => {
    const value = row?.[field];
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
}

export function resolveDeliveredTrainingVolume(row) {
  for (const field of DELIVERED_VOLUME_FIELDS) {
    const value = row?.[field];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    return Math.max(0, toFiniteNumber(value, 0));
  }
  return 0;
}

export function hasActualTrainingDelivery(row) {
  if (!row || typeof row !== 'object') return false;
  const status = String(
    row?.status
    || row?.attendanceStatus
    || row?.completionStatus
    || row?.sessionStatus
    || '',
  ).trim().toLowerCase();

  if (status.includes('scheduled')
    || status.includes('planned')
    || status.includes('not completed')
    || status.includes('absent')) {
    return false;
  }

  if (hasExplicitDeliveredTrainingVolume(row)) {
    return resolveDeliveredTrainingVolume(row) > 0;
  }

  return Boolean(
    row?.hasResult === true
    || row?.resultEntered === true
    || row?.completed === true
    || row?.wasPresent === true
    || row?.attended === true
    || status.includes('complete')
    || status.includes('present')
    || status.includes('attend')
  );
}

export function resolveDeliveredTrainingVolumeForGraph(row, plannedVolume = 0) {
  if (!hasActualTrainingDelivery(row)) return 0;
  if (hasExplicitDeliveredTrainingVolume(row)) return resolveDeliveredTrainingVolume(row);
  return Math.max(0, toFiniteNumber(plannedVolume, 0));
}
