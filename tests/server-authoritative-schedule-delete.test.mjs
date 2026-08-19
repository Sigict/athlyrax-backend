import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('index.js', 'utf8').replace(/\r\n/g, '\n');
const buildSource = fs.readFileSync('scripts/build-production-backend.mjs', 'utf8').replace(/\r\n/g, '\n');

test('production backend exposes one authenticated server-authoritative Scheduled Sessions delete route', () => {
  const routeToken = "app.post('/db/schedule-delete', requireAuth, requireWriteRole, requireBillingWriteAccess";
  assert.equal(source.split(routeToken).length - 1, 1);
  assert.ok(source.includes('// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_V1'));
  assert.ok(source.includes("if (scheduleIds.length > 20000)"));
});

test('authoritative delete removes Schedule and linked Planner rows inside the backend write queue', () => {
  const routeStart = source.indexOf("app.post('/db/schedule-delete'");
  const putStart = source.indexOf("app.put('/db'", routeStart);
  assert.ok(routeStart >= 0 && putStart > routeStart);
  const route = source.slice(routeStart, putStart);
  assert.ok(route.includes('enqueueWrite(async () => {'));
  assert.ok(route.includes("schedule: scheduleRows.filter((row) => !targetIds.has(textId(row?.id)))"));
  assert.ok(route.includes("trainingSessions: sessionRows.filter((row) => !targetIds.has(textId(row?.scheduleId || row?.trainingScheduleId)))"));
  assert.ok(route.includes('trainingSessionSets: setRows.filter('));
  assert.ok(route.includes('trainingSetBlocks: blockRows.filter('));
  assert.ok(route.includes("deletedBy: 'server-authoritative-schedule-delete'"));
  assert.ok(route.includes('mergeTombstoneLists('));
  assert.ok(route.includes('mergeScheduleOccurrenceSuppressionLists('));
  assert.ok(route.includes('applyScheduleOccurrenceSuppressionsToDbShape(nextDb, mergedSuppressions)'));
});

test('authoritative delete rereads persisted tenant DB and refuses success if any target survived', () => {
  const routeStart = source.indexOf("app.post('/db/schedule-delete'");
  const putStart = source.indexOf("app.put('/db'", routeStart);
  const route = source.slice(routeStart, putStart);
  const writeIndex = route.indexOf('writeAtomicJsonFile(storagePaths.dbPath, nextDb);');
  const rereadIndex = route.indexOf('const persisted = readJsonFile(storagePaths.dbPath);');
  const verificationIndex = route.indexOf('Server-authoritative schedule deletion verification failed after persistence reread.');
  const successIndex = route.indexOf('verified: true');
  assert.ok(writeIndex >= 0);
  assert.ok(rereadIndex > writeIndex);
  assert.ok(verificationIndex > rereadIndex);
  assert.ok(successIndex > verificationIndex);
  assert.ok(route.includes("res.setHeader('X-AthlyraX-DB-Revision', String(result.storageRevision));"));
});

test('production build permanently installs the authoritative deletion route after canonical transforms', () => {
  const capacityIndex = buildSource.indexOf("run('bulk-delete tombstone capacity guard'");
  const authoritativeIndex = buildSource.indexOf("run('server-authoritative schedule deletion guard'");
  const demoIndex = buildSource.indexOf("run('public demo read-only guard'");
  assert.ok(capacityIndex >= 0);
  assert.ok(authoritativeIndex > capacityIndex);
  assert.ok(demoIndex > authoritativeIndex);
  assert.ok(buildSource.includes("'scripts/patch-server-authoritative-schedule-delete.mjs',"));
});
