import fs from 'node:fs';

const path = 'index.js';
let source = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const fingerprintPattern = /function getScheduleOccurrenceFingerprint\(row\) \{[\s\S]*?\n\}\n\nfunction getScheduleOccurrenceSuppressionKey/;
const fingerprintReplacement = `function getScheduleOccurrenceFingerprint(row) {
\tif (!row || typeof row !== 'object' || Array.isArray(row) || isExplicitManualScheduleRow(row)) return null;
\tconst scheduleDate = getScheduleOccurrenceDate(row);
\tif (!scheduleDate) return null;
\tconst timetableId = getScheduleOccurrenceTimetableId(row);
\tconst startTime = scheduleOccurrenceText(row?.startTime);
\tconst endTime = scheduleOccurrenceText(row?.endTime);
\tconst venueId = scheduleOccurrenceText(row?.venueId || row?.venue);
\tconst squadIds = getScheduleOccurrenceSquadIds(row);
\tconst sessionTypeId = scheduleOccurrenceText(row?.sessionTypeId || row?.trainingTypeId || row?.sessionType || row?.type);
\tif (!timetableId && !startTime && !endTime && !venueId && squadIds.length === 0 && !sessionTypeId) return null;
\treturn {
\t\tidentityType: 'legacy-fingerprint',
\t\tscheduleDate,
\t\t...(timetableId ? { timetableId } : {}),
\t\t...(startTime ? { startTime } : {}),
\t\t...(endTime ? { endTime } : {}),
\t\t...(venueId ? { venueId } : {}),
\t\tsquadIds,
\t\t...(sessionTypeId ? { sessionTypeId } : {}),
\t};
}

function getScheduleOccurrenceSuppressionKey`;
if (!fingerprintPattern.test(source)) throw new Error('Schedule fingerprint helper block not found');
source = source.replace(fingerprintPattern, fingerprintReplacement);

const keyPattern = /function getScheduleOccurrenceSuppressionKey\(row\) \{[\s\S]*?\n\}\n\nfunction normalizeScheduleOccurrenceSuppressionEntry/;
const keyReplacement = `function getScheduleOccurrenceSuppressionKey(row) {
\tconst identity = getScheduleOccurrenceIdentityParts(row);
\tif (identity && scheduleOccurrenceText(row?.identityType) !== 'legacy-fingerprint') {
\t\treturn JSON.stringify([identity.sourceSlotId, identity.scheduleDate, identity.timetableId]);
\t}
\tconst fingerprint = getScheduleOccurrenceFingerprint({ ...row, manualScheduleEntry: false, generatedByPlanner: true });
\tif (!fingerprint) return '';
\treturn JSON.stringify([
\t\t'legacy-fingerprint',
\t\tfingerprint.timetableId || '*',
\t\tfingerprint.scheduleDate,
\t\tfingerprint.startTime || '*',
\t\tfingerprint.endTime || '*',
\t\tfingerprint.venueId || '*',
\t\tfingerprint.squadIds,
\t\tfingerprint.sessionTypeId || '*',
\t]);
}

function normalizeScheduleOccurrenceSuppressionEntry`;
if (!keyPattern.test(source)) throw new Error('Schedule suppression key helper block not found');
source = source.replace(keyPattern, keyReplacement);

const exactMatcher = `\tif (candidate.timetableId !== suppression.timetableId) return false;\n\tif (candidate.startTime !== suppression.startTime) return false;\n\tif (candidate.endTime !== suppression.endTime) return false;\n\tif (suppression.venueId && candidate.venueId !== suppression.venueId) return false;\n\tif (scheduleOccurrenceArray(suppression.squadIds).length > 0\n\t\t&& !scheduleOccurrenceSameIds(candidate.squadIds, suppression.squadIds)) return false;\n\treturn true;`;
const wildcardMatcher = `\tif (suppression.timetableId && candidate.timetableId !== suppression.timetableId) return false;\n\tif (suppression.startTime && candidate.startTime !== suppression.startTime) return false;\n\tif (suppression.endTime && candidate.endTime !== suppression.endTime) return false;\n\tif (suppression.venueId && candidate.venueId !== suppression.venueId) return false;\n\tif (scheduleOccurrenceArray(suppression.squadIds).length > 0\n\t\t&& !scheduleOccurrenceSameIds(candidate.squadIds, suppression.squadIds)) return false;\n\tif (suppression.sessionTypeId && candidate.sessionTypeId !== suppression.sessionTypeId) return false;\n\treturn true;`;
if (!source.includes(exactMatcher)) throw new Error('Exact legacy fingerprint matcher block not found');
source = source.replace(exactMatcher, wildcardMatcher);

for (const token of [
  "fingerprint.timetableId || '*'",
  'suppression.timetableId && candidate.timetableId',
  'suppression.startTime && candidate.startTime',
  'suppression.sessionTypeId && candidate.sessionTypeId',
]) {
  if (!source.includes(token)) throw new Error(`Patched Schedule suppression token missing: ${token}`);
}

fs.writeFileSync(path, source, 'utf8');
console.log('BACKEND_SCHEDULE_FAIL_CLOSED_PATCH_OK');
