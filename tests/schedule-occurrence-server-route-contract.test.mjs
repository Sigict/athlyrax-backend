import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('index.js', 'utf8').replace(/\r\n/g, '\n');

test('PUT /db unions and enforces semantic Schedule occurrence suppressions before persistence', () => {
  assert.ok(source.includes('const mergedScheduleOccurrenceSuppressions = mergeScheduleOccurrenceSuppressionLists('));
  assert.ok(source.includes('Array.isArray(currentDb?.__meta?.scheduleOccurrenceSuppressions) ? currentDb.__meta.scheduleOccurrenceSuppressions : []'));
  assert.ok(source.includes('Array.isArray(body?.__meta?.scheduleOccurrenceSuppressions) ? body.__meta.scheduleOccurrenceSuppressions : []'));
  assert.ok(source.includes('const occurrenceFiltered = applyScheduleOccurrenceSuppressionsToDbShape('));
  assert.ok(source.includes('...occurrenceFiltered.dbShape,'));
  assert.ok(source.includes('scheduleOccurrenceSuppressions: mergedScheduleOccurrenceSuppressions,'));
  assert.ok(source.indexOf('const occurrenceFiltered = applyScheduleOccurrenceSuppressionsToDbShape(') < source.indexOf('writeAtomicJsonFile(storagePaths.dbPath, ownershipStampedBody);'));
});

test('server semantic guard covers canonical Schedule and stale trainingSchedules mirror', () => {
  assert.ok(source.includes("for (const collection of ['schedule', 'trainingSchedules'])"));
});
