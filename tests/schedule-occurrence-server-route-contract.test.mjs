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
  assert.ok(source.includes('if (rowId) blockedScheduleIds.add(rowId);'), 'a stale legacy mirror id must also cascade-delete linked Planner rows');
  assert.ok(!source.includes("if (collection === 'schedule' && rowId) blockedScheduleIds.add(rowId);"));
});

test('installed GET /db validates stored data then filters already-persisted suppressed occurrences before returning them', () => {
  assert.ok(source.includes('// ATHLYRAX_RUNTIME_DB_READ_FAIL_CLOSED'), 'production GET must retain the fail-closed database-read guard');
  assert.ok(source.includes("const persistedSuppressions = Array.isArray(parsedDatabase?.__meta?.scheduleOccurrenceSuppressions)"));
  assert.ok(source.includes('const readFiltered = applyScheduleOccurrenceSuppressionsToDbShape(parsedDatabase, persistedSuppressions);'));
  assert.ok(source.includes('let responsePayload = JSON.stringify(readFiltered.dbShape);'));
  assert.ok(
    source.includes("const parsed = typeof readFiltered !== 'undefined' ? readFiltered.dbShape : parsedDatabase;"),
    'swimmer-scoped GET must consume the validated, suppression-filtered database shape',
  );
});

test('PUT /db reports both row-id and semantic resurrection blocks', () => {
  assert.ok(source.includes('...(Array.isArray(filtered.blockedResurrections) ? filtered.blockedResurrections : [])'));
  assert.ok(source.includes('...(Array.isArray(occurrenceFiltered.blockedResurrections) ? occurrenceFiltered.blockedResurrections : [])'));
});
