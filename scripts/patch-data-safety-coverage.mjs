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

for (const required of ['coaches', 'documents', 'seasonPlans', 'timetables', 'notifications', 'trainingPlannerWeeks']) {
  if (!source.includes(`'${required}'`)) throw new Error(`Total-wipe guard is missing collection ${required}.`);
}

fs.writeFileSync(filePath, source, 'utf8');
console.log('DATA_SAFETY_COLLECTION_COVERAGE_OK');
