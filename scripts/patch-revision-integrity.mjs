import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
const safetyPath = path.resolve('scripts/data-safety-preload.mjs');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
let safetySource = fs.readFileSync(safetyPath, 'utf8').replace(/\r\n/g, '\n');

// One concurrency authority only: storageRevision.
// Timestamp-based stale checks duplicated the revision handshake and could reject
// a perfectly current client simply because it carried the previous server-side
// storageUpdatedAt timestamp. Genuine stale tabs are still rejected by exact
// storageRevision mismatch in the data-safety guard.
const legacyIndexStaleBlock = /\n\t\tconst currentUpdatedAtMs = getDbShapeUpdatedAtMs\(currentDb\);\n\t\tconst incomingUpdatedAtMs = getDbShapeUpdatedAtMs\(body\);\n\t\tconst isStaleWrite = Number\.isFinite\(currentUpdatedAtMs\)\n\t\t\t&& Number\.isFinite\(incomingUpdatedAtMs\)\n\t\t\t&& incomingUpdatedAtMs \+ 1000 < currentUpdatedAtMs;\n\t\tif \(isStaleWrite\) \{\n\t\t\treturn \{\n\t\t\t\trecoveredTargets: 0,\n\t\t\t\trecoveredFixtureIds: 0,\n\t\t\t\tstaleWriteIgnored: true,\n(?:\t\t\t\tstorageRevision: Number\.isFinite\(authoritativeRevision\) && authoritativeRevision >= 0 \? authoritativeRevision : 0,\n)?\t\t\t\};\n\t\t\}\n/;
source = source.replace(legacyIndexStaleBlock, '\n');

const staleResponseField = /\n\t\t\t\tstaleWriteIgnored: result\.staleWriteIgnored === true,/g;
source = source.replace(staleResponseField, '');

const resultStaleField = /\n\t\t\tstaleWriteIgnored: false,/g;
source = source.replace(resultStaleField, '');

const revisionTimeFunction = /\nfunction getRevisionTime\(payload\) \{[\s\S]*?\n\}\n(?=function coreRecordCount)/;
safetySource = safetySource.replace(revisionTimeFunction, '\n');
safetySource = safetySource.replace(
  /\n\s*const staleToleranceMs = Math\.max\(0, Number\.parseInt\(String\(env\.ATHLYRAX_STALE_WRITE_TOLERANCE_MS \|\| '1000'\), 10\) \|\| 1000\);/,
  '',
);
safetySource = safetySource.replace(
  /\n\s*const currentTime = getRevisionTime\(current\);\n\s*const incomingTime = getRevisionTime\(incoming\);\n\s*if \(Number\.isFinite\(currentTime\) && Number\.isFinite\(incomingTime\) && incomingTime \+ staleToleranceMs < currentTime\) \{\n\s*const error = new Error\('Refusing stale database replacement\.'\);\n\s*error\.code = 'ATHLYRAX_STALE_DB_WRITE';\n\s*throw error;\n\s*\}/,
  '',
);

for (const forbidden of [
  'const isStaleWrite =',
  'staleWriteIgnored: true',
  'getRevisionTime(payload)',
  'ATHLYRAX_STALE_WRITE_TOLERANCE_MS',
  "error.code = 'ATHLYRAX_STALE_DB_WRITE'",
]) {
  if (source.includes(forbidden) || safetySource.includes(forbidden)) {
    throw new Error(`Timestamp-based persistence authority still present: ${forbidden}`);
  }
}

for (const required of [
  'const currentRevisionValue = getStorageRevision(current);',
  'const exactRevisionMatch = currentRevisionValue !== null && incomingRevision === currentRevisionValue;',
  "error.code = 'ATHLYRAX_DB_REVISION_CONFLICT'",
  'writeRevisionToIncoming(source, incoming, currentRevision + 1, expectedTenantId, fsModule);',
]) {
  if (!safetySource.includes(required)) throw new Error(`Revision authority missing: ${required}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
fs.writeFileSync(safetyPath, safetySource, 'utf8');
console.log('REVISION_INTEGRITY_PATCH_OK');
