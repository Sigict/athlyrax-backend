import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const routeMarker = '// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_V1';
const aliasMarker = '// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_SESSION_ALIAS_V1';
const verificationMarker = '// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_MATCH_VERIFICATION_V1';

if (!source.includes(routeMarker)) {
  throw new Error('Server-authoritative Schedule delete route must exist before match verification is applied.');
}

if (!source.includes(aliasMarker)) {
  const targetAnchor = `\t\tconst now = new Date().toISOString();\n\t\tconst targetIds = new Set(scheduleIds);\n\t\tconst textId = (value) => String(value || '').trim();\n\t\tconst scheduleRows = Array.isArray(currentDb.schedule) ? currentDb.schedule : [];\n\t\tconst legacyScheduleRows = Array.isArray(currentDb.trainingSchedules) ? currentDb.trainingSchedules : [];\n\t\tconst sessionRows = Array.isArray(currentDb.trainingSessions) ? currentDb.trainingSessions : [];\n\t\tconst setRows = Array.isArray(currentDb.trainingSessionSets) ? currentDb.trainingSessionSets : [];\n\t\tconst blockRows = Array.isArray(currentDb.trainingSetBlocks) ? currentDb.trainingSetBlocks : [];\n`;
  if (!source.includes(targetAnchor)) {
    throw new Error('Could not locate authoritative Schedule delete target-resolution anchor.');
  }

  const targetReplacement = `\t\tconst now = new Date().toISOString();\n\t\tconst textId = (value) => String(value || '').trim();\n\t\tconst scheduleRows = Array.isArray(currentDb.schedule) ? currentDb.schedule : [];\n\t\tconst legacyScheduleRows = Array.isArray(currentDb.trainingSchedules) ? currentDb.trainingSchedules : [];\n\t\tconst sessionRows = Array.isArray(currentDb.trainingSessions) ? currentDb.trainingSessions : [];\n\t\tconst setRows = Array.isArray(currentDb.trainingSessionSets) ? currentDb.trainingSessionSets : [];\n\t\tconst blockRows = Array.isArray(currentDb.trainingSetBlocks) ? currentDb.trainingSetBlocks : [];\n\t\t${aliasMarker}\n\t\tconst requestedDeleteIds = new Set(scheduleIds.map(textId).filter(Boolean));\n\t\tconst targetIds = new Set(requestedDeleteIds);\n\t\tfor (const sessionRow of sessionRows) {\n\t\t\tconst sessionId = textId(sessionRow?.id);\n\t\t\tif (!sessionId || !requestedDeleteIds.has(sessionId)) continue;\n\t\t\tconst linkedScheduleId = textId(sessionRow?.scheduleId || sessionRow?.trainingScheduleId);\n\t\t\tif (linkedScheduleId) targetIds.add(linkedScheduleId);\n\t\t}\n\t\tconst persistedScheduleIds = new Set([\n\t\t\t...scheduleRows.map((row) => textId(row?.id)),\n\t\t\t...legacyScheduleRows.map((row) => textId(row?.id)),\n\t\t].filter(Boolean));\n\t\tconst resolvedScheduleIds = Array.from(targetIds).filter((id) => persistedScheduleIds.has(id));\n\t\tif (resolvedScheduleIds.length < 1) {\n\t\t\tconst err = new Error('No persisted Schedule could be resolved from the selected Scheduled Session rows.');\n\t\t\terr.status = 409;\n\t\t\terr.details = { requestedScheduleIds: Array.from(requestedDeleteIds) };\n\t\t\tthrow err;\n\t\t}\n\t\ttargetIds.clear();\n\t\tfor (const id of resolvedScheduleIds) targetIds.add(id);\n`;

  source = source.replace(targetAnchor, targetReplacement);
  source = source.replace(
    `\t\t\t...scheduleIds.map((id) => ({ collection: 'schedule', id, deletedAt: now, deletedBy: 'server-authoritative-schedule-delete' })),`,
    `\t\t\t...Array.from(targetIds).map((id) => ({ collection: 'schedule', id, deletedAt: now, deletedBy: 'server-authoritative-schedule-delete' })),`,
  );
  source = source.replace(
    `\t\t\tdeletedScheduleIds: scheduleIds,`,
    `\t\t\trequestedScheduleIds: scheduleIds,\n\t\t\tdeletedScheduleIds: Array.from(targetIds),`,
  );
}

if (!source.includes(verificationMarker)) {
  const anchor = "\t\tconst persistedSets = Array.isArray(persisted?.trainingSessionSets) ? persisted.trainingSessionSets : [];\n";
  if (!source.includes(anchor)) {
    throw new Error('Could not locate persisted Schedule delete verification anchor.');
  }

  const injected = `${anchor}\t\t${verificationMarker}\n\t\tconst removedPersistedScheduleCount = scheduleRows.length - persistedSchedule.length;\n\t\tconst removedPersistedLegacyScheduleCount = legacyScheduleRows.length - persistedLegacySchedule.length;\n\t\tconst removedPersistedTrainingSessionCount = sessionRows.length - persistedSessions.length;\n\t\tconst removedPersistedTrainingSetCount = setRows.length - persistedSets.length;\n\t\tif (removedPersistedScheduleCount + removedPersistedLegacyScheduleCount + removedPersistedTrainingSessionCount <= 0) {\n\t\t\tconst err = new Error('No persisted Scheduled Session matched the authoritative deletion request. Refusing false success.');\n\t\t\terr.status = 409;\n\t\t\terr.details = {\n\t\t\t\trequestedScheduleIds: scheduleIds,\n\t\t\t\tserverDerivedScheduleOccurrenceSuppressions: serverDerivedSuppressions.length,\n\t\t\t};\n\t\t\tthrow err;\n\t\t}\n`;
  source = source.replace(anchor, injected);

  source = source.replace(
    'removedScheduleCount: scheduleRows.length - (Array.isArray(persisted?.schedule) ? persisted.schedule.length : 0),',
    'removedScheduleCount: removedPersistedScheduleCount,',
  );
  source = source.replace(
    'removedLegacyScheduleCount: legacyScheduleRows.length - (Array.isArray(persisted?.trainingSchedules) ? persisted.trainingSchedules.length : 0),',
    'removedLegacyScheduleCount: removedPersistedLegacyScheduleCount,',
  );
  source = source.replace(
    'removedTrainingSessionCount: linkedSessionIds.size,',
    'removedTrainingSessionCount: removedPersistedTrainingSessionCount,',
  );
  source = source.replace(
    'removedTrainingSetCount: linkedSetIds.size,',
    'removedTrainingSetCount: removedPersistedTrainingSetCount,',
  );
}

for (const required of [
  aliasMarker,
  verificationMarker,
  'requestedDeleteIds',
  'resolvedScheduleIds',
  'No persisted Schedule could be resolved from the selected Scheduled Session rows.',
  'No persisted Scheduled Session matched the authoritative deletion request. Refusing false success.',
  'removedPersistedScheduleCount',
  'deletedScheduleIds: Array.from(targetIds)',
  'serverDerivedScheduleOccurrenceSuppressions: serverDerivedSuppressions.length',
]) {
  if (!source.includes(required)) throw new Error(`Authoritative Schedule delete verification missing invariant: ${required}`);
}

if (source.includes('incomingScheduleOccurrenceSuppressions: incomingSuppressions.length')) {
  throw new Error('Delete verification must not depend on client-supplied suppression data.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_MATCH_VERIFICATION_OK');
