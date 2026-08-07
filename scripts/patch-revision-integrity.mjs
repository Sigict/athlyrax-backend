import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const oldBlock = `\t\tif (isStaleWrite) {\n\t\t\treturn {\n\t\t\t\trecoveredTargets: 0,\n\t\t\t\trecoveredFixtureIds: 0,\n\t\t\t\tstaleWriteIgnored: true,\n\t\t\t};\n\t\t}`;
const newBlock = `\t\tif (isStaleWrite) {\n\t\t\tconst authoritativeRevision = Number.parseInt(String(currentDb?.__meta?.storageRevision ?? '0'), 10);\n\t\t\treturn {\n\t\t\t\trecoveredTargets: 0,\n\t\t\t\trecoveredFixtureIds: 0,\n\t\t\t\tstaleWriteIgnored: true,\n\t\t\t\tstorageRevision: Number.isFinite(authoritativeRevision) && authoritativeRevision >= 0 ? authoritativeRevision : 0,\n\t\t\t};\n\t\t}`;
if (!source.includes(newBlock)) {
  if (!source.includes(oldBlock)) throw new Error('Stale-write response anchor was not found.');
  source = source.replace(oldBlock, newBlock);
}

const oldResponse = `\t\t\t\tplannerBackupSaved: result.plannerBackupSaved !== false,\n\t\t\t});`;
const newResponse = `\t\t\t\tplannerBackupSaved: result.plannerBackupSaved !== false,\n\t\t\t\t...(Number.isFinite(Number(result.storageRevision)) ? { storageRevision: Number(result.storageRevision) } : {}),\n\t\t\t});`;
if (!source.includes(newResponse)) {
  if (!source.includes(oldResponse)) throw new Error('PUT /db response revision anchor was not found.');
  source = source.replace(oldResponse, newResponse);
}

for (const token of ['authoritativeRevision', 'storageRevision: Number.isFinite(authoritativeRevision)', 'Number.isFinite(Number(result.storageRevision))']) {
  if (!source.includes(token)) throw new Error(`Revision integrity verification failed: ${token}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('REVISION_INTEGRITY_PATCH_OK');
