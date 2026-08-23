import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('index.js', 'utf8').replace(/\r\n/g, '\n');
const buildSource = fs.readFileSync('scripts/build-production-backend.mjs', 'utf8').replace(/\r\n/g, '\n');

test('production backend exposes one authenticated server-authoritative Scheduled Sessions delete route', () => {
  const routeToken = "app.post('/db/schedule-delete', requireAuth, requireWriteRole, requireBillingWriteAccess";
  assert.equal(source.split(routeToken).length - 1, 1);
  assert.ok(source.includes('// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_V1'));
  assert.ok(source.includes('// ATHLYRAX_SCHEDULE_DELETE_BLOCK_INTEGRITY_V1'));
  assert.ok(source.includes("if (scheduleIds.length > 20000)"));
});

test('authoritative delete resolves rendered training-session IDs to their persisted Schedule IDs before deletion', () => {
  const routeStart = source.indexOf("app.post('/db/schedule-delete'");
  const putStart = source.indexOf("app.put('/db'", routeStart);
  const route = source.slice(routeStart, putStart);
  assert.ok(route.includes('// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_SESSION_ALIAS_V1'));
  assert.ok(route.includes('const requestedDeleteIds = new Set(scheduleIds.map(textId).filter(Boolean));'));
  assert.ok(route.includes('requestedDeleteIds.has(sessionId)'));
  assert.ok(route.includes('const linkedScheduleId = textId(sessionRow?.scheduleId || sessionRow?.trainingScheduleId);'));
  assert.ok(route.includes('if (linkedScheduleId) targetIds.add(linkedScheduleId);'));
  assert.ok(route.includes('const resolvedScheduleIds = Array.from(targetIds).filter((id) => persistedScheduleIds.has(id));'));
  assert.ok(route.includes('No persisted Schedule could be resolved from the selected Scheduled Session rows.'));
  assert.ok(route.includes('deletedScheduleIds: Array.from(targetIds)'));
  assert.ok(route.includes('requestedScheduleIds: scheduleIds'));
});

test('authoritative delete removes selected Schedule rows while preserving unrelated data inside shared Training Set Blocks', () => {
  const routeStart = source.indexOf("app.post('/db/schedule-delete'");
  const putStart = source.indexOf("app.put('/db'", routeStart);
  assert.ok(routeStart >= 0 && putStart > routeStart);
  const route = source.slice(routeStart, putStart);
  assert.ok(route.includes('enqueueWrite(async () => {'));
  assert.ok(route.includes("schedule: scheduleRows.filter((row) => !targetIds.has(textId(row?.id)))"));
  assert.ok(route.includes("trainingSessions: sessionRows.filter((row) => !targetIds.has(textId(row?.scheduleId || row?.trainingScheduleId)))"));
  assert.ok(route.includes('trainingSessionSets: setRows.filter('));
  assert.ok(route.includes('const removedBlockIds = new Set();'));
  assert.ok(route.includes('const nextBlocks = blockRows.flatMap((row) => {'));
  assert.ok(route.includes('const remainingSetIds = originalSetIds.filter((id) => !linkedSetIds.has(id));'));
  assert.ok(route.includes('trainingSetBlocks: nextBlocks,'));
  assert.ok(route.includes("deletedBy: 'server-authoritative-schedule-delete'"));
  assert.ok(route.includes("...Array.from(removedBlockIds).map((id) => ({ collection: 'trainingSetBlocks'"));
  assert.equal(route.includes('trainingSetBlocks: blockRows.filter((row) => !linkedBlockIds.has(textId(row?.id)))'), false,
    'Backend must not delete an entire shared Training Set Block because one contained set was deleted.');
  assert.ok(route.includes('mergeTombstoneLists('));
  assert.ok(route.includes('mergeScheduleOccurrenceSuppressionLists('));
  assert.ok(route.includes('applyScheduleOccurrenceSuppressionsToDbShape(nextDb, mergedSuppressions)'));
});

test('authoritative delete rereads persisted tenant DB and verifies deleted set and owner references are absent from surviving blocks', () => {
  const routeStart = source.indexOf("app.post('/db/schedule-delete'");
  const putStart = source.indexOf("app.put('/db'", routeStart);
  const route = source.slice(routeStart, putStart);
  const writeIndex = route.indexOf('writeAtomicJsonFile(storagePaths.dbPath, nextDb);');
  const rereadIndex = route.indexOf('const persisted = readJsonFile(storagePaths.dbPath);');
  const setVerificationIndex = route.indexOf('staleBlockSetReferences');
  const ownerVerificationIndex = route.indexOf('staleBlockOwnerReferences');
  const verificationIndex = route.indexOf('Server-authoritative schedule deletion verification failed after persistence reread.');
  const successIndex = route.indexOf('verified: true');
  assert.ok(writeIndex >= 0);
  assert.ok(rereadIndex > writeIndex);
  assert.ok(setVerificationIndex > rereadIndex);
  assert.ok(ownerVerificationIndex > setVerificationIndex);
  assert.ok(verificationIndex > ownerVerificationIndex);
  assert.ok(successIndex > verificationIndex);
  assert.ok(route.includes('remainingBlockIds'));
  assert.ok(route.includes('staleBlockSetReferences'));
  assert.ok(route.includes('staleBlockOwnerReferences'));
  assert.ok(route.includes("linkedSessionIds.has(textId(row?.sessionId || row?.trainingSessionId))"));
  assert.ok(route.includes("res.setHeader('X-AthlyraX-DB-Revision', String(result.storageRevision));"));
});

test('authoritative delete cannot report verified success when zero persisted rows matched', () => {
  const routeStart = source.indexOf("app.post('/db/schedule-delete'");
  const putStart = source.indexOf("app.put('/db'", routeStart);
  const route = source.slice(routeStart, putStart);
  assert.ok(route.includes('// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_MATCH_VERIFICATION_V1'));
  assert.ok(route.includes('removedPersistedScheduleCount'));
  assert.ok(route.includes('removedPersistedTrainingSessionCount'));
  assert.ok(route.includes('No persisted Scheduled Session matched the authoritative deletion request. Refusing false success.'));
  const refusalIndex = route.indexOf('No persisted Scheduled Session matched the authoritative deletion request. Refusing false success.');
  const successIndex = route.indexOf('verified: true');
  assert.ok(refusalIndex > route.indexOf('const persisted = readJsonFile(storagePaths.dbPath);'));
  assert.ok(successIndex > refusalIndex);
});

test('production build permanently installs block-integrity hardening before authoritative match verification', () => {
  const capacityIndex = buildSource.indexOf("run('bulk-delete tombstone capacity guard'");
  const authoritativeIndex = buildSource.indexOf("run('server-authoritative schedule deletion guard'");
  const blockIntegrityIndex = buildSource.indexOf("run('Schedule delete block-integrity guard'");
  const verificationIndex = buildSource.indexOf("run('server-authoritative schedule deletion match verification'");
  const demoIndex = buildSource.indexOf("run('public demo read-only guard'");
  assert.ok(capacityIndex >= 0);
  assert.ok(authoritativeIndex > capacityIndex);
  assert.ok(blockIntegrityIndex > authoritativeIndex);
  assert.ok(verificationIndex > blockIntegrityIndex);
  assert.ok(demoIndex > verificationIndex);
  assert.ok(buildSource.includes("'scripts/patch-server-authoritative-schedule-delete.mjs',"));
  assert.ok(buildSource.includes("'scripts/patch-schedule-delete-block-integrity.mjs',"));
  assert.ok(buildSource.includes("'scripts/patch-server-authoritative-schedule-delete-verification.mjs',"));
});
