// Read actual swimmer-specific competition measurements from the same
// canonical race row as ISP/Analysis. Never infer a result from a PB flag,
// placing, scheduled entry or another swimmer's result.
const asArray = value => Array.isArray(value) ? value : [];
const recordedTime = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).trim();
  return /^\d+(?::[0-5]?\d){0,2}(?:\.\d+)?$/.test(text) ? text : '';
};
const recordedCycles = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return '';
  // Zero is a legitimate measured count for a fully underwater pool length.
  return Number(text) >= 0 ? text : '';
};

export function resolveRecordedRaceResult(row = {}) {
  const race = row?.raw?.result && typeof row.raw.result === 'object'
    ? row.raw.result : row?.raw && typeof row.raw === 'object' ? row.raw : row;
  const timeFields = [
    row?.resultValue, row?.time, row?.officialTime, row?.resultTime,
    row?.totalTime, row?.finalTime, row?.actualTime,
    race?.resultValue, race?.resultTime, race?.officialTime,
    race?.totalTime, race?.finalTime, race?.actualTime,
    race?.time, race?.result,
  ];
  const time = timeFields.map(recordedTime).find(Boolean) || '—';
  // Arm strokes and stroke cycles are two different measurements. The race
  // total stroke count never falls back to a cycle count (or vice versa).
  const strokeUnitIsCycles = (record) => String(record?.strokeCountUnit ?? '').trim().toLowerCase().startsWith('cycle');
  const strokeFields = [
    strokeUnitIsCycles(row) ? '' : row?.overallStrokeCount, strokeUnitIsCycles(row) ? '' : row?.strokeCount,
    strokeUnitIsCycles(race) ? '' : race?.overallStrokeCount, strokeUnitIsCycles(race) ? '' : race?.strokeCount,
  ];
  const cycleFields = [
    row?.strokeCycles, row?.cycleCount, row?.cycles, race?.strokeCycles, race?.cycleCount, race?.cycles,
    strokeUnitIsCycles(row) ? row?.overallStrokeCount ?? row?.strokeCount : '',
    strokeUnitIsCycles(race) ? race?.overallStrokeCount ?? race?.strokeCount : '',
  ];
  const raceCycles = cycleFields.map(recordedCycles).find(Boolean) || '';
  // Legacy name: `cycles` is the race-total STROKE count used by older callers.
  let cycles = strokeFields.map(recordedCycles).find(Boolean) || '';
  // Individual recorded split counts are a different type of measurement.
  // Show a per-length mean, not an invented total stroke count.
  let cyclesSource = cycles ? 'recorded-race' : 'not-recorded';
  if (!cycles) {
    const splitCounts = asArray(race?.splits)
      .map(split => split && typeof split === 'object' ? recordedCycles(split.strokeCount) : '')
      .filter(Boolean).map(Number);
    if (splitCounts.length) {
      cycles = String(Math.round(splitCounts.reduce((s,n) => s+n,0) / splitCounts.length * 10)/10);
      cyclesSource = 'mean-of-recorded-split-counts';
    }
  }
  return {
    time, cycles: cycles || '—', cyclesSource,
    hasTime: time !== '—', hasCycles: Boolean(cycles),
    strokeCount: cyclesSource === 'recorded-race' ? cycles : '',
    raceCycles,
  };
}

/**
 * Normalise per-length split measurements into the Program Sheet's canonical
 * editable object representation. Imported race snapshots can provide a
 * cumulative "splits" string array plus an explicit segmentTimes array;
 * prefer the actual segment times in that case. Do not guess stroke counts
 * per length from a recorded overall total.
 */
