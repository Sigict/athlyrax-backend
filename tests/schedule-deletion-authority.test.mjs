import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('index.js', 'utf8').replace(/\r\n/g, '\n');
const buildSource = fs.readFileSync('scripts/build-production-backend.mjs', 'utf8').replace(/\r\n/g, '\n');

function genericPutSource() {
  const start = source.indexOf("app.put('/db'");
  assert.ok(start >= 0, 'generic PUT /db route missing');
  const candidates = [
    source.indexOf("app.get('/", start + 1),
    source.indexOf("app.post('/", start + 1),
    source.indexOf("app.put('/", start + 1),
  ].filter((index) => index > start);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test('generic PUT cannot create Schedule tombstones', () => {
  const route = genericPutSource();
  assert.ok(route.includes('// ATHLYRAX_SCHEDULE_DELETION_AUTHORITY_V1'));
  assert.ok(route.includes('const incomingNonScheduleTombstones ='));
  assert.ok(route.includes(".filter((row) => String(row?.collection || '').trim() !== 'schedule')"));
  assert.ok(route.includes('mergeTombstoneLists('));
  assert.ok(route.includes('incomingNonScheduleTombstones'));
});

test('generic PUT preserves server-owned Schedule suppressions but cannot create client suppressions', () => {
  const route = genericPutSource();
  assert.ok(route.includes('const mergedScheduleOccurrenceSuppressions = mergeScheduleOccurrenceSuppressionLists('));
  assert.equal(route.includes('body?.__meta?.scheduleOccurrenceSuppressions'), false);
  assert.ok(route.includes('scheduleOccurrenceSuppressions: mergedScheduleOccurrenceSuppressions'));
});

test('production build always applies Schedule deletion authority before installing the delete route', () => {
  const authority = buildSource.indexOf("'scripts/patch-schedule-deletion-authority.mjs'");
  const deleteRoute = buildSource.indexOf("run('server-authoritative schedule deletion guard'");
  assert.ok(authority >= 0);
  assert.ok(deleteRoute > authority);
  assert.ok(buildSource.includes("'scripts/patch-schedule-deletion-authority.mjs',"));
});
