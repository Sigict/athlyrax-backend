import fs from 'node:fs';

const path = 'index.js';
const raw = fs.readFileSync(path, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let source = raw.replace(/\r\n/g, '\n');

const dateOld = `function getScheduleOccurrenceDate(row) {\n\treturn scheduleOccurrenceText(row?.scheduleDate || row?.rawDate || row?.date || row?.plannedDate);\n}`;
const dateNew = `function getScheduleOccurrenceDate(row) {\n\treturn scheduleOccurrenceText(row?.scheduleDate || row?.rawDate || row?.date || row?.plannedDate).slice(0, 10);\n}`;
if (!source.includes(dateOld)) throw new Error('Date helper anchor not found');
source = source.replace(dateOld, dateNew);

const squadOld = `function getScheduleOccurrenceSquadIds(row) {\n\treturn scheduleOccurrenceUnique([\n\t\t...scheduleOccurrenceArray(row?.squadIds),\n\t\trow?.squadId,\n\t]).sort();\n}`;
const squadNew = `function getScheduleOccurrenceSquadIds(row) {\n\treturn scheduleOccurrenceUnique([\n\t\t...scheduleOccurrenceArray(row?.squadIds),\n\t\trow?.squadId,\n\t\trow?.squad,\n\t]).sort();\n}`;
if (!source.includes(squadOld)) throw new Error('Squad helper anchor not found');
source = source.replace(squadOld, squadNew);

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
if (!fingerprintPattern.test(source)) throw new Error('Fingerprint helper anchor not found');
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
if (!keyPattern.test(source)) throw new Error('Suppression key helper anchor not found');
source = source.replace(keyPattern, keyReplacement);

const normalizePattern = /function normalizeScheduleOccurrenceSuppressionEntry\(entry\) \{[\s\S]*?\n\}\n\nfunction mergeScheduleOccurrenceSuppressionLists/;
const normalizeReplacement = `function normalizeScheduleOccurrenceSuppressionEntry(entry) {
\tif (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
\tconst requestedType = scheduleOccurrenceText(entry?.identityType);
\tlet normalizedIdentity = null;
\tconst hasLegacyFingerprintEvidence = Boolean(
\t\tentry?.startTime
\t\t|| entry?.endTime
\t\t|| entry?.venueId
\t\t|| entry?.venue
\t\t|| entry?.squadId
\t\t|| entry?.squad
\t\t|| scheduleOccurrenceArray(entry?.squadIds).length > 0
\t\t|| entry?.sessionTypeId
\t\t|| entry?.trainingTypeId
\t\t|| entry?.sessionType
\t\t|| entry?.type
\t);
\tif (requestedType === 'legacy-fingerprint' || (!getScheduleOccurrenceSourceSlotId(entry) && hasLegacyFingerprintEvidence)) {
\t\tnormalizedIdentity = getScheduleOccurrenceFingerprint({ ...entry, manualScheduleEntry: false, generatedByPlanner: true });
\t} else {
\t\tnormalizedIdentity = getScheduleOccurrenceIdentityParts(entry);
\t\tif (!normalizedIdentity) {
\t\t\tnormalizedIdentity = getScheduleOccurrenceFingerprint({ ...entry, manualScheduleEntry: false, generatedByPlanner: true });
\t\t}
\t}
\tif (!normalizedIdentity) return null;
\tconst deletedAtMs = parseIsoMs(entry?.deletedAt);
\tconst deletedAt = Number.isFinite(deletedAtMs)
\t\t? new Date(deletedAtMs).toISOString()
\t\t: new Date().toISOString();
\treturn {
\t\t...normalizedIdentity,
\t\tdeletedAt,
\t\tdeletedBy: scheduleOccurrenceText(entry?.deletedBy).toLowerCase() || 'unknown-actor',
\t};
}

function mergeScheduleOccurrenceSuppressionLists`;
if (!normalizePattern.test(source)) throw new Error('Suppression normalization anchor not found');
source = source.replace(normalizePattern, normalizeReplacement);

const exactMatcher = `\tif (candidate.timetableId !== suppression.timetableId) return false;\n\tif (candidate.startTime !== suppression.startTime) return false;\n\tif (candidate.endTime !== suppression.endTime) return false;\n\tif (suppression.venueId && candidate.venueId !== suppression.venueId) return false;\n\tif (scheduleOccurrenceArray(suppression.squadIds).length > 0\n\t\t&& !scheduleOccurrenceSameIds(candidate.squadIds, suppression.squadIds)) return false;\n\treturn true;`;
const wildcardMatcher = `\tif (suppression.timetableId && candidate.timetableId !== suppression.timetableId) return false;\n\tif (suppression.startTime && candidate.startTime !== suppression.startTime) return false;\n\tif (suppression.endTime && candidate.endTime !== suppression.endTime) return false;\n\tif (suppression.venueId && candidate.venueId !== suppression.venueId) return false;\n\tif (scheduleOccurrenceArray(suppression.squadIds).length > 0\n\t\t&& !scheduleOccurrenceSameIds(candidate.squadIds, suppression.squadIds)) return false;\n\tif (suppression.sessionTypeId && candidate.sessionTypeId !== suppression.sessionTypeId) return false;\n\treturn true;`;
if (!source.includes(exactMatcher)) throw new Error('Legacy matcher anchor not found');
source = source.replace(exactMatcher, wildcardMatcher);

const output = eol === '\r\n' ? source.replace(/\n/g, '\r\n') : source;
fs.writeFileSync(path, output, 'utf8');
console.log(`BACKEND_SCHEDULE_FAIL_CLOSED_DIFF_REPAIRED_EOL=${JSON.stringify(eol)}`);
