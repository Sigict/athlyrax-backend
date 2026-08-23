import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
const safetyPath = path.resolve('scripts/data-safety-preload.mjs');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
let safetySource = fs.readFileSync(safetyPath, 'utf8').replace(/\r\n/g, '\n');

// One concurrency authority only: storageRevision.
// Timestamp metadata remains available for audit/recovery helpers, but it must
// never decide whether a current client is allowed to persist a database write.
// Genuine stale tabs are rejected by exact storageRevision mismatch.
const legacyIndexStaleBlock = /\n\t\tconst currentUpdatedAtMs = getDbShapeUpdatedAtMs\(currentDb\);\n\t\tconst incomingUpdatedAtMs = getDbShapeUpdatedAtMs\(body\);\n\t\tconst isStaleWrite = Number\.isFinite\(currentUpdatedAtMs\)\n\t\t\t&& Number\.isFinite\(incomingUpdatedAtMs\)\n\t\t\t&& incomingUpdatedAtMs \+ 1000 < currentUpdatedAtMs;\n\t\tif \(isStaleWrite\) \{\n\t\t\treturn \{\n\t\t\t\trecoveredTargets: 0,\n\t\t\t\trecoveredFixtureIds: 0,\n\t\t\t\tstaleWriteIgnored: true,\n(?:\t\t\t\tstorageRevision: Number\.isFinite\(authoritativeRevision\) && authoritativeRevision >= 0 \? authoritativeRevision : 0,\n)?\t\t\t\};\n\t\t\}\n/;
source = source.replace(legacyIndexStaleBlock, '\n');

source = source.replace(/\n\t\t\t\tstaleWriteIgnored: result\.staleWriteIgnored === true,/g, '');
source = source.replace(/\n\t\t\tstaleWriteIgnored: false,/g, '');

safetySource = safetySource.replace(
  /\n\s*const staleToleranceMs = Math\.max\(0, Number\.parseInt\(String\(env\.ATHLYRAX_STALE_WRITE_TOLERANCE_MS \|\| '1000'\), 10\) \|\| 1000\);/,
  '',
);
safetySource = safetySource.replace(
  /\n\s*const currentTime = getRevisionTime\(current\);\n\s*const incomingTime = getRevisionTime\(incoming\);\n\s*if \(Number\.isFinite\(currentTime\) && Number\.isFinite\(incomingTime\) && incomingTime \+ staleToleranceMs < currentTime\) \{\n\s*const error = new Error\('Refusing stale database replacement\.'\);\n\s*error\.code = 'ATHLYRAX_STALE_DB_WRITE';\n\s*throw error;\n\s*\}/,
  '',
);

// The primary database commit is authoritative. A protected secondary planner
// backup may legitimately refuse a destructive refresh; preserve that backup
// without reporting the already-committed DB write as failed.
const backupWrite = '\t\twriteAtomicJsonFile(storagePaths.backupPath, nextBackup);';
const guardedBackupWrite = `\t\ttry {\n\t\t\twriteAtomicJsonFile(storagePaths.backupPath, nextBackup);\n\t\t} catch (backupError) {\n\t\t\tconsole.warn(\`Planner target backup refresh was preserved after the primary database committed: \${backupError instanceof Error ? backupError.message : String(backupError)}\`);\n\t\t}`;
if (source.includes(backupWrite)) source = source.replace(backupWrite, guardedBackupWrite);
if (!source.includes('Planner target backup refresh was preserved after the primary database committed:')) {
  throw new Error('Primary database response still depends on the secondary planner backup refresh.');
}

// Complete synchronous storage healing before the server accepts requests.
// Otherwise the first GET can expose revision N while startup immediately
// commits revision N+1 behind that client's back.
source = source.replace(/\n\s*autoHealSwimmerBindingsAtStartup\(\);\n\}\);/, '\n});');
if (!source.includes('autoHealSwimmerBindingsAtStartup();\nconst server = app.listen')) {
  source = source.replace('\nconst server = app.listen', '\nautoHealSwimmerBindingsAtStartup();\nconst server = app.listen');
}
if (source.indexOf('autoHealSwimmerBindingsAtStartup();') > source.indexOf('const server = app.listen')) {
  throw new Error('Startup storage healing must finish before the server begins accepting DB requests.');
}

// Optimistic concurrency rejection is a client conflict, not a server fault.
const structuredCatchMarker = "\t\t\t// [STRUCTURED_400_CATCH_V1] Structured client-facing errors surface with attached body.";
const revisionConflictCatch = `\t\t\tif (error?.code === 'ATHLYRAX_DB_REVISION_CONFLICT') {\n\t\t\t\tres.status(409).json({ error: 'Database revision conflict.', details: error.message });\n\t\t\t\treturn;\n\t\t\t}\n${structuredCatchMarker}`;
if (!source.includes("error?.code === 'ATHLYRAX_DB_REVISION_CONFLICT'")) {
  source = source.replace(structuredCatchMarker, revisionConflictCatch);
}
if (!source.includes("res.status(409).json({ error: 'Database revision conflict.'")) {
  throw new Error('Database revision conflicts must return HTTP 409.');
}

for (const forbidden of [
  'const isStaleWrite =',
  'staleWriteIgnored: true',
  'ATHLYRAX_STALE_WRITE_TOLERANCE_MS',
  "error.code = 'ATHLYRAX_STALE_DB_WRITE'",
]) {
  if (source.includes(forbidden) || safetySource.includes(forbidden)) {
    throw new Error(`Timestamp-based persistence authority still present: ${forbidden}`);
  }
}

for (const required of [
  'function getRevisionTime(payload)',
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
