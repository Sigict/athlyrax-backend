import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const oldToken = 'const TOMBSTONE_MAX_ENTRIES = 5000;';
const newToken = 'const TOMBSTONE_MAX_ENTRIES = 20000;';

if (!source.includes(newToken)) {
  if (!source.includes(oldToken)) {
    throw new Error('Could not locate the backend tombstone capacity constant.');
  }
  source = source.replace(oldToken, newToken);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_BULK_DELETE_TOMBSTONE_CAPACITY_OK');
