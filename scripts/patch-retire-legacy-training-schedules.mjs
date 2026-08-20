import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_RETIRE_LEGACY_TRAINING_SCHEDULES_V1';
const getAnchor = "\t\t\t\tconst persistedShape = JSON.parse(String(data || '{}'));";
const putAnchor = "\tconst body = req.body;\n\tif (!body || typeof body !== 'object' || Array.isArray(body)) {\n\t\tres.status(400).json({ error: 'Invalid payload. Expected JSON object.' });\n\t\treturn;\n\t}";

if (!source.includes(marker)) {
  if (!source.includes(getAnchor)) throw new Error('Could not locate GET /db persisted-shape anchor.');
  if (!source.includes(putAnchor)) throw new Error('Could not locate PUT /db payload validation anchor.');

  source = source.replace(
    getAnchor,
    `${getAnchor}\n${marker}\n\t\t\t\t// trainingSchedules is an obsolete mirror and must never be exposed as a second Schedule source.\n\t\t\t\t// Keep canonical schedule as the only occurrence authority on every authenticated DB read.\n\t\t\t\tif (Object.prototype.hasOwnProperty.call(persistedShape, 'trainingSchedules')) {\n\t\t\t\t\tpersistedShape.trainingSchedules = [];\n\t\t\t\t}`,
  );

  source = source.replace(
    putAnchor,
    `${putAnchor}\n\t// ${marker}\n\t// Retire the obsolete legacy mirror on every normal write so it cannot survive a delete,\n\t// reload, or later whole-database save and be promoted back into canonical Schedule state.\n\tbody.trainingSchedules = [];`,
  );
}

for (const required of [
  marker,
  "persistedShape.trainingSchedules = [];",
  "body.trainingSchedules = [];",
]) {
  if (!source.includes(required)) throw new Error(`Legacy Schedule retirement invariant missing: ${required}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_LEGACY_TRAINING_SCHEDULES_RETIRED_OK');
