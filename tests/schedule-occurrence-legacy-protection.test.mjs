import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_JS_PATH = path.join(__dirname, '..', 'index.js');

function loadScheduleSuppressionHelpers() {
  const source = fs.readFileSync(INDEX_JS_PATH, 'utf8');
  const startMarker = '// Tombstone-based deletion protection.';
  const endMarker = 'function applyOwnershipMetadataToDbShape(dbShape, existingDbShape, auth) {';
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);
  if (startIdx < 0 || endIdx <= startIdx) throw new Error('Schedule deletion helper block not found.');
  const block = source.slice(startIdx, endIdx);
  const toRowIdMatch = source.match(/function toRowId\(value\) \{[\s\S]*?\n\}/);
  if (!toRowIdMatch) throw new Error('toRowId helper not found.');
  return new Function(`
    ${toRowIdMatch[0]}
    ${block}
    return {
      normalizeScheduleOccurrenceSuppressionEntry,
      mergeScheduleOccurrenceSuppressionLists,
      applyScheduleOccurrenceSuppressionsToDbShape,
    };
  `)();
}

const helpers = loadScheduleSuppressionHelpers();

const legacySuppression = {
  identityType: 'legacy-fingerprint',
  scheduleDate: '2026-08-24',
  timetableId: 'tt-main',
  startTime: '06:00',
  endTime: '07:00',
  venueId: 'pool-a',
  squadIds: ['squad-a'],
  deletedAt: '2026-08-19T01:00:00.000Z',
  deletedBy: 'scheduled-sessions-bulk-delete',
};

test('server retains a legacy fingerprint suppression without requiring source-slot lineage', () => {
  const merged = helpers.mergeScheduleOccurrenceSuppressionLists([], [legacySuppression]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].identityType, 'legacy-fingerprint');
  assert.equal(merged[0].scheduleDate, legacySuppression.scheduleDate);
  assert.equal(merged[0].timetableId, legacySuppression.timetableId);
  assert.equal(merged[0].startTime, legacySuppression.startTime);
  assert.deepEqual(merged[0].squadIds, ['squad-a']);
});

test('legacy fingerprint blocks the same generated occurrence under both a fresh Schedule id and a fresh source-slot id', () => {
  const regenerated = {
    id: 'fresh-schedule-id',
    generatedByPlanner: true,
    generatedSourceSlotId: 'fresh-source-slot-id',
    scheduleDate: legacySuppression.scheduleDate,
    timetableId: legacySuppression.timetableId,
    startTime: legacySuppression.startTime,
    endTime: legacySuppression.endTime,
    venueId: legacySuppression.venueId,
    squadIds: ['squad-a'],
  };
  const dbShape = {
    schedule: [regenerated],
    trainingSchedules: [{ ...regenerated, id: 'fresh-legacy-mirror-id' }],
    trainingSessions: [{ id: 'session', trainingScheduleId: regenerated.id }],
    trainingSessionSets: [{ id: 'set', trainingSessionId: 'session' }],
    trainingSetBlocks: [{ id: 'block', trainingSessionId: 'session', setId: 'set' }],
    attendance: [{ id: 'attendance', trainingScheduleId: regenerated.id }],
  };

  const result = helpers.applyScheduleOccurrenceSuppressionsToDbShape(dbShape, [legacySuppression]);
  assert.deepEqual(result.dbShape.schedule, []);
  assert.deepEqual(result.dbShape.trainingSchedules, []);
  assert.deepEqual(result.dbShape.trainingSessions, []);
  assert.deepEqual(result.dbShape.trainingSessionSets, []);
  assert.deepEqual(result.dbShape.trainingSetBlocks, [], 'singular setId block must not survive linked-session deletion');
  assert.deepEqual(result.dbShape.attendance, []);
  assert.equal(result.blockedResurrections.some((row) => row.id === 'fresh-schedule-id'), true);
});

test('stale generatedByPlanner=false does not turn a regenerated occurrence into a manual exception', () => {
  const regenerated = {
    id: 'stale-generated-flag',
    generatedByPlanner: false,
    generatedSourceSlotId: 'fresh-source-slot-id',
    scheduleDate: legacySuppression.scheduleDate,
    timetableId: legacySuppression.timetableId,
    startTime: legacySuppression.startTime,
    endTime: legacySuppression.endTime,
    venueId: legacySuppression.venueId,
    squadIds: ['squad-a'],
  };
  const result = helpers.applyScheduleOccurrenceSuppressionsToDbShape({ schedule: [regenerated] }, [legacySuppression]);
  assert.deepEqual(result.dbShape.schedule, [], 'only manualScheduleEntry=true may bypass generated occurrence suppression');

  const explicitManual = { ...regenerated, id: 'explicit-manual', manualScheduleEntry: true };
  const manualResult = helpers.applyScheduleOccurrenceSuppressionsToDbShape({ schedule: [explicitManual] }, [legacySuppression]);
  assert.deepEqual(manualResult.dbShape.schedule.map((row) => row.id), ['explicit-manual']);
});

