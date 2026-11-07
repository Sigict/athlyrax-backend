function text(value) {
  return String(value ?? '').trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isSyntheticPlannerSetRow(row) {
  const marker = [
    row?.setName,
    row?.name,
    row?.description,
    row?.structure,
    row?.source,
    row?.origin,
    row?.notes,
  ].map(text).join(' ');
  return /CALIBRATION-PROOF/i.test(marker) || row?.synthetic === true || row?.testFixture === true;
}

export function isMeaningfulPlannerSetRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (isSyntheticPlannerSetRow(row)) return false;

  const reps = Math.max(0, number(row?.reps ?? row?.repetitions));
  const rounds = Math.max(0, number(row?.rounds ?? row?.roundCount));
  const distance = Math.max(0, number(row?.distance ?? row?.distancePerRep ?? row?.repDistance));
  const explicitVolume = Math.max(
    0,
    number(row?.totalVolume),
    number(row?.plannedVolume),
    number(row?.volume),
    number(row?.setVolume),
  );

  if (explicitVolume > 0) return true;
  if (distance > 0 && (reps > 0 || rounds > 0)) return true;

  const description = [
    row?.actualSet,
    row?.description,
    row?.structure,
    row?.setName,
    row?.name,
  ].map(text).filter(Boolean).join(' ');
  if (/\b\d+\s*[x×]\s*\d+\b/i.test(description)) return true;

  return false;
}
