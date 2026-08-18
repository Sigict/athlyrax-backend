import fs from 'node:fs';

const path = 'index.js';
let source = fs.readFileSync(path, 'utf8');
const newline = source.includes('\r\n') ? '\r\n' : '\n';
const nl = (text) => text.replace(/\n/g, newline);
let changed = false;

const helperMarker = 'function normalizeScheduleOccurrenceSuppressionEntry(entry) {';
if (!source.includes(helperMarker)) {
  const ownershipAnchor = 'function applyOwnershipMetadataToDbShape(dbShape, existingDbShape, auth) {';
  const anchorIndex = source.indexOf(ownershipAnchor);
  if (anchorIndex < 0) throw new Error('Ownership helper anchor missing.');
  const helpers = nl(`
function getScheduleOccurrenceIdentityParts(row) {
\tif (!row || typeof row !== 'object' || Array.isArray(row)) return null;
\tconst sourceSlotId = String(
\t\trow.generatedSourceSlotId
\t\t|| row.generatedSourceScheduleId
\t\t|| row.timetableSlotId
\t\t|| row.sourceSlotId
\t\t|| '',
\t).trim();
\tconst scheduleDate = String(row.scheduleDate || row.rawDate || row.date || row.plannedDate || '').trim();
\tconst timetableId = String(row.timetableId || row.timetableSourceId || '').trim();
\tif (!sourceSlotId || !scheduleDate || !timetableId) return null;
\treturn { sourceSlotId, scheduleDate, timetableId };
}

function getScheduleOccurrenceIdentityKey(row) {
\tconst identity = getScheduleOccurrenceIdentityParts(row);
\treturn identity ? JSON.stringify([identity.sourceSlotId, identity.scheduleDate, identity.timetableId]) : '';
}

function normalizeScheduleOccurrenceSuppressionEntry(entry) {
\tconst identity = getScheduleOccurrenceIdentityParts(entry);
\tif (!identity) return null;
\tconst deletedAtMs = parseIsoMs(entry?.deletedAt);
\tconst deletedAt = Number.isFinite(deletedAtMs)
\t\t? new Date(deletedAtMs).toISOString()
\t\t: new Date().toISOString();
\treturn {
\t\t...identity,
\t\tdeletedAt,
\t\tdeletedBy: String(entry?.deletedBy || '').trim().toLowerCase() || 'unknown-actor',
\t};
}

function mergeScheduleOccurrenceSuppressionLists(existingList, incomingList) {
\tconst byKey = new Map();
\tfor (const sourceList of [existingList, incomingList]) {
\t\tif (!Array.isArray(sourceList)) continue;
\t\tfor (const raw of sourceList) {
\t\t\tconst entry = normalizeScheduleOccurrenceSuppressionEntry(raw);
\t\t\tif (!entry) continue;
\t\t\tconst key = getScheduleOccurrenceIdentityKey(entry);
\t\t\tif (!key) continue;
\t\t\tconst prior = byKey.get(key);
\t\t\tif (!prior || parseIsoMs(entry.deletedAt) >= parseIsoMs(prior.deletedAt)) byKey.set(key, entry);
\t\t}
\t}
\treturn Array.from(byKey.values()).sort((a, b) => parseIsoMs(b.deletedAt) - parseIsoMs(a.deletedAt));
}

function applyScheduleOccurrenceSuppressionsToDbShape(dbShape, suppressions) {
\tif (!dbShape || typeof dbShape !== 'object' || Array.isArray(dbShape)) {
\t\treturn { dbShape, blockedResurrections: [] };
\t}
\tconst suppressionKeys = new Set(
\t\t(Array.isArray(suppressions) ? suppressions : [])
\t\t\t.map((entry) => getScheduleOccurrenceIdentityKey(entry))
\t\t\t.filter(Boolean),
\t);
\tif (suppressionKeys.size === 0) return { dbShape, blockedResurrections: [] };

\tconst next = { ...dbShape };
\tconst blockedResurrections = [];
\tconst blockedScheduleIds = new Set();

\tfor (const collection of ['schedule', 'trainingSchedules']) {
\t\tconst rows = Array.isArray(next[collection]) ? next[collection] : null;
\t\tif (!rows) continue;
\t\tconst kept = [];
\t\tfor (const row of rows) {
\t\t\tconst key = getScheduleOccurrenceIdentityKey(row);
\t\t\tif (!key || !suppressionKeys.has(key)) {
\t\t\t\tkept.push(row);
\t\t\t\tcontinue;
\t\t\t}
\t\t\tconst identity = getScheduleOccurrenceIdentityParts(row);
\t\t\tconst rowId = toRowId(row?.id);
\t\t\tif (collection === 'schedule' && rowId) blockedScheduleIds.add(rowId);
\t\t\tblockedResurrections.push({
\t\t\t\tcollection,
\t\t\t\tid: rowId,
\t\t\t\t...identity,
\t\t\t});
\t\t}
\t\tif (kept.length !== rows.length) next[collection] = kept;
\t}

\tif (blockedScheduleIds.size === 0) return { dbShape: next, blockedResurrections };

\tconst sourceSessions = Array.isArray(next.trainingSessions) ? next.trainingSessions : [];
\tconst blockedSessionIds = new Set(
\t\tsourceSessions
\t\t\t.filter((row) => blockedScheduleIds.has(toRowId(row?.scheduleId)))
\t\t\t.map((row) => toRowId(row?.id))
\t\t\t.filter(Boolean),
\t);
\tif (sourceSessions.length > 0) {
\t\tnext.trainingSessions = sourceSessions.filter((row) => !blockedScheduleIds.has(toRowId(row?.scheduleId)));
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
\t\t\t\tconst setIds = Array.isArray(block?.setIds) ? block.setIds.map(toRowId).filter(Boolean) : [];
\t\t\t\tconst remainingSetIds = setIds.filter((id) => !blockedSetIds.has(id));
\t\t\t\treturn remainingSetIds.length === setIds.length ? block : { ...block, setIds: remainingSetIds };
\t\t\t})
\t\t\t.filter((block) => {
\t\t\t\tconst sessionId = toRowId(block?.sessionId || block?.trainingSessionId);
\t\t\t\tif (!blockedSessionIds.has(sessionId)) return true;
\t\t\t\tconst setIds = Array.isArray(block?.setIds) ? block.setIds.map(toRowId).filter(Boolean) : [];
\t\t\t\treturn setIds.length > 0;
\t\t\t});
\t}

\tif (Array.isArray(next.attendance)) {
\t\tnext.attendance = next.attendance.filter((row) => !blockedScheduleIds.has(toRowId(row?.scheduleId)));
\t}

\treturn { dbShape: next, blockedResurrections };
}

`);
  source = source.slice(0, anchorIndex) + helpers + source.slice(anchorIndex);
  changed = true;
}

