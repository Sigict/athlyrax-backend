import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('index.js'), 'utf8');
const startMarker = '// Tombstone-based deletion protection.';
const endMarker = 'function applyOwnershipMetadataToDbShape(dbShape, existingDbShape, auth) {';
const startIdx = source.indexOf(startMarker);
const endIdx = source.indexOf(endMarker);
if (startIdx < 0 || endIdx <= startIdx) throw new Error('Schedule deletion helper block not found.');
const helperBlock = source.slice(startIdx, endIdx);
const toRowIdMatch = source.match(/function toRowId\(value\) \{[\s\S]*?\n\}/);
if (!toRowIdMatch) throw new Error('toRowId helper not found.');
const { applyScheduleOccurrenceSuppressionsToDbShape } = new Function(`
  ${toRowIdMatch[0]}
  ${helperBlock}
  return { applyScheduleOccurrenceSuppressionsToDbShape };
`)();

const suppression = {
  sourceSlotId: 'slot-delete',
  scheduleDate: '2026-08-24',
  timetableId: 'tt-main',
  deletedAt: '2026-08-21T12:00:00.000Z',
};

function schedule(id, sourceSlotId, date) {
  return { id, generatedByPlanner: true, generatedSourceSlotId: sourceSlotId, scheduleDate: date, timetableId: 'tt-main' };
}

test('semantic suppression reassigns a shared block from deleted owner to its one surviving session owner', () => {
  const deletedSchedule = schedule('schedule-delete', 'slot-delete', '2026-08-24');
  const keepSchedule = schedule('schedule-keep', 'slot-keep', '2026-08-25');
  const db = {
    schedule: [deletedSchedule, keepSchedule],
    trainingSessions: [
      { id: 'session-delete', scheduleId: deletedSchedule.id },
      { id: 'session-keep', scheduleId: keepSchedule.id },
    ],
    trainingSessionSets: [
      { id: 'set-delete', sessionId: 'session-delete' },
      { id: 'set-keep', sessionId: 'session-keep' },
    ],
    trainingSetBlocks: [{
      id: 'shared-block',
      sessionId: 'session-delete',
      trainingSessionId: 'session-delete',
      setIds: ['set-delete', 'set-keep'],
    }],
  };
  const result = applyScheduleOccurrenceSuppressionsToDbShape(db, [suppression]);
  assert.deepEqual(result.dbShape.schedule.map((row) => row.id), ['schedule-keep']);
  assert.deepEqual(result.dbShape.trainingSessions.map((row) => row.id), ['session-keep']);
  assert.deepEqual(result.dbShape.trainingSessionSets.map((row) => row.id), ['set-keep']);
  assert.equal(result.dbShape.trainingSetBlocks.length, 1);
  assert.deepEqual(result.dbShape.trainingSetBlocks[0].setIds, ['set-keep']);
  assert.equal(result.dbShape.trainingSetBlocks[0].sessionId, 'session-keep');
  assert.equal(result.dbShape.trainingSetBlocks[0].trainingSessionId, 'session-keep');
});

test('semantic suppression clears a deleted shared-block owner when surviving sets have multiple owners', () => {
  const deletedSchedule = schedule('schedule-delete', 'slot-delete', '2026-08-24');
  const db = {
    schedule: [deletedSchedule],
    trainingSessions: [
      { id: 'session-delete', scheduleId: deletedSchedule.id },
      { id: 'session-a', scheduleId: 'other-a' },
      { id: 'session-b', scheduleId: 'other-b' },
    ],
    trainingSessionSets: [
      { id: 'set-delete', sessionId: 'session-delete' },
      { id: 'set-a', sessionId: 'session-a' },
      { id: 'set-b', sessionId: 'session-b' },
    ],
    trainingSetBlocks: [{
      id: 'ambiguous-block',
      sessionId: 'session-delete',
      trainingSessionId: 'session-delete',
      setIds: ['set-delete', 'set-a', 'set-b'],
    }],
  };
  const result = applyScheduleOccurrenceSuppressionsToDbShape(db, [suppression]);
  assert.equal(result.dbShape.trainingSetBlocks.length, 1);
  assert.deepEqual(result.dbShape.trainingSetBlocks[0].setIds, ['set-a', 'set-b']);
  assert.equal(result.dbShape.trainingSetBlocks[0].sessionId, '');
  assert.equal(result.dbShape.trainingSetBlocks[0].trainingSessionId, '');
});

test('production source contains the semantic suppression shared-block owner invariant', () => {
  assert.match(source, /ATHLYRAX_SCHEDULE_SUPPRESSION_BLOCK_OWNER_INTEGRITY_V1/);
  assert.match(source, /next\.trainingSetBlocks = sourceBlocks\.flatMap\(\(blockRow\) => \{/);
  assert.match(source, /ownerDeleted && remainingOwnerIds\.length === 1/);
});
