import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_CANONICAL_DATA_CLEANUP_V1';

if (!source.includes(marker)) {
  const importAnchor = "import Stripe from 'stripe';";
  if (!source.includes(importAnchor)) throw new Error('Canonical data cleanup import anchor was not found.');
  source = source.replace(
    importAnchor,
    `${importAnchor}\nimport { sanitizeAttendanceState, sanitizeTrainingSessionSetState } from './canonical-data-cleanup.mjs';`,
  );

  const readAnchor = `\t\t\tconst persistedSuppressions = Array.isArray(parsedDatabase?.__meta?.scheduleOccurrenceSuppressions)
\t\t\t\t? parsedDatabase.__meta.scheduleOccurrenceSuppressions
\t\t\t\t: [];
\t\t\tconst readFiltered = applyScheduleOccurrenceSuppressionsToDbShape(parsedDatabase, persistedSuppressions);
\t\t\tlet responsePayload = JSON.stringify(readFiltered.dbShape);`;

  const readReplacement = `\t\t\t${marker}
\t\t\tconst setCleanup = sanitizeTrainingSessionSetState(parsedDatabase);
\t\t\tconst attendanceCleanup = sanitizeAttendanceState(setCleanup.db);
\t\t\tlet canonicalPersistedShape = attendanceCleanup.db;
\t\t\tif (setCleanup.changed || attendanceCleanup.changed) {
\t\t\t\twriteDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir);
\t\t\t\tcanonicalPersistedShape = applyOwnershipMetadataToDbShape(
\t\t\t\t\tcanonicalPersistedShape,
\t\t\t\t\tparsedDatabase,
\t\t\t\t\treq.auth,
\t\t\t\t);
\t\t\t\twriteAtomicJsonFile(storagePaths.dbPath, canonicalPersistedShape);
\t\t\t}
\t\t\tparsedDatabase = canonicalPersistedShape;
\t\t\tconst persistedSuppressions = Array.isArray(parsedDatabase?.__meta?.scheduleOccurrenceSuppressions)
\t\t\t\t? parsedDatabase.__meta.scheduleOccurrenceSuppressions
\t\t\t\t: [];
\t\t\tconst readFiltered = applyScheduleOccurrenceSuppressionsToDbShape(parsedDatabase, persistedSuppressions);
\t\t\tlet responsePayload = JSON.stringify(readFiltered.dbShape);`;

  if (!source.includes(readAnchor)) {
    throw new Error('Canonical data cleanup GET /db anchor was not found after runtime read hardening.');
  }
  source = source.replace(readAnchor, readReplacement);

  const putAnchor = `\t\tconst ownershipStampedBody = applyOwnershipMetadataToDbShape(safeBody, currentDb, req.auth);`;
  const putReplacement = `\t\tconst writeSetCleanup = sanitizeTrainingSessionSetState(safeBody);
\t\tconst writeAttendanceCleanup = sanitizeAttendanceState(writeSetCleanup.db);
\t\tconst ownershipStampedBody = applyOwnershipMetadataToDbShape(writeAttendanceCleanup.db, currentDb, req.auth);`;
  if (!source.includes(putAnchor)) throw new Error('Canonical data cleanup PUT /db anchor was not found.');
  source = source.replace(putAnchor, putReplacement);

  const returnAnchor = `\t\t\tblockedResurrections: [
\t\t\t\t...(Array.isArray(filtered.blockedResurrections) ? filtered.blockedResurrections : []),
\t\t\t\t...(Array.isArray(occurrenceFiltered.blockedResurrections) ? occurrenceFiltered.blockedResurrections : []),
\t\t\t],
\t\t\ttombstoneCount: mergedTombstones.length,`;
  const returnReplacement = `\t\t\tblockedResurrections: [
\t\t\t\t...(Array.isArray(filtered.blockedResurrections) ? filtered.blockedResurrections : []),
\t\t\t\t...(Array.isArray(occurrenceFiltered.blockedResurrections) ? occurrenceFiltered.blockedResurrections : []),
\t\t\t],
\t\t\ttrainingSessionSetCleanup: writeSetCleanup.stats,
\t\t\tattendanceCleanup: writeAttendanceCleanup.stats,
\t\t\ttombstoneCount: mergedTombstones.length,`;
  if (!source.includes(returnAnchor)) throw new Error('Canonical data cleanup PUT result anchor was not found.');
  source = source.replace(returnAnchor, returnReplacement);

  const responseAnchor = `\t\t\t\tblockedResurrections: Array.isArray(result.blockedResurrections) ? result.blockedResurrections : [],
\t\t\t\ttombstoneCount: Number.isFinite(result.tombstoneCount) ? result.tombstoneCount : 0,`;
  const responseReplacement = `\t\t\t\tblockedResurrections: Array.isArray(result.blockedResurrections) ? result.blockedResurrections : [],
\t\t\t\ttrainingSessionSetCleanup: result.trainingSessionSetCleanup || null,
\t\t\t\tattendanceCleanup: result.attendanceCleanup || null,
\t\t\t\ttombstoneCount: Number.isFinite(result.tombstoneCount) ? result.tombstoneCount : 0,`;
  if (!source.includes(responseAnchor)) throw new Error('Canonical data cleanup PUT response anchor was not found.');
  source = source.replace(responseAnchor, responseReplacement);
}

for (const token of [
  'ATHLYRAX_CANONICAL_DATA_CLEANUP_V1',
  "from './canonical-data-cleanup.mjs'",
  'sanitizeTrainingSessionSetState(parsedDatabase)',
  'sanitizeAttendanceState(setCleanup.db)',
  'writeDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir)',
  'sanitizeTrainingSessionSetState(safeBody)',
  'sanitizeAttendanceState(writeSetCleanup.db)',
  'trainingSessionSetCleanup: writeSetCleanup.stats',
  'attendanceCleanup: writeAttendanceCleanup.stats',
]) {
  if (!source.includes(token)) throw new Error(`Canonical data cleanup missing: ${token}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('CANONICAL_DATA_CLEANUP_OK');