test('legacy fingerprint without timetable id blocks a regenerated occurrence that later gains timetable/source ids', () => {
  const incompleteSuppression = {
    identityType: 'legacy-fingerprint',
    scheduleDate: '2026-08-19T00:00:00.000Z',
    startTime: '17:00',
    endTime: '19:00',
    venueId: 'pool-a',
    squadIds: ['perf-a'],
    deletedAt: '2026-08-19T10:30:00.000Z',
  };
  const merged = helpers.mergeScheduleOccurrenceSuppressionLists([], [incompleteSuppression]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].timetableId, undefined);
  assert.equal(merged[0].scheduleDate, '2026-08-19');

  const regenerated = {
    id: 'fresh-regenerated',
    generatedByPlanner: true,
    generatedSourceSlotId: 'fresh-slot',
    scheduleDate: '2026-08-19',
    timetableId: 'main',
    startTime: '17:00',
    endTime: '19:00',
    venueId: 'pool-a',
    squadIds: ['perf-a'],
  };
  const result = helpers.applyScheduleOccurrenceSuppressionsToDbShape({ schedule: [regenerated] }, merged);
  assert.deepEqual(result.dbShape.schedule, []);
  assert.equal(result.blockedResurrections.length, 1);
});

test('partial legacy fingerprint needs time plus context and refuses an over-broad date/squad-only identity', () => {
  const safePartial = {
    identityType: 'legacy-fingerprint',
    scheduleDate: '2026-08-19',
    startTime: '17:00',
    venueId: 'pool-a',
    squadIds: ['perf-a'],
    deletedAt: '2026-08-19T10:30:00.000Z',
  };
  const normalized = helpers.normalizeScheduleOccurrenceSuppressionEntry(safePartial);
  assert.ok(normalized);
  assert.equal(normalized.identityType, 'legacy-fingerprint');
  assert.equal(normalized.scheduleDate, '2026-08-19');
  assert.equal(normalized.startTime, '17:00');
  assert.equal(normalized.venueId, 'pool-a');
  assert.deepEqual(normalized.squadIds, ['perf-a']);

  const tooBroad = helpers.normalizeScheduleOccurrenceSuppressionEntry({
    identityType: 'legacy-fingerprint',
    scheduleDate: '2026-08-19',
    squadIds: ['perf-a'],
    deletedAt: '2026-08-19T10:30:00.000Z',
  });
  assert.equal(tooBroad, null, 'date/squad alone must fail closed instead of blocking unrelated same-day sessions');
});

test('legacy fingerprint still allows the next recurrence and an explicit manual same-day replacement', () => {
  const nextWeek = {
    id: 'next-week',
    generatedByPlanner: true,
    generatedSourceSlotId: 'any-slot',
    scheduleDate: '2026-08-31',
    timetableId: legacySuppression.timetableId,
    startTime: legacySuppression.startTime,
    endTime: legacySuppression.endTime,
    venueId: legacySuppression.venueId,
    squadIds: ['squad-a'],
  };
  const manual = {
    id: 'manual-same-day',
    manualScheduleEntry: true,
    generatedByPlanner: false,
    scheduleDate: legacySuppression.scheduleDate,
    timetableId: legacySuppression.timetableId,
    startTime: legacySuppression.startTime,
    endTime: legacySuppression.endTime,
    venueId: legacySuppression.venueId,
    squadIds: ['squad-a'],
  };
  const result = helpers.applyScheduleOccurrenceSuppressionsToDbShape({ schedule: [nextWeek, manual] }, [legacySuppression]);
  assert.deepEqual(result.dbShape.schedule.map((row) => row.id), ['next-week', 'manual-same-day']);
  assert.equal(result.blockedResurrections.length, 0);
});

test('existing source-slot suppression behavior remains backward compatible', () => {
  const sourceSuppression = {
    sourceSlotId: 'slot-1',
    scheduleDate: '2026-08-24',
    timetableId: 'tt-main',
    deletedAt: '2026-08-19T01:00:00.000Z',
  };
  const result = helpers.applyScheduleOccurrenceSuppressionsToDbShape({
    schedule: [{ id: 'fresh', generatedSourceSlotId: 'slot-1', scheduleDate: '2026-08-24', timetableId: 'tt-main' }],
  }, [sourceSuppression]);
  assert.deepEqual(result.dbShape.schedule, []);
});
