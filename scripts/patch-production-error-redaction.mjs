import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_PRODUCTION_ERROR_DETAILS_REDACTED';
if (!source.includes(marker)) {
  const exposed = `details: error instanceof Error ? error.message : 'Unknown error'`;
  const safe = `...(IS_PRODUCTION ? {} : { details: error instanceof Error ? error.message : 'Unknown error' })`;
  const count = source.split(exposed).length - 1;
  if (count < 1) throw new Error('Production error-detail redaction found no response anchors.');
  source = source.replaceAll(exposed, safe);
  source = `${marker}\n${source}`;
}

if (!source.includes(marker)) throw new Error('Production error-detail redaction marker missing.');
if (source.includes(`details: error instanceof Error ? error.message : 'Unknown error'`)) {
  throw new Error('Raw exception detail response remains after production redaction.');
}
if (!source.includes(`...(IS_PRODUCTION ? {} : { details: error instanceof Error ? error.message : 'Unknown error' })`)) {
  throw new Error('Environment-aware error detail redaction is missing.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('PRODUCTION_ERROR_REDACTION_OK');