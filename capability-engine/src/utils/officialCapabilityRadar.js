// The individual-swimmer graph is a presentation of the official ISP snapshot,
// not a second scoring calculation.
export function officialCapabilityRadar(snapshot, axisKeys = []) {
  if (snapshot?.selectedSingleSwimmer !== true) return null;
  const byKey = new Map((Array.isArray(snapshot?.axes) ? snapshot.axes : [])
    .map((axis) => [String(axis?.key || '').trim(), axis]));
  const scores = {};
  const counts = {};
  for (const key of axisKeys) {
    const axis = byKey.get(key);
    const count = Number(axis?.evidenceCount);
    const score = axis?.score;
    const valid = score !== null && score !== undefined && score !== ''
      && Number.isFinite(Number(score)) && Number.isFinite(count) && count > 0;
    scores[key] = valid ? Number(score) : Number.NaN;
    counts[key] = valid ? count : 0;
  }
  return { scores, counts };
}
