import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('scripts/data-safety-preload.mjs');
let source = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

const oldBlock = `const CORE_DB_COLLECTIONS = Object.freeze([\n  'swimmers', 'squads', 'trainingSessions', 'trainingSessionSets', 'tests', 'attendance',\n  'competitions', 'fixtures', 'groups', 'trainingPlannerWeeks',\n]);`;
const newBlock = `const CORE_DB_COLLECTIONS = Object.freeze([\n  'coaches', 'squads', 'swimmers', 'venues', 'sessionTypes', 'timetables', 'timetableSlots', 'schedule',\n  'trainingSessions', 'trainingSessionSets', 'templateSets', 'templateTests', 'trainingSetBlocks',\n  'seasonPlans', 'mesoCycles', 'microCycles', 'attendance', 'tests', 'competitions', 'fixtures', 'groups',\n  'seasons', 'trainingPlannerWeeks', 'conflictResolutions', 'changeLog', 'auditLog', 'notifications', 'documents',\n]);`;

if (!source.includes(newBlock)) {
  if (!source.includes(oldBlock)) throw new Error('Data-safety collection coverage anchor was not found.');
  source = source.replace(oldBlock, newBlock);
}

const shapeFunction = `function hasRecognizedDatabaseShape(payload) {\n  return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload)\n    && CORE_DB_COLLECTIONS.some((key) => Array.isArray(payload[key]));\n}\n`;
if (!source.includes('function hasRecognizedDatabaseShape(')) {
  const anchor = `function assertNoTotalDataWipe(current, incoming) {`;
  if (!source.includes(anchor)) throw new Error('Database-shape helper anchor was not found.');
  source = source.replace(anchor, `${shapeFunction}${anchor}`);
}

const incomingInvalidAnchor = `    if (!incoming) {\n      const error = new Error(\`Refusing database replacement because the incoming database is unreadable or invalid JSON: \${source}\`);\n      error.code = 'ATHLYRAX_INCOMING_DB_INVALID';\n      throw error;\n    }`;
const incomingShapeGuard = `${incomingInvalidAnchor}\n    if (!hasRecognizedDatabaseShape(incoming)) {\n      const error = new Error(\`Refusing database replacement because the incoming object has no recognized AthlyraX data collections: \${source}\`);\n      error.code = 'ATHLYRAX_DB_SHAPE_INVALID';\n      throw error;\n    }`;
if (!source.includes(`error.code = 'ATHLYRAX_DB_SHAPE_INVALID'`)) {
  if (!source.includes(incomingInvalidAnchor)) throw new Error('Incoming database validation anchor was not found.');
  source = source.replace(incomingInvalidAnchor, incomingShapeGuard);
}

for (const required of ['coaches', 'documents', 'seasonPlans', 'timetables', 'notifications', 'trainingPlannerWeeks']) {
  if (!source.includes(`'${required}'`)) throw new Error(`Total-wipe guard is missing collection ${required}.`);
}
for (const required of ['hasRecognizedDatabaseShape', 'ATHLYRAX_DB_SHAPE_INVALID']) {
  if (!source.includes(required)) throw new Error(`Database-shape guard is missing ${required}.`);
}

fs.writeFileSync(filePath, source, 'utf8');
console.log('DATA_SAFETY_COLLECTION_COVERAGE_OK');
