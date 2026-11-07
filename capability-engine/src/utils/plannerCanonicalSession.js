import { resolveCanonicalSetPlannedVolume } from './volumeConsistency.js';

function text(value) {
  return String(value ?? '').trim();
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = text(value).replaceAll(',', '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const resolved = numberValue(value);
    if (resolved !== null) return resolved;
  }
  return null;
}

function firstText(...values) {
  for (const value of values) {
    const resolved = text(value);
    if (resolved) return resolved;
  }
  return '';
}

function titleCase(value) {
  return text(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((part) => {
      if (/^[A-Z0-9]{2,4}$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(' ');
}

export const PLANNER_SESSION_PART_ORDER = [
  'Warm Up',
  'Pre',
  'Main',
  'Contrast',
  '2nd Activity',
  'Warm Down',
];

export function parsePlannerDurationSeconds(value) {
  const normalized = text(value).toLowerCase().replace(/[’′]/g, "'");
  if (!normalized) return null;

  const clock = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    const first = Number(clock[1]);
    const second = Number(clock[2]);
    const third = clock[3] === undefined ? null : Number(clock[3]);
    if (third !== null) {
      if (second >= 60 || third >= 60) return null;
      return (first * 3600) + (second * 60) + third;
    }
    if (second >= 60) return null;
    return (first * 60) + second;
  }

  const swimClock = normalized.match(/^(\d{1,3})'\s*(?:(\d{1,2})(?:"|''|s)?)?$/);
  if (swimClock) {
    const minutes = Number(swimClock[1]);
    const seconds = Number(swimClock[2] || 0);
    if (seconds < 60) return (minutes * 60) + seconds;
    return null;
  }

  const hours = normalized.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/);
  const minutes = normalized.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/);
  const seconds = normalized.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/);
  if (hours || minutes || seconds) {
    return Math.max(0, Math.round(
      (Number(hours?.[1] || 0) * 3600)
      + (Number(minutes?.[1] || 0) * 60)
      + Number(seconds?.[1] || 0),
    ));
  }
  const numeric = numberValue(value);
  return numeric === null ? null : Math.max(0, numeric);
}

export function formatPlannerDurationSeconds(value) {
  const seconds = parsePlannerDurationSeconds(value);
  if (seconds === null) return text(value);
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function normalizePartName(value) {
  const normalized = text(value).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const key = normalized.toLowerCase();
  if (key.includes('warm up') || key === 'warmup') return 'Warm Up';
  if (key === 'pre' || key.startsWith('pre ')) return 'Pre';
  if (key.includes('main')) return 'Main';
  if (key.includes('contrast')) return 'Contrast';
  if (key.includes('2nd activity') || key.includes('second activity') || key.includes('secondary activity')) return '2nd Activity';
  if (key.includes('warm down') || key.includes('cool down') || key === 'cooldown') return 'Warm Down';
  return titleCase(normalized);
}

function isPlaceholderPart(value) {
  const key = text(value).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return !key || [
    'template',
    'templates',
    'test',
    'tests',
    'test set',
    'tests sets',
    'tests/sets',
    'session',
    'set',
  ].includes(key);
}

export function resolvePlannerSetPhase(row) {
  const candidates = [
    row?.phase,
    row?.part,
    row?.partName,
    row?.sectionName,
    row?.section,
    row?.category,
    row?.setType,
  ];
  for (const candidate of candidates) {
    if (isPlaceholderPart(candidate)) continue;
    const normalized = normalizePartName(candidate);
    if (normalized) return normalized;
  }
  return 'Session';
}

export function resolvePlannerSetVolume(row) {
  return Math.max(0, Number(resolveCanonicalSetPlannedVolume(row || {})) || 0);
}

function meaningfulInterval(value) {
  const normalized = text(value);
  if (!normalized || normalized === '-') return '';
  const parsed = parsePlannerDurationSeconds(normalized);
  if (parsed !== null) return parsed > 0 ? formatPlannerDurationSeconds(parsed) : '';
  return normalized;
}

export function resolvePlannerSetPrescription(row) {
  const rounds = Math.max(1, firstNumber(row?.rounds) ?? 1);
  const reps = firstNumber(row?.reps);
  const distance = firstNumber(row?.distance);
  const stroke = titleCase(firstText(row?.stroke));
  const sendOff = meaningfulInterval(firstText(row?.sendOff));

  let core = '';
  if (reps !== null && distance !== null) {
    const repeated = `${reps} × ${distance}${stroke ? ` ${stroke}` : ''}`;
    core = rounds > 1 ? `${rounds} × (${repeated})` : repeated;
  } else if (distance !== null) {
    core = `${distance}${stroke ? ` ${stroke}` : ''}`;
  } else if (stroke) {
    core = stroke;
  }

  if (sendOff) core = `${core}${core ? ' ' : ''}on ${sendOff}`;
  return core || firstText(row?.setName, row?.name, row?.title) || 'Set';
}

export function resolvePlannerSetInstructions(row) {
  const direct = firstText(row?.instructions, row?.comment, row?.comments, row?.coachNotes, row?.notes);
  if (direct) return direct;
  return firstText(row?.description);
}

export function resolvePlannerSetTimeSeconds(row) {
  const rounds = Math.max(1, firstNumber(row?.rounds) ?? 1);
  const reps = Math.max(1, firstNumber(row?.reps) ?? 1);
  const intervalText = firstText(row?.sendOff);
  if (intervalText) {
    const interval = parsePlannerDurationSeconds(intervalText);
    return interval !== null && interval > 0 ? Math.max(0, rounds * reps * interval) : 0;
  }

  const explicitSeconds = firstNumber(row?.totalTimeSec);
  if (explicitSeconds !== null && explicitSeconds > 0) return Math.max(0, explicitSeconds);

  const parsedText = parsePlannerDurationSeconds(row?.totalTime);
  return parsedText === null ? 0 : Math.max(0, parsedText);
}

export function buildPlannerCanonicalSetModel(row, index = 0) {
  const part = resolvePlannerSetPhase(row);
  const name = firstText(row?.setName, row?.name, row?.title) || `Set ${index + 1}`;
  return {
    id: text(row?.id || `${part}-${index}`),
    part,
    name,
    prescription: resolvePlannerSetPrescription(row),
    instructions: resolvePlannerSetInstructions(row),
    stroke: titleCase(firstText(row?.stroke)),
    energy: firstText(row?.__finalEnergySystem, row?.energySystem, row?.energy),
    volume: resolvePlannerSetVolume(row),
    timeSeconds: resolvePlannerSetTimeSeconds(row),
    source: row,
  };
}

export function buildPlannerCanonicalSetModels(rows) {
  return (Array.isArray(rows) ? rows : []).map(buildPlannerCanonicalSetModel);
}

export function summarizePlannerCanonicalSets(rows) {
  const models = buildPlannerCanonicalSetModels(rows);
  const knownTimeSeconds = models.reduce((sum, row) => sum + (numberValue(row.timeSeconds) || 0), 0);
  const unknownTimeRowCount = models.filter((row) => (numberValue(row.timeSeconds) || 0) <= 0).length;
  const hasCompleteTime = models.length > 0 && unknownTimeRowCount === 0;
  const requireCompleteSessionTime = models.some((row) => Boolean(row?.source?.__plannerRequireCompleteTime));
  return {
    rows: models,
    totalVolume: models.reduce((sum, row) => sum + (numberValue(row.volume) || 0), 0),
    totalTimeSeconds: requireCompleteSessionTime && !hasCompleteTime ? 0 : knownTimeSeconds,
    knownTimeSeconds,
    completeTimeSeconds: hasCompleteTime ? knownTimeSeconds : 0,
    unknownTimeRowCount,
    hasCompleteTime,
  };
}
