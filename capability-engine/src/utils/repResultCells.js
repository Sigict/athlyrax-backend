import { resolveCompetitionCourseKey } from './competitionCourse.js';
import { resolveRecordedRaceSplits } from './recordedRaceResultDisplay.js';

// One recorded repetition as display parts: time, arm strokes, stroke cycles
// and underwater distance. Only recorded values are shown; nothing is derived
// or estimated. Strokes and stroke cycles are separate measurements: a legacy
// count saved with unit "cycles" is shown as cycles, never as strokes.
const text = (value) => String(value ?? '').trim();
const list = (value) => (Array.isArray(value) ? value : []);
const recorded = (value) => text(value) !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
const round1 = (value) => String(Math.round(Number(value) * 10) / 10);

export function repCellParts(rep) {
  const row = rep && typeof rep === 'object' ? rep : {};
  const legacyCycles = row.strokeCountUnit === 'cycles';
  // "0:15.77" and "15.77" are the same recorded time: drop a zero minute.
  const time = text(row.overallTime || row.time || row.resultTime).replace(/^0+:(?=\d{2}(?:\.|$))/, '');
  const strokes = legacyCycles ? '' : text(row.overallStrokeCount ?? row.strokeCount);
  const cycles = text(row.strokeCycles ?? (legacyCycles ? (row.overallStrokeCount ?? row.strokeCount) : ''));
  // Underwater: the swim total, else the recorded lengths/splits summed, else
  // the per-wall breakout distance (shown per wall; no wall count assumed).
  let underwater = '';
  if (recorded(row.underwaterDistance)) underwater = `${round1(row.underwaterDistance)} m`;
  else {
    const lengths = [...list(row.lengths), ...list(row.splits)].filter((item) => recorded(item?.underwaterDistance));
    if (lengths.length) underwater = `${round1(lengths.reduce((sum, item) => sum + Number(item.underwaterDistance), 0))} m`;
    else if (recorded(row.breakoutDistance)) underwater = `${round1(row.breakoutDistance)} m/wall`;
  }
  const hasValue = Boolean(time || strokes || cycles || underwater);
  return { time, strokes, cycles, underwater, hasValue };
}

// Second line of a grid cell: "12 str · 6 cyc · UW 7.5 m".
export function repCellDetail(parts) {
  return [
    parts.strokes ? `${parts.strokes} str` : '',
    parts.cycles ? `${parts.cycles} cyc` : '',
    parts.underwater ? `UW ${parts.underwater}` : '',
  ].filter(Boolean).join(' · ');
}

// Recorded times as seconds ("1:07.98" → 67.98); null when not a time.
export function timeSeconds(value) {
  const raw = text(value);
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(raw)) return null;
  return raw.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

export function secondsToTime(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const hundredths = Math.round(seconds * 100);
  const minutes = Math.floor(hundredths / 6000);
  const rest = ((hundredths % 6000) / 100).toFixed(2).padStart(5, '0');
  return minutes ? `${minutes}:${rest}` : rest;
}

// Difference between two recorded times of the same swimmer, "−1.61 s".
export function timeChangeLabel(current, previous) {
  const a = timeSeconds(current);
  const b = timeSeconds(previous);
  if (a === null || b === null) return '';
  const change = Math.round((a - b) * 100) / 100;
  return change === 0 ? '±0.00 s' : `${change < 0 ? '−' : '+'}${Math.abs(change).toFixed(2)} s`;
}

const repSplits = (rep) => {
  const splits = list(rep?.splits).length ? list(rep?.splits) : list(rep?.lengths);
  return splits.map((split) => ({ ...split, time: text(split?.time || split?.splitTime || split?.segmentTime || split?.lengthTime) }));
};
const splitLabel = (distance, count) => (distance && count && Number.isInteger(distance / count)
  ? (index) => `${(index + 1) * (distance / count)}m` : (index) => `Split ${index + 1}`);