export function resolveRecordedRaceSplits(result = {}, splitCount = 0, splitLength = null) {
  const count = Math.max(0, Math.floor(Number(splitCount) || 0));
  const requestedLength = Number(splitLength);
  const versions = result?.splitRecordsByLength;
  const savedAtLength = versions && typeof versions === 'object'
    ? asArray(versions[String(requestedLength)])
    : [];
  const current = asArray(result?.splits);
  // A saved version must match the requested number of lengths. Never
  // reinterpret 25m measurements as 50m (or vice versa).
  // Live splits recorded at the requested length are the current truth; a
  // saved per-length copy is used only when the live splits are at another length.
  const liveAtRequestedLength = current.length === count
    && Number(result?.splitLength) === requestedLength;
  // Some legacy fixtures hold blank live placeholder splits while their real
  // measurements are stored under splitRecordsByLength. These placeholders
  // must not hide entered stroke counts. An explicitly edited/deleted live row
  // (measurementSource / strokeCycleSource) remains authoritative.
  const isUntouchedPlaceholder = row => row && typeof row === 'object'
    && !String(row.measurementSource ?? row.strokeCycleSource ?? '').trim()
    && ![row.time,row.segmentTime,row.lengthTime,row.strokeCount,row.strokeCycles,
      row.cycleCount,row.cycles,row.underwaterDistance].some(value => value !== undefined && value !== null && String(value).trim() !== '');
  const emptyLivePlaceholders = current.length === count && current.every(isUntouchedPlaceholder);
  const hasSavedMeasurements = savedAtLength.some(row =>
    row && typeof row === 'object' && [row.time,row.strokeCount,row.strokeCycles,row.underwaterDistance]
      .some(value => value !== undefined && value !== null && String(value).trim() !== ''));
  const preferStoredVersion = savedAtLength.length === count
    && (requestedLength === 25 || requestedLength === 50)
    && emptyLivePlaceholders && hasSavedMeasurements;
  const direct = liveAtRequestedLength && !preferStoredVersion ? current
    : savedAtLength.length === count && (requestedLength === 25 || requestedLength === 50)
      ? savedAtLength : current.length === count ? current : [];
  const splits = direct.length ? direct : combineShorterSplits(result, count);
  const segments = asArray(result?.segmentTimes);
  const matchedSegments = segments.length === count;
  return Array.from({ length: count }, (_, index) => {
    const split = splits[index];
    const object = split && typeof split === 'object' ? split : null;
    // Legacy 50m segment times are authoritative when a stale placeholder
    // split object exists but its own time is blank. A real saved split wins.
    const ownTime = object
      ? recordedTime(object.time ?? object.segmentTime ?? object.lengthTime)
      : '';
    const measuredSegment = matchedSegments ? recordedTime(segments[index]) : '';
    // Two separate measurements: arm strokes and complete stroke cycles. A
    // value saved with an explicit "cycles" unit in the stroke field is a cycle count.
    const explicitCycleUnit = object && String(object.strokeCountUnit ?? '').trim().toLowerCase().startsWith('cycle');
    return {
      time: ownTime || measuredSegment || (object ? '' : recordedTime(split)),
      strokeCount: object && !explicitCycleUnit ? recordedCycles(object.strokeCount) : '',
      // An absent underwater measurement stays absent, rather than
      // becoming an invented zero or an empty persisted field.
      ...(object && object.underwaterDistance !== undefined
        && object.underwaterDistance !== null && String(object.underwaterDistance).trim() !== ''
        ? { underwaterDistance: recordedCycles(object.underwaterDistance) } : {}),
      strokeCycles: object ? ([object.strokeCycles, object.cycleCount, object.cycles,
        explicitCycleUnit ? object.strokeCount : undefined].map(recordedCycles).find((value) => value !== '') ?? '') : '',
    };
  });
}

