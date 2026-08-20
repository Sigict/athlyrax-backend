import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_RETIRE_LEGACY_TRAINING_SCHEDULES_V1';
const rawGetAnchor = "\t\t\t\tconst persistedShape = JSON.parse(String(data || '{}'));";
const hardenedGetAnchor = "\t\t\tconst persistedSuppressions = Array.isArray(parsedDatabase?.__meta?.scheduleOccurrenceSuppressions)";
const putAnchor = "\tconst body = req.body;\n\tif (!body || typeof body !== 'object' || Array.isArray(body)) {\n\t\tres.status(400).json({ error: 'Invalid payload. Expected JSON object.' });\n\t\treturn;\n\t}";

if (!source.includes(marker)) {
  if (source.includes(hardenedGetAnchor)) {
    source = source.replace(
      hardenedGetAnchor,
      `\t\t\t${marker}\n\t\t\t// trainingSchedules is an obsolete mirror and must never be exposed as a second Schedule source.\n\t\t\tparsedDatabase.trainingSchedules = [];\n${hardenedGetAnchor}`,
    );
  } else if (source.includes(rawGetAnchor)) {
    source = source.replace(
      rawGetAnchor,
      `${rawGetAnchor}\n\t\t\t\t${marker}\n\t\t\t\t// trainingSchedules is an obsolete mirror and must never be exposed as a second Schedule source.\n\t\t\t\tpersistedShape.trainingSchedules = [];`,
    );
  } else {
    throw new Error('Could not locate GET /db database-shape anchor for legacy Schedule retirement.');
  }

  if (!source.includes(putAnchor)) throw new Error('Could not locate PUT /db payload validation anchor.');
  source = source.replace(
    putAnchor,
    `${putAnchor}\n\t// ${marker}\n\t// Retire the obsolete legacy mirror on every normal write so it cannot survive a delete,\n\t// reload, or later whole-database save and be promoted back into canonical Schedule state.\n\tbody.trainingSchedules = [];`,
  );
}

for (const required of [
  marker,
  "body.trainingSchedules = [];",
]) {
  if (!source.includes(required)) throw new Error(`Legacy Schedule retirement invariant missing: ${required}`);
}
if (!source.includes('parsedDatabase.trainingSchedules = [];') && !source.includes('persistedShape.trainingSchedules = [];')) {
  throw new Error('Legacy Schedule retirement is not wired into GET /db.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_LEGACY_TRAINING_SCHEDULES_RETIRED_OK');
