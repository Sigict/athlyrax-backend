import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_PRODUCTION_ERROR_DETAILS_REDACTED';
const exposed = `details: error instanceof Error ? error.message : 'Unknown error'`;
const safe = `...(IS_PRODUCTION ? {} : { details: error instanceof Error ? error.message : 'Unknown error' })`;

if (!source.includes(marker)) {
  const count = source.split(exposed).length - 1;
  if (count < 1) throw new Error('Production error-detail redaction found no response anchors.');
  source = source.replaceAll(exposed, safe);
  source = `${marker}\n${source}`;
}

if (!source.includes(marker)) throw new Error('Production error-detail redaction marker missing.');

// The safe environment-aware expression intentionally contains the original
// `details: error...` text inside its development-only branch. A plain
// `source.includes(exposed)` therefore produces a false positive. Every raw
// occurrence must be accounted for by exactly one complete safe expression.
const exposedCount = source.split(exposed).length - 1;
const safeCount = source.split(safe).length - 1;
if (exposedCount !== safeCount) {
  throw new Error(`Raw exception detail response remains after production redaction (${exposedCount - safeCount} unguarded occurrence(s)).`);
}
if (safeCount < 1) {
  throw new Error('Environment-aware error detail redaction is missing.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('PRODUCTION_ERROR_REDACTION_OK');