// Each cell is compared with the same column of the swimmer's previous row.
function attachPreviousRows(rows) {
  const lastByKey = new Map();
  for (const row of rows) {
    const previous = lastByKey.get(row.compareKey);
    if (previous) {
      row.compare = previous.reps;
      if (previous.total) row.totalCompare = previous.total;
    }
    lastByKey.set(row.compareKey, row);
  }
}

// Recorded tests grouped by protocol for a swimmer × repetition grid.
//   dateOf: rows carry their date (name "Swimmer · date"), and each cell
//     shows the change from the swimmer's previous date.
//   pivotSingleRep: one-rep protocols become swimmer × date grids.
//   A one-rep protocol with recorded splits shows one column per split.
export function groupRepRowsByProtocol(rows, { protocolOf, swimmerOf, dateOf, compareKeyOf, pivotSingleRep = false } = {}) {
  const protocol = protocolOf || ((row) => text(row?.itemLabel || row?.testName || row?.test || 'Test'));
  const swimmer = swimmerOf || ((row) => text(row?.swimmerName || row?.swimmerId || 'Swimmer'));
  const date = dateOf || (() => '');
  const compareKey = compareKeyOf || ((row) => text(row?.swimmerId) || swimmer(row));
  const groups = new Map();
  for (const row of list(rows)) {
    const key = protocol(row);
    if (!groups.has(key)) groups.set(key, { key, title: key, entries: [] });
    groups.get(key).entries.push(row);
  }
  return [...groups.values()].map(({ key, title, entries }) => {
    const sorted = entries.map((row, index) => ({ row, index, name: swimmer(row), date: text(date(row)) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date) || a.index - b.index);
    const singleRep = sorted.every(({ row }) => list(row?.repResults).length <= 1);
    const firstRep = (row) => list(row?.repResults)[0];
    const fallbackOf = (row) => text(row?.resultValue ?? row?.result);
    const hasSplits = singleRep && sorted.some(({ row }) => repSplits(firstRep(row)).filter((split) => split.time).length >= 2);
    if (hasSplits) {
      const count = Math.max(...sorted.map(({ row }) => repSplits(firstRep(row)).length));
      const distance = Number(sorted[0]?.row?.distance) || 0;
      const out = sorted.map(({ row, name, date: day }) => ({
        key: text(row?.id) || `${key}-${name}-${day}`, name: day ? `${name} · ${day}` : name, compareKey: compareKey(row),
        reps: repSplits(firstRep(row)), total: text(firstRep(row)?.overallTime || firstRep(row)?.time) || fallbackOf(row), fallback: fallbackOf(row),
      }));
      attachPreviousRows(out);
      return { key, title, columnLabel: splitLabel(distance, count), totalHeader: 'Time', rows: out };
    }
    if (pivotSingleRep && singleRep && sorted.some(({ date: day }) => day)) {
      const dates = [...new Set(sorted.map(({ date: day }) => day))].sort();
      const bySwimmer = new Map();
      for (const { row, name, date: day } of sorted) {
        const id = compareKey(row);
        if (!bySwimmer.has(id)) bySwimmer.set(id, { key: `${key}-${id}`, name, reps: dates.map(() => null) });
        bySwimmer.get(id).reps[dates.indexOf(day)] = firstRep(row) || (fallbackOf(row) ? { overallTime: fallbackOf(row) } : null);
      }
      const out = [...bySwimmer.values()].map((item) => {
        let previous = null;
        const compare = item.reps.map((rep) => { const before = previous; if (rep) previous = rep; return before; });
        return { ...item, compare };
      });
      return { key, title, columnLabel: (index) => dates[index], rows: out };
    }
    const out = sorted.map(({ row, name, date: day }) => ({
      key: text(row?.id) || `${key}-${name}-${day}`, name: day ? `${name} · ${day}` : name, compareKey: compareKey(row),
      reps: list(row?.repResults), fallback: fallbackOf(row),
    }));
    if (dateOf) attachPreviousRows(out);
    return { key, title, rows: out };
  });
}

// Recorded race splits as grid cells, read exactly as the Program Sheet reads
// them: saved segment times first, then the split rows. (Older demo races also
// keep a list of running times that was never rescaled; it is not shown.)
export function competitionSplitReps(row) {
  const result = row?.raw?.result && typeof row.raw.result === 'object' ? row.raw.result : row?.raw;
  const segments = list(result?.segmentTimes);
  const live = list(result?.splits);
  const count = segments.length || live.length;
  if (!count) return [];
  const distance = Number(row?.distance) || 0;
  const length = distance && Number.isInteger(distance / count) ? distance / count : null;
  return resolveRecordedRaceSplits(result, count, length);
}

// The race time as recorded; when only split times were saved, their sum
// (every split recorded), labelled as such. Display only.
export function competitionResultTime(row) {
  const recorded = text(row?.resultValue ?? row?.finalTime);
  if (recorded) return { time: recorded, fromSplits: false };
  const splits = competitionSplitReps(row);
  const seconds = splits.map((split) => timeSeconds(split.time));
  if (splits.length && seconds.every((value) => value !== null)) {
    return { time: secondsToTime(seconds.reduce((sum, value) => sum + value, 0)), fromSplits: true };
  }
  return { time: '', fromSplits: false };
}

// Pool course of a race: short course, long course and yards are separate
// performances and are never grouped or compared together.
export function competitionCourse(row) {
  const fixture = row?.raw?.fixture && typeof row.raw.fixture === 'object' ? row.raw.fixture : null;
  const eventItem = row?.raw?.eventItem && typeof row.raw.eventItem === 'object' ? row.raw.eventItem : null;
  const key = resolveCompetitionCourseKey({ fixture, eventItem, legacyRow: fixture ? null : (row?.raw || row) });
  const label = key === '25' ? 'Short course (25 m)' : key === '50' ? 'Long course (50 m)' : key === '25y' ? 'Short course yards (25 yd)' : 'Course not recorded';
  const short = key === '25' ? 'SC' : key === '50' ? 'LC' : key === '25y' ? 'SCY' : '';
  return { key, label, short, unit: key === '25y' ? 'yd' : 'm' };
}

// Completed races grouped by event for a swimmer × split grid. Columns are
// named by split distance when the splits divide the race evenly; each cell
// is compared with the swimmer's previous race in the same event.
export function groupCompetitionSplitRows(rows, { swimmerOf, dateOf, compareKeyOf } = {}) {
  const swimmer = swimmerOf || ((row) => text(row?.swimmerName || row?.swimmerId || 'Swimmer'));
  const date = dateOf || ((row) => text(row?.date));
  const compareKey = compareKeyOf || ((row) => text(row?.swimmerId) || swimmer(row));
  const groups = new Map();
  for (const row of list(rows)) {
    const splits = competitionSplitReps(row);
    const distance = Number(row?.distance) || 0;
    const splitLength = distance && splits.length && Number.isInteger(distance / splits.length) ? distance / splits.length : 0;
    const course = competitionCourse(row);
    // Same race = same distance, stroke and course, however the meet named it
    // ("100 Free", "100m Free").
    const stroke = text(row?.stroke) || text(row?.eventName || row?.event).replace(/^\d+\s*(?:m|yd|y)?\s*/i, '');
    const event = distance ? `${distance}${course.unit} ${stroke}`.trim() : (text(row?.eventName || row?.event) || 'Race');
    const key = [event, course.short || course.label, splitLength ? `${splitLength}${course.unit} splits` : ''].filter(Boolean).join(' · ');
    if (!groups.has(key)) groups.set(key, { key, title: key, columnLabel: splitLength ? (index) => `${(index + 1) * splitLength}${course.unit}` : (index) => `Split ${index + 1}`, rows: [] });
    const result = competitionResultTime(row);
    groups.get(key).rows.push({ key: text(row?.id) || `${key}-${groups.get(key).rows.length}`, name: swimmer(row), date: text(date(row)),
      compareKey: compareKey(row), reps: splits, total: result.time ? `${result.time}${result.fromSplits ? ' (Σ splits)' : ''}` : '' });
  }
  for (const group of groups.values()) {
    group.rows.sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date));
    attachPreviousRows(group.rows);
  }
  return [...groups.values()];
}
