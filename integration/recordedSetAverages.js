// Canonical read-only set summary. Individual reps remain owned by Training/Tests Results.
// Never use planned send-off, session duration or an incomplete set of split times as a recorded swim.
export function parseRecordedSwimSeconds(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '—' || raw === '--:--') return null;
  if (/^[0-9]+(?:[.][0-9]+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
  const parts = raw.split(':');
  if (parts.length !== 2 || !/^[0-9]+$/.test(parts[0]) || !/^[0-9]{1,2}(?:[.][0-9]+)?$/.test(parts[1])) return null;
  const minutes = Number(parts[0]);
  const seconds = Number(parts[1]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds >= 60) return null;
  const total = minutes * 60 + seconds;
  return total > 0 ? Number(total.toFixed(3)) : null;
}

export function formatRecordedSwimSeconds(value) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const rounded = Math.round(value * 100) / 100;
  const minutes = Math.floor(rounded / 60);
  const seconds = (rounded - minutes * 60).toFixed(2).padStart(5, '0');
  return `${minutes}:${seconds}`;
}

const recordedCount = (value) => {
  const raw = String(value ?? '').trim();
  if (!/^[0-9]+(?:[.][0-9]+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function recordedRepValues(rep) {
  const row = rep && typeof rep === 'object' ? rep : {};
  const splits = Array.isArray(row.splits) ? row.splits : [];
  const rawOverallTime = Object.prototype.hasOwnProperty.call(row, 'recordedOverallTime')
    ? row.recordedOverallTime : (String(row.overallTime ?? '').trim() || row.time || '');
  const explicitTime = parseRecordedSwimSeconds(rawOverallTime);
  const splitTimes = splits.map((split) => parseRecordedSwimSeconds(split?.time));
  const seconds = explicitTime ?? (splitTimes.length > 0 && splitTimes.every((value) => value !== null)
    ? splitTimes.reduce((sum, value) => sum + value, 0) : null);
  const rawOverallCycles = Object.prototype.hasOwnProperty.call(row, 'recordedOverallStrokeCount')
    ? row.recordedOverallStrokeCount : (String(row.overallStrokeCount ?? '').trim() || row.strokeCount || row.sc);
  const explicitCycles = recordedCount(rawOverallCycles);
  const splitCycles = splits.map((split) => recordedCount(split?.strokeCount));
  const cycles = explicitCycles ?? (splitCycles.length > 0 && splitCycles.every((value) => value !== null)
    ? splitCycles.reduce((sum, value) => sum + value, 0) : null);
  return { seconds, cycles };
}

export function summarizeRecordedReps(reps, { plannedCount = 0 } = {}) {
  const source = Array.isArray(reps) ? reps : [];
  const values = source.map(recordedRepValues);
  const timeValues = values.map((item) => item.seconds).filter((n) => n !== null);
  const cycleValues = values.map((item) => item.cycles).filter((n) => n !== null);
  const count = (numbers) => numbers.length;
  const average = (numbers) => numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
  const averageTimeSeconds = average(timeValues);
  const averageCycles = average(cycleValues);
  return {
    plannedCount: Math.max(0, Math.round(Number(plannedCount) || 0)),
    timeRecordedCount: count(timeValues),
    cyclesRecordedCount: count(cycleValues),
    averageTimeSeconds,
    averageTime: formatRecordedSwimSeconds(averageTimeSeconds),
    averageCycles: averageCycles === null ? '—' : String(Number(averageCycles.toFixed(1))),
    fastestTime: timeValues.length ? formatRecordedSwimSeconds(Math.min(...timeValues)) : '—',
    slowestTime: timeValues.length ? formatRecordedSwimSeconds(Math.max(...timeValues)) : '—',
  };
}

// Do not mix source-set values and linked test copies of those same reps.
export function summarizeStoredSetReps(setRow, { swimmerId = 'all', tests = [] } = {}) {
  const set = setRow && typeof setRow === 'object' ? setRow : {};
  const requested = String(swimmerId || 'all').trim();
  const specific = requested && requested !== 'all' && requested !== '__all__';
  const bySwimmer = set.resultsBySwimmer && typeof set.resultsBySwimmer === 'object' ? set.resultsBySwimmer : {};
  const entries = specific ? (bySwimmer[requested] ? [bySwimmer[requested]] : [])
    : Object.values(bySwimmer).filter((item) => item && typeof item === 'object');
  const fromEntries = entries.flatMap((entry) => Array.isArray(entry) ? entry : (Array.isArray(entry?.reps) ? entry.reps : []));
  const original = Array.isArray(set.repResults) ? set.repResults.filter((rep) =>
    !specific || String(rep?.swimmerId || '').trim() === requested) : [];
  const setId = String(set.id || '').trim();
  const linked = (Array.isArray(tests) ? tests : []).filter((test) =>
    setId && [test?.linkedSetId, test?.setId, test?.trainingSetId].some((id) => String(id || '').trim() === setId)
    && (!specific || String(test?.swimmerId || '').trim() === requested));
  const fallback = linked.flatMap((test) => Array.isArray(test?.repResults) ? test.repResults : []);
  const reps = fromEntries.length ? fromEntries : original.length ? original : fallback;
  const plannedRepsPerSwimmer = Math.max(1, Math.round(Number(set.rounds || 1) * Number(set.reps || set.repeats || 1)) || 1);
  const participantCount = specific ? 1 : Math.max(1, entries.length || new Set(original.map((rep) => rep?.swimmerId).filter(Boolean)).size || linked.length);
  return summarizeRecordedReps(reps, { plannedCount: plannedRepsPerSwimmer * participantCount });
}
