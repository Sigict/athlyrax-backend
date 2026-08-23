import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCanonicalScheduleDeleteTargets,
} from '../scripts/schedule-delete-occurrence-identity.mjs';

const baseOccurrence = {
  generatedByPlanner: true,
  scheduleDate: '2026-08-23',
  timetableId: 'tt-main',
  startTime: '17:00',
  endTime: '19:00',
  venueId: 'pool-a',
  squadIds: ['perf-a'],
  sessionTypeId: 'aerobic',
};

test('deleting one physical Schedule deletes every persisted duplicate of the same generated occurrence', () => {
  const scheduleRows = [
    { ...baseOccurrence, id: 'schedule-a', generatedSourceSlotId: 'slot-old' },
    { ...baseOccurrence, id: 'schedule-b', generatedSourceSlotId: 'slot-new' },
    { ...baseOccurrence, id: 'schedule-next-week', scheduleDate: '2026-08-30', generatedSourceSlotId: 'slot-next' },
  ];
  const result = resolveCanonicalScheduleDeleteTargets({
    requestedIds: ['schedule-a'],
    scheduleRows,
    legacyScheduleRows: [],
    sessionRows: [],
    deletedAt: '2026-08-23T12:00:00.000Z',
  });
  assert.deepEqual(new Set(result.targetScheduleIds), new Set(['schedule-a', 'schedule-b']));
  assert.equal(result.targetScheduleIds.includes('schedule-next-week'), false);
  assert.equal(result.suppressions.length >= 1, true);
  assert.deepEqual(result.unresolvedGeneratedScheduleIds, []);
});

test('rendered trainingSession id resolves to its Schedule and the whole duplicate occurrence cluster', () => {
  const scheduleRows = [
    { ...baseOccurrence, id: 'schedule-a', generatedSourceSlotId: 'slot-old' },
    { ...baseOccurrence, id: 'schedule-b', generatedSourceSlotId: 'slot-new' },
  ];
  const sessionRows = [
    { id: 'rendered-session-id', scheduleId: 'schedule-a', startTime: '17:00', endTime: '19:00' },
  ];
  const result = resolveCanonicalScheduleDeleteTargets({
    requestedIds: ['rendered-session-id'],
    scheduleRows,
    legacyScheduleRows: [],
    sessionRows,
    deletedAt: '2026-08-23T12:00:00.000Z',
  });
  assert.deepEqual(new Set(result.directlyResolvedScheduleIds), new Set(['schedule-a']));
  assert.deepEqual(new Set(result.targetScheduleIds), new Set(['schedule-a', 'schedule-b']));
});

test('generated deletion does not delete an explicit manual replacement at the same date and time', () => {
  const scheduleRows = [
    { ...baseOccurrence, id: 'generated', generatedSourceSlotId: 'slot-1' },
    { ...baseOccurrence, id: 'manual', manualScheduleEntry: true, generatedByPlanner: false },
  ];
  const result = resolveCanonicalScheduleDeleteTargets({
    requestedIds: ['generated'],
    scheduleRows,
    legacyScheduleRows: [],
    sessionRows: [],
  });
  assert.deepEqual(result.targetScheduleIds, ['generated']);
});

test('manual deletion does not suppress a generated occurrence', () => {
  const scheduleRows = [
    { ...baseOccurrence, id: 'generated', generatedSourceSlotId: 'slot-1' },
    { ...baseOccurrence, id: 'manual', manualScheduleEntry: true, generatedByPlanner: false },
  ];
  const result = resolveCanonicalScheduleDeleteTargets({
    requestedIds: ['manual'],
    scheduleRows,
    legacyScheduleRows: [],
    sessionRows: [],
  });
  assert.deepEqual(result.targetScheduleIds, ['manual']);
  assert.deepEqual(result.suppressions, []);
  assert.deepEqual(result.unresolvedGeneratedScheduleIds, []);
});

test('generated occurrence without enough durable identity is rejected instead of being allowed to regenerate', () => {
  const scheduleRows = [{ id: 'unsafe-generated', generatedByPlanner: true, scheduleDate: '2026-08-23' }];
  const result = resolveCanonicalScheduleDeleteTargets({
    requestedIds: ['unsafe-generated'],
    scheduleRows,
    legacyScheduleRows: [],
    sessionRows: [],
  });
  assert.deepEqual(result.targetScheduleIds, ['unsafe-generated']);
  assert.deepEqual(result.suppressions, []);
  assert.deepEqual(result.unresolvedGeneratedScheduleIds, ['unsafe-generated']);
});

test('same-day different-time occurrence is not pulled into the delete cluster', () => {
  const scheduleRows = [
    { ...baseOccurrence, id: 'target', generatedSourceSlotId: 'slot-target' },
    { ...baseOccurrence, id: 'other', generatedSourceSlotId: 'slot-other', startTime: '19:00', endTime: '21:00' },
  ];
  const result = resolveCanonicalScheduleDeleteTargets({
    requestedIds: ['target'],
    scheduleRows,
    legacyScheduleRows: [],
    sessionRows: [],
  });
  assert.deepEqual(result.targetScheduleIds, ['target']);
});
