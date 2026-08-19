import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const routeMarker = '// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_V1';
const verificationMarker = '// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_MATCH_VERIFICATION_V1';

if (!source.includes(routeMarker)) {
  throw new Error('Server-authoritative Schedule delete route must exist before match verification is applied.');
}

if (!source.includes(verificationMarker)) {
  const anchor = "\t\tconst persistedSets = Array.isArray(persisted?.trainingSessionSets) ? persisted.trainingSessionSets : [];\n";
  if (!source.includes(anchor)) {
    throw new Error('Could not locate persisted Schedule delete verification anchor.');
  }

  const injected = `${anchor}\t\t${verificationMarker}\n\t\tconst removedPersistedScheduleCount = scheduleRows.length - persistedSchedule.length;\n\t\tconst removedPersistedLegacyScheduleCount = legacyScheduleRows.length - persistedLegacySchedule.length;\n\t\tconst removedPersistedTrainingSessionCount = sessionRows.length - persistedSessions.length;\n\t\tconst removedPersistedTrainingSetCount = setRows.length - persistedSets.length;\n\t\tif (removedPersistedScheduleCount + removedPersistedLegacyScheduleCount + removedPersistedTrainingSessionCount <= 0) {\n\t\t\tconst err = new Error('No persisted Scheduled Session matched the authoritative deletion request. Refusing false success.');\n\t\t\terr.status = 409;\n\t\t\terr.details = {\n\t\t\t\trequestedScheduleIds: scheduleIds,\n\t\t\t\tincomingScheduleOccurrenceSuppressions: incomingSuppressions.length,\n\t\t\t};\n\t\t\tthrow err;\n\t\t}\n`;
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
  verificationMarker,
  'No persisted Scheduled Session matched the authoritative deletion request. Refusing false success.',
  'removedPersistedScheduleCount',
]) {
  if (!source.includes(required)) throw new Error(`Authoritative Schedule delete match verification missing invariant: ${required}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_MATCH_VERIFICATION_OK');
