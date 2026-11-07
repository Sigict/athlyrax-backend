// Derived swimming metrics. Recorded time and ARM STROKES are the inputs.
// Do not substitute an invented stroke measurement for a missing observation.
// An alternating-arm freestyle/backstroke cycle has TWO arm strokes;
// breaststroke/butterfly are one coordinated arm pull per complete cycle.
export function swimmingStrokeFamily(stroke) {
  const name = String(stroke ?? '').trim().toLowerCase().replace(/[_-]/g, ' ');
  if (!name || /\b(im|individual medley|medley|mixed|choice|stroke mix|drill|kick only)\b/.test(name)) return null;
  const candidates = [
    [/\b(free|freestyle|front crawl|crawl|fr)\b/, 'freestyle'],
    [/\b(back|backstroke|bk)\b/, 'backstroke'],
    [/\b(breast|breaststroke|br)\b/, 'breaststroke'],
    [/\b(fly|butterfly|bf)\b/, 'butterfly'],
  ].filter(([pattern]) => pattern.test(name)).map(([, family]) => family);
  return candidates.length === 1 ? candidates[0] : null;
}

export function deriveStrokeCycles(strokeCount, stroke) {
  const family = swimmingStrokeFamily(stroke);
  const raw = String(strokeCount ?? '').trim();
  if (!family || !/^\d{1,5}$/.test(raw)) return null;
  const count = Number(raw);
  if (!Number.isSafeInteger(count)) return null;
  return (family === 'freestyle' || family === 'backstroke') ? count / 2 : count;
}

// Race and rep times: 35.20 or 1:05.20. Never read Planner send-off as a swim time.
export function measuredSwimSeconds(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?::[0-5]?\d){0,2}(?:\.\d+)?$/.test(raw)) return null;
  const parts = raw.split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n) || n < 0)) return null;
  let total = parts.pop();
  if (parts.length) total += parts.pop() * 60;
  if (parts.length) total += parts.pop() * 3600;
  return total > 0 ? total : null;
}

export function calculatedStrokeMetrics({ stroke, strokeCount, strokeCycles, time, distance, swimDistance, underwaterDistance, unit = 'm' } = {}) {
  const seconds = measuredSwimSeconds(time);
  const rawDistance = Number(distance);
  const metres = String(unit).toLowerCase().startsWith('y') ? rawDistance * 0.9144 : rawDistance;
  const distanceMetres = Number.isFinite(metres) && metres > 0 ? metres : null;
  const derivedCycles = deriveStrokeCycles(strokeCount, stroke);
  // A historical explicitly recorded cycle count remains legitimate evidence
  // when the stroke type or raw arm-stroke count is unavailable.
  const recordedRaw = String(strokeCycles ?? '').trim();
  const recordedCycles = /^\d+(?:\.5)?$/.test(recordedRaw) ? Number(recordedRaw) : null;
  const cycles = derivedCycles !== null ? derivedCycles : recordedCycles;
  const actualSwimDistance = Number(swimDistance);
  // A pool length includes the wall push-off, turn, and possibly underwater kick.
  // Full-distance per-cycle is a proxy, not a measured surface-stroke length.
  // Underwater distance is never invented. When explicitly entered, remove
  // it from pool distance to estimate surface distance per stroke cycle.
  const suppliedUnderwater = underwaterDistance !== null && underwaterDistance !== undefined && String(underwaterDistance).trim() !== '';
  const underwaterMetres = suppliedUnderwater ? Number(underwaterDistance) * (String(unit).toLowerCase().startsWith('y') ? 0.9144 : 1) : null;
  const validUnderwater = underwaterMetres !== null && Number.isFinite(underwaterMetres) && underwaterMetres >= 0 && distanceMetres !== null && underwaterMetres < distanceMetres;
  const hasExplicitSwimDistance = Number.isFinite(actualSwimDistance) && actualSwimDistance > 0;
  const strokeDistance = hasExplicitSwimDistance ? actualSwimDistance
    : validUnderwater ? distanceMetres - underwaterMetres : distanceMetres;
  return {
    strokeCycles: cycles,
    speed: seconds && distanceMetres ? distanceMetres / seconds : null,
    strokeLength: cycles && strokeDistance ? strokeDistance / cycles : null,
    strokeCyclesPerMinute: seconds && cycles !== null ? cycles * 60 / seconds : null,
    strokeLengthIsPoolProxy: !hasExplicitSwimDistance && !validUnderwater,
    strokeLengthUsesRecordedUnderwater: !hasExplicitSwimDistance && validUnderwater,
  };
}

export function swimmingMetricsLabel(metrics) {
  const m = metrics || {};
  const parts = [];
  // Show the calculated cycle total as read-only evidence, not an entry field.
  if (m.strokeCycles !== null && m.strokeCycles !== undefined) parts.push(String(m.strokeCycles) + ' cycles');
  if (m.speed !== null && m.speed !== undefined) parts.push(m.speed.toFixed(2) + ' m/s');
  if (m.strokeLength !== null && m.strokeLength !== undefined)
    parts.push(m.strokeLength.toFixed(2) + ' m/cycle' + (m.strokeLengthIsPoolProxy ? ' (pool proxy)' : m.strokeLengthUsesRecordedUnderwater ? ' (underwater excluded)' : ''));
  if (m.strokeCyclesPerMinute !== null && m.strokeCyclesPerMinute !== undefined)
    parts.push(m.strokeCyclesPerMinute.toFixed(1) + ' cycles/min');
  return parts.join(' · ') || 'Enter time, distance and strokes to calculate metrics';
}
