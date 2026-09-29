import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
const marker = 'ATHLYRAX_PUT_RETURNS_COMMITTED_DB_V1';

if (!source.includes(marker)) {
  const routeStart = source.indexOf("app.put('/db'");
  if (routeStart < 0) throw new Error('Canonical PUT /db route was not found.');
  const thenStart = source.indexOf('.then((result) => {', routeStart);
  if (thenStart < 0) throw new Error('Canonical PUT /db completion handler was not found.');
  const responseStart = source.indexOf('res.status(200).json({', thenStart);
  if (responseStart < 0) throw new Error('Canonical PUT /db success response was not found.');
  const responseEnd = source.indexOf('\n\t\t\t});', responseStart);
  if (responseEnd < 0) throw new Error('Canonical PUT /db success response end was not found.');

  const insertion = [
    '\t\t\t\t// ' + marker,
    '\t\t\t\tdb: readJsonFile(storagePaths.dbPath),',
  ].join('\n');
  source = source.slice(0, responseEnd) + '\n' + insertion + source.slice(responseEnd);
}

if (!source.includes(marker) || !source.includes('db: readJsonFile(storagePaths.dbPath),')) {
  throw new Error('Committed DB response patch verification failed.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('DB_PUT_COMMITTED_RESPONSE_OK');
