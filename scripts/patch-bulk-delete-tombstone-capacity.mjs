import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

// Deleted row ids must never become eligible for resurrection merely because a
// stale whole-database payload carries a later updatedAt timestamp. AthlyraX
// creates legitimate replacement rows with fresh ids, so the safest contract
// is simple: a tombstoned physical id stays deleted.
for (const oldToken of [
  'const TOMBSTONE_MAX_ENTRIES = 5000;',
  'const TOMBSTONE_MAX_ENTRIES = 20000;',
]) {
  if (source.includes(oldToken)) {
    source = source.replace(oldToken, 'const TOMBSTONE_MAX_ENTRIES = Number.POSITIVE_INFINITY;');
  }
}

if (!source.includes('const TOMBSTONE_MAX_ENTRIES = Number.POSITIVE_INFINITY;')) {
  throw new Error('Could not install permanent backend tombstone retention.');
}

const timestampRecreateBlock = `\t\t\tconst rowMs = rowLastMutatedMs(row);\n\t\t\tif (rowMs > tombstoneMs) {\n\t\t\t\t// Row legitimately re-created after the tombstone. Keep it and retire the tombstone.\n\t\t\t\tkept.push(row);\n\t\t\t\ttombstonesForCollection.delete(rowId);\n\t\t\t\tcontinue;\n\t\t\t}\n\t\t\tblockedResurrections.push({ collection, id: rowId });`;
const permanentDeleteBlock = `\t\t\t// Tombstoned physical ids are permanent. A stale client can rewrite\n\t\t\t// updatedAt while carrying old data, so timestamps are not proof of a\n\t\t\t// legitimate recreate. Intentional recreation must use a fresh id.\n\t\t\tblockedResurrections.push({ collection, id: rowId });`;

if (source.includes(timestampRecreateBlock)) {
  source = source.replace(timestampRecreateBlock, permanentDeleteBlock);
}

if (source.includes('tombstonesForCollection.delete(rowId)')) {
  throw new Error('Backend still contains tombstone retirement by row timestamp.');
}
if (!source.includes('Tombstoned physical ids are permanent.')) {
  throw new Error('Could not install permanent tombstone resurrection block.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_PERMANENT_DELETE_TOMBSTONES_OK');