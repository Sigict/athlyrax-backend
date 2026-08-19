import fs from 'node:fs';

const path = 'index.js';
let source = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const startToken = 'function getScheduleOccurrenceIdentityParts(row) {';
const endToken = 'function applyOwnershipMetadataToDbShape(dbShape, existingDbShape, auth) {';
const start = source.indexOf(startToken);
const end = source.indexOf(endToken, start);
if (start < 0 || end <= start) throw new Error('Schedule suppression helper block bounds missing.');

const replacement = `function scheduleOccurrenceText(value) {
\treturn String(value ?? '').trim();
}

function scheduleOccurrenceArray(value) {
\treturn Array.isArray(value) ? value : [];
}

function scheduleOccurrenceUnique(values) {
\treturn Array.from(new Set(values.map(scheduleOccurrenceText).filter(Boolean)));
}

function getScheduleOccurrenceSourceSlotId(row) {
\treturn scheduleOccurrenceText(
\t\trow?.generatedSourceSlotId
\t\t|| row?.generatedSourceScheduleId
\t\t|| row?.timetableSlotId
\t\t|| row?.sourceSlotId,
\t);
}

function getScheduleOccurrenceDate(row) {
\treturn scheduleOccurrenceText(row?.scheduleDate || row?.rawDate || row?.date || row?.plannedDate);
}

function getScheduleOccurrenceTimetableId(row) {
\treturn scheduleOccurrenceText(row?.timetableId || row?.timetableSourceId);
}

function getScheduleOccurrenceSquadIds(row) {
\treturn scheduleOccurrenceUnique([
\t\t...scheduleOccurrenceArray(row?.squadIds),
\t\trow?.squadId,
\t]).sort();
}

function isExplicitManualScheduleRow(row) {
\tif (!row || typeof row !== 'object' || Array.isArray(row)) return false;
\tif (row?.manualScheduleEntry === true) return true;
\treturn row?.generatedByPlanner === false && !getScheduleOccurrenceSourceSlotId(row);
}

function getScheduleOccurrenceIdentityParts(row) {
\tif (!row || typeof row !== 'object' || Array.isArray(row)) return null;
\tconst sourceSlotId = getScheduleOccurrenceSourceSlotId(row);
\tconst scheduleDate = getScheduleOccurrenceDate(row);
\tconst timetableId = getScheduleOccurrenceTimetableId(row);
\tif (!sourceSlotId || !scheduleDate || !timetableId) return null;
\treturn { identityType: 'source-slot', sourceSlotId, scheduleDate, timetableId };
}

function getScheduleOccurrenceIdentityKey(row) {
\tconst identity = getScheduleOccurrenceIdentityParts(row);
\treturn identity ? JSON.stringify([identity.sourceSlotId, identity.scheduleDate, identity.timetableId]) : '';
}

function getScheduleOccurrenceFingerprint(row) {
\tif (!row || typeof row !== 'object' || Array.isArray(row) || isExplicitManualScheduleRow(row)) return null;
\tconst scheduleDate = getScheduleOccurrenceDate(row);
\tconst timetableId = getScheduleOccurrenceTimetableId(row);
\tconst startTime = scheduleOccurrenceText(row?.startTime);
\tconst endTime = scheduleOccurrenceText(row?.endTime);
\tif (!scheduleDate || !timetableId || !startTime || !endTime) return null;
\tconst venueId = scheduleOccurrenceText(row?.venueId || row?.venue);
\tconst squadIds = getScheduleOccurrenceSquadIds(row);
\treturn {
\t\tidentityType: 'legacy-fingerprint',
\t\tscheduleDate,
\t\ttimetableId,
\t\tstartTime,
\t\tendTime,
\t\t...(venueId ? { venueId } : {}),
\t\tsquadIds,
\t};
}

function getScheduleOccurrenceSuppressionKey(row) {
\tconst identity = getScheduleOccurrenceIdentityParts(row);
\tif (identity && scheduleOccurrenceText(row?.identityType) !== 'legacy-fingerprint') {
\t\treturn JSON.stringify([identity.sourceSlotId, identity.scheduleDate, identity.timetableId]);
\t}
\tconst fingerprint = getScheduleOccurrenceFingerprint({ ...row, manualScheduleEntry: false, generatedByPlanner: true });
\tif (!fingerprint) return '';
\treturn JSON.stringify([
\t\t'legacy-fingerprint',
\t\tfingerprint.timetableId,
\t\tfingerprint.scheduleDate,
\t\tfingerprint.startTime,
\t\tfingerprint.endTime,
\t\tfingerprint.venueId || '*',
\t\tfingerprint.squadIds,
\t]);
}

function normalizeScheduleOccurrenceSuppressionEntry(entry) {
\tif (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
\tconst requestedType = scheduleOccurrenceText(entry?.identityType);
\tlet normalizedIdentity = null;
\tif (requestedType === 'legacy-fingerprint' || (!getScheduleOccurrenceSourceSlotId(entry) && (entry?.startTime || entry?.endTime))) {
\t\tnormalizedIdentity = getScheduleOccurrenceFingerprint({ ...entry, manualScheduleEntry: false, generatedByPlanner: true });
\t} else {
\t\tnormalizedIdentity = getScheduleOccurrenceIdentityParts(entry);
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

function mergeScheduleOccurrenceSuppressionLists(existingList, incomingList) {
\tconst byKey = new Map();
\tfor (const sourceList of [existingList, incomingList]) {
\t\tif (!Array.isArray(sourceList)) continue;
\t\tfor (const raw of sourceList) {
\t\t\tconst entry = normalizeScheduleOccurrenceSuppressionEntry(raw);
\t\t\tif (!entry) continue;
\t\t\tconst key = getScheduleOccurrenceSuppressionKey(entry);
\t\t\tif (!key) continue;
\t\t\tconst prior = byKey.get(key);
\t\t\tif (!prior || parseIsoMs(entry.deletedAt) >= parseIsoMs(prior.deletedAt)) byKey.set(key, entry);
\t\t}
\t}
\treturn Array.from(byKey.values()).sort((a, b) => parseIsoMs(b.deletedAt) - parseIsoMs(a.deletedAt));
}

function scheduleOccurrenceSameIds(left, right) {
\tconst a = scheduleOccurrenceUnique(scheduleOccurrenceArray(left)).sort();
\tconst b = scheduleOccurrenceUnique(scheduleOccurrenceArray(right)).sort();
\tif (a.length !== b.length) return false;
\treturn a.every((value, index) => value === b[index]);
}

function matchesScheduleOccurrenceSuppression(suppression, row) {
\tif (isExplicitManualScheduleRow(row)) return false;
\tif (suppression?.identityType === 'source-slot') {
\t\tconst identity = getScheduleOccurrenceIdentityParts(row);
\t\treturn Boolean(
\t\t\tidentity
\t\t\t&& identity.sourceSlotId === suppression.sourceSlotId
\t\t\t&& identity.scheduleDate === suppression.scheduleDate
\t\t\t&& identity.timetableId === suppression.timetableId
\t\t);
\t}
\tif (suppression?.identityType !== 'legacy-fingerprint') return false;
\tconst candidate = getScheduleOccurrenceFingerprint({ ...row, manualScheduleEntry: false, generatedByPlanner: true });
\tif (!candidate) return false;
\tif (candidate.scheduleDate !== suppression.scheduleDate) return false;
\tif (candidate.timetableId !== suppression.timetableId) return false;
\tif (candidate.startTime !== suppression.startTime) return false;
\tif (candidate.endTime !== suppression.endTime) return false;
\tif (suppression.venueId && candidate.venueId !== suppression.venueId) return false;
\tif (scheduleOccurrenceArray(suppression.squadIds).length > 0
\t\t&& !scheduleOccurrenceSameIds(candidate.squadIds, suppression.squadIds)) return false;
\treturn true;
}

function applyScheduleOccurrenceSuppressionsToDbShape(dbShape, suppressions) {
\tif (!dbShape || typeof dbShape !== 'object' || Array.isArray(dbShape)) {
\t\treturn { dbShape, blockedResurrections: [] };
\t}
\tconst normalizedSuppressions = mergeScheduleOccurrenceSuppressionLists([], suppressions);
\tif (normalizedSuppressions.length === 0) return { dbShape, blockedResurrections: [] };

\tconst next = { ...dbShape };
\tconst blockedResurrections = [];
\tconst blockedScheduleIds = new Set();

\tfor (const collection of ['schedule', 'trainingSchedules']) {
\t\tconst rows = Array.isArray(next[collection]) ? next[collection] : null;
\t\tif (!rows) continue;
\t\tconst kept = [];
\t\tfor (const row of rows) {
\t\t\tconst matched = normalizedSuppressions.find((entry) => matchesScheduleOccurrenceSuppression(entry, row));
\t\t\tif (!matched) {
\t\t\t\tkept.push(row);
\t\t\t\tcontinue;
\t\t\t}
\t\t\tconst rowId = toRowId(row?.id);
\t\t\tif (rowId) blockedScheduleIds.add(rowId);
\t\t\tblockedResurrections.push({
\t\t\t\tcollection,
\t\t\t\tid: rowId,
\t\t\t\tidentityType: matched.identityType,
\t\t\t\tscheduleDate: matched.scheduleDate,
\t\t\t\ttimetableId: matched.timetableId,
\t\t\t\t...(matched.sourceSlotId ? { sourceSlotId: matched.sourceSlotId } : {}),
\t\t\t});
\t\t}
\t\tif (kept.length !== rows.length) next[collection] = kept;
\t}

\tif (blockedScheduleIds.size === 0) return { dbShape: next, blockedResurrections };

\tconst sourceSessions = Array.isArray(next.trainingSessions) ? next.trainingSessions : [];
\tconst blockedSessionIds = new Set(
\t\tsourceSessions
\t\t\t.filter((row) => blockedScheduleIds.has(toRowId(row?.scheduleId || row?.trainingScheduleId)))
\t\t\t.map((row) => toRowId(row?.id))
\t\t\t.filter(Boolean),
\t);
\tif (sourceSessions.length > 0) {
\t\tnext.trainingSessions = sourceSessions.filter(
\t\t\t(row) => !blockedScheduleIds.has(toRowId(row?.scheduleId || row?.trainingScheduleId)),
\t\t);
\t}

\tconst sourceSets = Array.isArray(next.trainingSessionSets) ? next.trainingSessionSets : [];
\tconst blockedSetIds = new Set(
\t\tsourceSets
\t\t\t.filter((row) => blockedSessionIds.has(toRowId(row?.sessionId || row?.trainingSessionId)))
\t\t\t.map((row) => toRowId(row?.id))
\t\t\t.filter(Boolean),
\t);
\tif (sourceSets.length > 0) {
\t\tnext.trainingSessionSets = sourceSets.filter(
\t\t\t(row) => !blockedSessionIds.has(toRowId(row?.sessionId || row?.trainingSessionId)),
\t\t);
\t}

\tconst sourceBlocks = Array.isArray(next.trainingSetBlocks) ? next.trainingSetBlocks : [];
\tif (sourceBlocks.length > 0 && (blockedSessionIds.size > 0 || blockedSetIds.size > 0)) {
\t\tnext.trainingSetBlocks = sourceBlocks
\t\t\t.map((block) => {
\t\t\t\tconst arraySetIds = Array.isArray(block?.setIds) ? block.setIds.map(toRowId).filter(Boolean) : [];
\t\t\t\tconst singularSetId = toRowId(block?.setId);
\t\t\t\tconst allSetIds = scheduleOccurrenceUnique([...arraySetIds, singularSetId]);
\t\t\t\tconst remainingSetIds = allSetIds.filter((id) => !blockedSetIds.has(id));
\t\t\t\tif (remainingSetIds.length === allSetIds.length) return block;
\t\t\t\treturn {
\t\t\t\t\t...block,
\t\t\t\t\tsetIds: remainingSetIds,
\t\t\t\t\t...(singularSetId && blockedSetIds.has(singularSetId) ? { setId: '' } : {}),
\t\t\t\t};
\t\t\t})
\t\t\t.filter((block) => {
\t\t\t\tconst sessionId = toRowId(block?.sessionId || block?.trainingSessionId);
\t\t\t\tif (!blockedSessionIds.has(sessionId)) return true;
\t\t\t\tconst arraySetIds = Array.isArray(block?.setIds) ? block.setIds.map(toRowId).filter(Boolean) : [];
\t\t\t\tconst remainingSetIds = scheduleOccurrenceUnique([...arraySetIds, toRowId(block?.setId)]);
\t\t\t\treturn remainingSetIds.length > 0;
\t\t\t});
\t}

\tif (Array.isArray(next.attendance)) {
\t\tnext.attendance = next.attendance.filter(
\t\t\t(row) => !blockedScheduleIds.has(toRowId(row?.scheduleId || row?.trainingScheduleId)),
\t\t);
\t}

\treturn { dbShape: next, blockedResurrections };
}

`;

source = `${source.slice(0, start)}${replacement}${source.slice(end)}`;
for (const required of [
  "identityType: 'legacy-fingerprint'",
  'getScheduleOccurrenceSuppressionKey',
  'matchesScheduleOccurrenceSuppression',
  "for (const collection of ['schedule', 'trainingSchedules'])",
  'row?.scheduleId || row?.trainingScheduleId',
]) {
  if (!source.includes(required)) throw new Error(`backend Schedule patch invariant missing: ${required}`);
}
fs.writeFileSync(path, source);
console.log('BACKEND_FINAL_SCHEDULE_SUPPRESSION_PATCH_APPLIED');