// Splits recorded at a shorter interval (e.g. 25m when 50m is shown) are
// added up into the longer ones. A value is shown only when every shorter
// split in it was recorded; nothing is estimated.
function combineShorterSplits(result, count) {
  if (!count) return [];
  const versions = result?.splitRecordsByLength && typeof result.splitRecordsByLength === 'object'
    ? Object.values(result.splitRecordsByLength) : [];
  const source = [asArray(result?.splits), ...versions.map(asArray)]
    .find((rows) => rows.length > count && rows.length % count === 0
      && rows.some((row) => row && typeof row === 'object'));
  if (!source) return [];
  const per = source.length / count;
  const seconds = (value) => {
    const time = recordedTime(value);
    return time ? time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) : null;
  };
  const sum = (parts, read) => {
    const values = parts.map(read);
    return values.every((value) => value !== null && value !== '' && Number.isFinite(Number(value)))
      ? values.reduce((total, value) => total + Number(value), 0) : null;
  };
  return Array.from({ length: count }, (_, index) => {
    const parts = source.slice(index * per, index * per + per).map((row) => (row && typeof row === 'object' ? row : { time: row }));
    const cycleUnit = (row) => String(row?.strokeCountUnit ?? '').trim().toLowerCase().startsWith('cycle');
    const time = sum(parts, (row) => seconds(row.time ?? row.segmentTime ?? row.lengthTime));
    const strokes = sum(parts, (row) => (cycleUnit(row) ? null : recordedCycles(row.strokeCount) || null));
    const cycles = sum(parts, (row) => recordedCycles(row.strokeCycles ?? row.cycleCount ?? row.cycles) || null);
    const underwater = sum(parts, (row) => recordedCycles(row.underwaterDistance) || null);
    const minutes = time === null ? 0 : Math.floor(Math.round(time * 100) / 6000);
    const rest = time === null ? '' : ((Math.round(time * 100) % 6000) / 100).toFixed(2);
    return {
      time: time === null ? '' : (minutes ? `${minutes}:${rest.padStart(5, '0')}` : rest),
      ...(strokes !== null ? { strokeCount: String(strokes) } : {}),
      ...(cycles !== null ? { strokeCycles: String(cycles) } : {}),
      ...(underwater !== null ? { underwaterDistance: String(Math.round(underwater * 10) / 10) } : {}),
    };
  });
}

/** Provisional times attached to a future fixture are NOT completed results. */
export function canDisplayRecordedRaceOnDate(eventDate, asOfDate = new Date()) {
  const raw = String(eventDate || '').trim();
  const date = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '';
  const today = asOfDate instanceof Date
    ? asOfDate.toISOString().slice(0, 10)
    : String(asOfDate || '').slice(0, 10);
  return !date || date <= today;
}

/**
 * A legacy race may have 50m recorded segments even when the Program Sheet
 * otherwise defaults to editable 25m lengths. Infer the display resolution
 * from actual past-race segments, never from uncompleted future templates.
 * An explicit 25/50m user configuration is authoritative.
 */
export function resolveRecordedProgramSplitLength(event = {}, { asOfDate = new Date() } = {}) {
  // The split interval is the pool length of the competition course (25 m,
  // 50 m or 25 yd). Splits already recorded keep the interval they were
  // recorded at, so no saved measurement is reinterpreted.
  const recordedResults = event?.resultsBySwimmer && typeof event.resultsBySwimmer === 'object'
    ? Object.values(event.resultsBySwimmer).filter((result) => result && typeof result === 'object'
      && (asArray(result.segmentTimes).some((value) => recordedTime(value))
        || asArray(result.splits).some((split) => split && typeof split === 'object'
          && [split.time, split.strokeCount, split.strokeCycles].some((value) => String(value ?? '').trim() !== ''))))
    : [];
  const course = Number(event?.poolLength);
  if ((course === 25 || course === 50) && recordedResults.length === 0) return course;
  const explicitlyConfigured = Number(event?.resultsConfig?.splitLength);
  if (explicitlyConfigured === 25 || explicitlyConfigured === 50) return explicitlyConfigured;
  const distance = Number(event?.distance);
  if (!Number.isFinite(distance) || distance <= 0 ||
      !canDisplayRecordedRaceOnDate(event?.date, asOfDate)) return 25;
  const results = event?.resultsBySwimmer && typeof event.resultsBySwimmer === 'object'
    ? Object.values(event.resultsBySwimmer) : [];
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const segments = asArray(result.segmentTimes);
    const splits = asArray(result.splits);
    const candidates = [segments.length, splits.length];
    for (const count of candidates) {
      if (count > 0 && distance / count === 50 &&
          (segments.length === count ? segments.every(value => recordedTime(value)) :
            splits.every(value => recordedTime(value) || (value && typeof value === 'object')))) {
        return 50;
      }
    }
  }
  return 25;
}


const STROKES = Object.freeze({
  free:'Freestyle',freestyle:'Freestyle',frontcrawl:'Freestyle',crawl:'Freestyle',
  back:'Backstroke',backstroke:'Backstroke',
  breast:'Breaststroke',breaststroke:'Breaststroke',
  fly:'Butterfly',butterfly:'Butterfly',
});

function strokeToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g,'');
}

