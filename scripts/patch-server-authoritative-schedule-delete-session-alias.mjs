import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_SESSION_ALIAS_V1';
const routeMarker = '// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_V1';

if (!source.includes(routeMarker)) {
  throw new Error('Server-authoritative Schedule delete route must exist before session alias resolution is applied.');
}

if (!source.includes(marker)) {
  const anchor = `\t\tconst now = new Date().toISOString();\n\t\tconst targetIds = new Set(scheduleIds);\n\t\tconst textId = (value) => String(value || '').trim();\n\t\tconst scheduleRows = Array.isArray(currentDb.schedule) ? currentDb.schedule : [];\n\t\tconst legacyScheduleRows = Array.isArray(currentDb.trainingSchedules) ? currentDb.trainingSchedules : [];\n\t\tconst sessionRows = Array.isArray(currentDb.trainingSessions) ? currentDb.trainingSessions : [];\n\t\tconst setRows = Array.isArray(currentDb.trainingSessionSets) ? currentDb.trainingSessionSets : [];\n\t\tconst blockRows = Array.isArray(currentDb.trainingSetBlocks) ? currentDb.trainingSetBlocks : [];\n`;

  if (!source.includes(anchor)) {
    throw new Error('Could not locate authoritative Schedule delete target-resolution anchor.');
  }

  const replacement = `\t\tconst now = new Date().toISOString();\n\t\tconst textId = (value) => String(value || '').trim();\n\t\tconst scheduleRows = Array.isArray(currentDb.schedule) ? currentDb.schedule : [];\n\t\tconst legacyScheduleRows = Array.isArray(currentDb.trainingSchedules) ? currentDb.trainingSchedules : [];\n\t\tconst sessionRows = Array.isArray(currentDb.trainingSessions) ? currentDb.trainingSessions : [];\n\t\tconst setRows = Array.isArray(currentDb.trainingSessionSets) ? currentDb.trainingSessionSets : [];\n\t\tconst blockRows = Array.isArray(currentDb.trainingSetBlocks) ? currentDb.trainingSetBlocks : [];\n\t\t${marker}\n\t\tconst requestedDeleteIds = new Set(scheduleIds.map(textId).filter(Boolean));\n\t\tconst targetIds = new Set(requestedDeleteIds);\n\t\tfor (const sessionRow of sessionRows) {\n\t\t\tconst sessionId = textId(sessionRow?.id);\n\t\t\tif (!sessionId || !requestedDeleteIds.has(sessionId)) continue;\n\t\t\tconst linkedScheduleId = textId(sessionRow?.scheduleId || sessionRow?.trainingScheduleId);\n\t\t\tif (linkedScheduleId) targetIds.add(linkedScheduleId);\n\t\t}\n\t\tconst persistedScheduleIds = new Set([\n\t\t\t...scheduleRows.map((row) => textId(row?.id)),\n\t\t\t...legacyScheduleRows.map((row) => textId(row?.id)),\n\t\t].filter(Boolean));\n\t\tconst resolvedScheduleIds = Array.from(targetIds).filter((id) => persistedScheduleIds.has(id));\n\t\tif (resolvedScheduleIds.length < 1) {\n\t\t\tconst err = new Error('No persisted Schedule could be resolved from the selected Scheduled Session rows.');\n\t\t\terr.status = 409;\n\t\t\terr.details = { requestedScheduleIds: Array.from(requestedDeleteIds) };\n\t\t\tthrow err;\n\t\t}\n\t\ttargetIds.clear();\n\t\tfor (const id of resolvedScheduleIds) targetIds.add(id);\n`;

  source = source.replace(anchor, replacement);
  source = source.replace(
    `\t\t\t...scheduleIds.map((id) => ({ collection: 'schedule', id, deletedAt: now, deletedBy: 'server-authoritative-schedule-delete' })),`,
    `\t\t\t...Array.from(targetIds).map((id) => ({ collection: 'schedule', id, deletedAt: now, deletedBy: 'server-authoritative-schedule-delete' })),`,
  );
  source = source.replace(
    `\t\t\tdeletedScheduleIds: scheduleIds,`,
    `\t\t\trequestedScheduleIds: scheduleIds,\n\t\t\tdeletedScheduleIds: Array.from(targetIds),`,
  );
}

for (const required of [
  marker,
  'requestedDeleteIds',
  'resolvedScheduleIds',
  'No persisted Schedule could be resolved from the selected Scheduled Session rows.',
  'deletedScheduleIds: Array.from(targetIds)',
]) {
  if (!source.includes(required)) throw new Error(`Schedule delete session-alias resolution missing invariant: ${required}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_SESSION_ALIAS_OK');