if (!source.includes('const mergedScheduleOccurrenceSuppressions = mergeScheduleOccurrenceSuppressionLists(')) {
  const tombstoneAnchor = /([\t ]*const mergedTombstones = mergeTombstoneLists\([\s\S]*?\);\r?\n[\t ]*const tombstoneLookup = buildTombstoneLookup\(mergedTombstones\);)/;
  const match = source.match(tombstoneAnchor);
  if (!match) throw new Error('Merged tombstones route anchor missing.');
  const insertion = nl(`${match[1]}
\t\tconst mergedScheduleOccurrenceSuppressions = mergeScheduleOccurrenceSuppressionLists(
\t\t\tArray.isArray(currentDb?.__meta?.scheduleOccurrenceSuppressions) ? currentDb.__meta.scheduleOccurrenceSuppressions : [],
\t\t\tArray.isArray(body?.__meta?.scheduleOccurrenceSuppressions) ? body.__meta.scheduleOccurrenceSuppressions : [],
\t\t);`);
  source = source.replace(match[1], insertion);
  changed = true;
}

if (!source.includes('const occurrenceFiltered = applyScheduleOccurrenceSuppressionsToDbShape(')) {
  const safeBodyPattern = /([\t ]*const filtered = applyTombstonesToDbShape\(\{[\s\S]*?\}, tombstoneLookup\);\r?\n)\r?\n([\t ]*const safeBody = \{\r?\n[\t ]*\.\.\.filtered\.dbShape,\r?\n[\t ]*__tombstones: mergedTombstones,\r?\n[\t ]*\};)/;
  const match = source.match(safeBodyPattern);
  if (!match) throw new Error('Filtered/safeBody route anchor missing.');
  const replacement = nl(`${match[1]}
\t\tconst occurrenceFiltered = applyScheduleOccurrenceSuppressionsToDbShape(
\t\t\tfiltered.dbShape,
\t\t\tmergedScheduleOccurrenceSuppressions,
\t\t);

\t\tconst safeBody = {
\t\t\t...occurrenceFiltered.dbShape,
\t\t\t__tombstones: mergedTombstones,
\t\t\t__meta: {
\t\t\t\t...(occurrenceFiltered.dbShape?.__meta || {}),
\t\t\t\tscheduleOccurrenceSuppressions: mergedScheduleOccurrenceSuppressions,
\t\t\t},
\t\t};`);
  source = source.replace(match[0], replacement);
  changed = true;
}

for (const required of [
  'function normalizeScheduleOccurrenceSuppressionEntry(entry) {',
  'function mergeScheduleOccurrenceSuppressionLists(existingList, incomingList) {',
  'function applyScheduleOccurrenceSuppressionsToDbShape(dbShape, suppressions) {',
  'const mergedScheduleOccurrenceSuppressions = mergeScheduleOccurrenceSuppressionLists(',
  'const occurrenceFiltered = applyScheduleOccurrenceSuppressionsToDbShape(',
  'scheduleOccurrenceSuppressions: mergedScheduleOccurrenceSuppressions,',
]) {
  if (!source.includes(required)) throw new Error(`Backend occurrence suppression invariant missing: ${required}`);
}

if (changed) fs.writeFileSync(path, source);
console.log(changed ? 'SCHEDULE_OCCURRENCE_SERVER_GUARD_PATCHED' : 'SCHEDULE_OCCURRENCE_SERVER_GUARD_ALREADY_PRESENT');