export function normaliseRaceStroke(value) {
  const key=strokeToken(value);
  if (key === 'im' || key === 'individualmedley' || key === 'medley') return 'Individual Medley';
  if (key === 'medleyrelay' || key === 'mixedmedleyrelay') return 'Medley Relay';
  if (key === 'freerelay' || key === 'freestylerelay') return 'Freestyle Relay';
  return STROKES[key] || String(value ?? '').trim() || 'Unspecified';
}

/**
 * Real event stroke for a pool-length interval, not inferred from stroke count.
 * Individual medley order: Fly, Back, Breast, Free.
 * Medley relay order: Back, Breast, Fly, Free.
 * If the selected interval crosses a stroke transition, report Mixed;
 * never attribute the whole interval to just one technique.
 */
export function strokeForRaceLength(event = {}, splitIndex = 0, splitLength = 25, relayLeg = null) {
  const rawStroke=event?.stroke || event?.eventStroke || event?.event || event?.eventLabel || '';
  const stroke=normaliseRaceStroke(rawStroke);
  const isRelay=event?.isRelay === true || String(event?.eventType || '').toLowerCase()==='relay'
    || stroke === 'Medley Relay' || stroke === 'Freestyle Relay';
  if (stroke === 'Medley Relay') {
    const leg=Number(relayLeg);
    return Number.isInteger(leg) && leg >= 1 && leg <= 4
      ? ['Backstroke','Breaststroke','Butterfly','Freestyle'][leg-1]
      : 'Medley Relay';
  }
  if (stroke === 'Freestyle Relay') return 'Freestyle';
  if (stroke !== 'Individual Medley' || isRelay) return stroke;
  const distance=Number(event?.distance);
  const length=Number(splitLength);
  const index=Number(splitIndex);
  if (!(distance > 0 && length > 0 && index >= 0) || distance % 4 !== 0) return 'Individual Medley';
  const portion=distance/4;
  const start=index*length;
  const end=Math.min(distance,start+length);
  if (end<=start) return 'Individual Medley';
  const first=Math.min(3,Math.floor(start/portion));
  const last=Math.min(3,Math.floor((end-0.000001)/portion));
  return first===last ? ['Butterfly','Backstroke','Breaststroke','Freestyle'][first] : 'Mixed strokes';
}

export function normaliseStrokeCountUnit(value, stroke='') {
  const input=String(value ?? '').trim().toLowerCase();
  if (input==='stroke' || input==='strokes' || input==='arm-strokes') return 'strokes';
  if (input==='cycle' || input==='cycles' || input==='stroke-cycles') return 'cycles';
  const technique=normaliseRaceStroke(stroke);
  return technique==='Butterfly' || technique==='Breaststroke' ? 'cycles' : 'strokes';
}

export function validIndividualStrokeCount(value) {
  const raw=String(value ?? '').trim();
  return !raw || (/^\d+$/.test(raw) && Number(raw)>=0) ? raw : null;
}


/** Exactly one original recorded split is shown in one table cell. */
export function resolveEventSplitMeasurements({
  event={}, result={}, splitCount=0, splitLength=25, relayLeg=null,
  allowProvisional=false,
} = {}) {
  // Only explicitly scoped EDITORS can show provisional future race entries.
  // All other consumers retain the completed-result date gate.
  const source=allowProvisional || canDisplayRecordedRaceOnDate(event?.date) ? result : {};
  const base=resolveRecordedRaceSplits(source,splitCount,splitLength);
  return base.map((split,index)=>{
    const saved = source?.splitRecordsByLength?.[String(Number(splitLength))];
    const matchingSaved = asArray(saved).length === splitCount ? asArray(saved) : [];
    const current = asArray(source?.splits);
    const currentMatches = current.length === splitCount ? current : [];
    const raw = (matchingSaved.length ? matchingSaved : currentMatches)[index];
    const meta=raw&&typeof raw==='object'?raw:{};
    const stroke=strokeForRaceLength(event,index,splitLength,relayLeg);
    return {
      ...split,
      stroke,
      // The stroke field holds arm strokes only; cycles are their own field.
      strokeCountUnit:'strokes',
      measurementSource:String(meta?.measurementSource || ''),
    };
  });
}
