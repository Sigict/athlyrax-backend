import fs from 'node:fs';

const path = 'index.js';
let source = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const dateOld = `function getScheduleOccurrenceDate(row) {\n\treturn scheduleOccurrenceText(row?.scheduleDate || row?.rawDate || row?.date || row?.plannedDate);\n}`;
const dateNew = `function getScheduleOccurrenceDate(row) {\n\treturn scheduleOccurrenceText(row?.scheduleDate || row?.rawDate || row?.date || row?.plannedDate).slice(0, 10);\n}`;
if (!source.includes(dateOld)) throw new Error('Schedule occurrence date helper anchor not found');
source = source.replace(dateOld, dateNew);

const squadOld = `function getScheduleOccurrenceSquadIds(row) {\n\treturn scheduleOccurrenceUnique([\n\t\t...scheduleOccurrenceArray(row?.squadIds),\n\t\trow?.squadId,\n\t]).sort();\n}`;
const squadNew = `function getScheduleOccurrenceSquadIds(row) {\n\treturn scheduleOccurrenceUnique([\n\t\t...scheduleOccurrenceArray(row?.squadIds),\n\t\trow?.squadId,\n\t\trow?.squad,\n\t]).sort();\n}`;
if (!source.includes(squadOld)) throw new Error('Schedule occurrence squad helper anchor not found');
source = source.replace(squadOld, squadNew);

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
if (!normalizePattern.test(source)) throw new Error('Schedule suppression normalization helper anchor not found');
source = source.replace(normalizePattern, normalizeReplacement);

for (const token of [
  '.slice(0, 10)',
  'row?.squad,',
  'hasLegacyFingerprintEvidence',
  'if (!normalizedIdentity) {',
]) {
  if (!source.includes(token)) throw new Error(`Backend parity token missing after patch: ${token}`);
}

fs.writeFileSync(path, source, 'utf8');
console.log('BACKEND_SCHEDULE_FAIL_CLOSED_PARITY_OK');
