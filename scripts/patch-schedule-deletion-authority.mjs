import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_SCHEDULE_DELETION_AUTHORITY_V1';

if (!source.includes(marker)) {
  const tombstoneOld = `\t\tconst mergedTombstones = mergeTombstoneLists(\n\t\t\tArray.isArray(currentDb?.__tombstones) ? currentDb.__tombstones : [],\n\t\t\tArray.isArray(body?.__tombstones) ? body.__tombstones : [],\n\t\t);`;
  const tombstoneNew = `${marker}\n\t\t// Schedule deletion is server-authoritative. Generic whole-DB writes may\n\t\t// preserve tombstones for other collection workflows, but cannot create a\n\t\t// new Schedule tombstone and thereby bypass POST /db/schedule-delete.\n\t\tconst incomingNonScheduleTombstones = (Array.isArray(body?.__tombstones) ? body.__tombstones : [])\n\t\t\t.filter((row) => String(row?.collection || '').trim() !== 'schedule');\n\t\tconst mergedTombstones = mergeTombstoneLists(\n\t\t\tArray.isArray(currentDb?.__tombstones) ? currentDb.__tombstones : [],\n\t\t\tincomingNonScheduleTombstones,\n\t\t);`;
  if (!source.includes(tombstoneOld)) throw new Error('Generic DB PUT tombstone merge anchor not found.');
  source = source.replace(tombstoneOld, tombstoneNew);

  const suppressionOld = `\t\tconst mergedScheduleOccurrenceSuppressions = mergeScheduleOccurrenceSuppressionLists(\n\t\t\tArray.isArray(currentDb?.__meta?.scheduleOccurrenceSuppressions) ? currentDb.__meta.scheduleOccurrenceSuppressions : [],\n\t\t\tArray.isArray(body?.__meta?.scheduleOccurrenceSuppressions) ? body.__meta.scheduleOccurrenceSuppressions : [],\n\t\t);`;
  const suppressionNew = `\t\t// Generic PUT can preserve server-owned suppressions but cannot create new\n\t\t// ones. New permanent occurrence suppressions are created only inside the\n\t\t// authoritative Schedule-delete transaction from persisted server data.\n\t\tconst mergedScheduleOccurrenceSuppressions = mergeScheduleOccurrenceSuppressionLists(\n\t\t\tArray.isArray(currentDb?.__meta?.scheduleOccurrenceSuppressions) ? currentDb.__meta.scheduleOccurrenceSuppressions : [],\n\t\t\t[],\n\t\t);`;
  if (!source.includes(suppressionOld)) throw new Error('Generic DB PUT Schedule suppression merge anchor not found.');
  source = source.replace(suppressionOld, suppressionNew);
}

for (const required of [
  marker,
  'const incomingNonScheduleTombstones =',
  ".filter((row) => String(row?.collection || '').trim() !== 'schedule')",
  'const mergedScheduleOccurrenceSuppressions = mergeScheduleOccurrenceSuppressionLists(',
]) {
  if (!source.includes(required)) throw new Error(`Schedule deletion authority invariant missing: ${required}`);
}

const putStart = source.indexOf("app.put('/db'");
if (putStart < 0) throw new Error('Generic DB PUT route not found after Schedule deletion authority hardening.');
const putEndCandidates = [
  source.indexOf("app.get('/", putStart + 1),
  source.indexOf("app.post('/", putStart + 1),
  source.indexOf("app.put('/", putStart + 1),
].filter((index) => index > putStart);
const putEnd = putEndCandidates.length > 0 ? Math.min(...putEndCandidates) : source.length;
const putSource = source.slice(putStart, putEnd);

if (putSource.includes('Array.isArray(body?.__meta?.scheduleOccurrenceSuppressions) ? body.__meta.scheduleOccurrenceSuppressions : []')) {
  throw new Error('Generic DB PUT still accepts client-supplied Schedule occurrence suppressions.');
}
if (putSource.includes('Array.isArray(body?.__tombstones) ? body.__tombstones : []\n\t\t);')) {
  throw new Error('Generic DB PUT still merges unfiltered client Schedule tombstones.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_SCHEDULE_DELETION_AUTHORITY_OK');
