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

const shapeFunction = `function hasRecognizedDatabaseShape(payload) {\n  return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload)\n    && CORE_DB_COLLECTIONS.some((key) => Array.isArray(payload[key]));\n}\nfunction assertNoCatastrophicDataShrink(current, incoming) {\n  const currentCount = coreRecordCount(current);\n  const incomingCount = coreRecordCount(incoming);\n  if (currentCount >= 20 && incomingCount < Math.ceil(currentCount * 0.2)) {\n    const error = new Error(\`Refusing database replacement that would shrink recognized records from \${currentCount} to \${incomingCount}. Use an explicit controlled bulk-deletion/recovery workflow.\`);\n    error.code = 'ATHLYRAX_DB_CATASTROPHIC_SHRINK_BLOCKED';\n    throw error;\n  }\n}\n`;
if (!source.includes('function hasRecognizedDatabaseShape(')) {
  const anchor = `function assertNoTotalDataWipe(current, incoming) {`;
  if (!source.includes(anchor)) throw new Error('Database-shape helper anchor was not found.');
  source = source.replace(anchor, `${shapeFunction}${anchor}`);
} else if (!source.includes('function assertNoCatastrophicDataShrink(')) {
  const anchor = `function assertNoTotalDataWipe(current, incoming) {`;
  if (!source.includes(anchor)) throw new Error('Catastrophic-shrink helper anchor was not found.');
  source = source.replace(anchor, `function assertNoCatastrophicDataShrink(current, incoming) {\n  const currentCount = coreRecordCount(current);\n  const incomingCount = coreRecordCount(incoming);\n  if (currentCount >= 20 && incomingCount < Math.ceil(currentCount * 0.2)) {\n    const error = new Error(\`Refusing database replacement that would shrink recognized records from \${currentCount} to \${incomingCount}. Use an explicit controlled bulk-deletion/recovery workflow.\`);\n    error.code = 'ATHLYRAX_DB_CATASTROPHIC_SHRINK_BLOCKED';\n    throw error;\n  }\n}\n${anchor}`);
}

const incomingInvalidAnchor = `    if (!incoming) {\n      const error = new Error(\`Refusing database replacement because the incoming database is unreadable or invalid JSON: \${source}\`);\n      error.code = 'ATHLYRAX_INCOMING_DB_INVALID';\n      throw error;\n    }`;
const incomingShapeGuard = `${incomingInvalidAnchor}\n    if (!hasRecognizedDatabaseShape(incoming)) {\n      const error = new Error(\`Refusing database replacement because the incoming object has no recognized AthlyraX data collections: \${source}\`);\n      error.code = 'ATHLYRAX_DB_SHAPE_INVALID';\n      throw error;\n    }`;
if (!source.includes(`error.code = 'ATHLYRAX_DB_SHAPE_INVALID'`)) {
  if (!source.includes(incomingInvalidAnchor)) throw new Error('Incoming database validation anchor was not found.');
  source = source.replace(incomingInvalidAnchor, incomingShapeGuard);
}

if (!source.includes('assertNoCatastrophicDataShrink(current, incoming);')) {
  const rollbackAwareGuard = `      assertTenantIdentity(current, destination, env, 'Current database');\n      if (!rollbackAuthorized) assertNoTotalDataWipe(current, incoming);`;
  const rollbackAwareReplacement = `      assertTenantIdentity(current, destination, env, 'Current database');\n      if (!rollbackAuthorized) {\n        assertNoTotalDataWipe(current, incoming);\n        assertNoCatastrophicDataShrink(current, incoming);\n      }`;
  const legacyGuard = `      assertTenantIdentity(current, destination, env, 'Current database');\n      assertNoTotalDataWipe(current, incoming);`;
  const legacyReplacement = `${legacyGuard}\n      assertNoCatastrophicDataShrink(current, incoming);`;
  if (source.includes(rollbackAwareGuard)) source = source.replace(rollbackAwareGuard, rollbackAwareReplacement);
  else if (source.includes(legacyGuard)) source = source.replace(legacyGuard, legacyReplacement);
  else throw new Error('Database shrink guard insertion anchor was not found.');
}

const criticalFunction = `function assertNoCriticalStoreWipe(current, incoming, kind) {\n  if (kind === 'snapshot-submissions' && Array.isArray(current) && current.length > 0 && Array.isArray(incoming) && incoming.length === 0) {\n    const error = new Error('Refusing to replace non-empty snapshot history with an empty history. Use an explicit controlled reset procedure.');\n    error.code = 'ATHLYRAX_SNAPSHOT_HISTORY_EMPTY_WIPE_BLOCKED';\n    throw error;\n  }\n}`;
const strongCriticalFunction = `function assertNoCriticalStoreWipe(current, incoming, kind) {\n  if (kind === 'snapshot-submissions' && Array.isArray(current) && current.length > 0 && Array.isArray(incoming) && incoming.length === 0) {\n    const error = new Error('Refusing to replace non-empty snapshot history with an empty history. Use an explicit controlled reset procedure.');\n    error.code = 'ATHLYRAX_SNAPSHOT_HISTORY_EMPTY_WIPE_BLOCKED';\n    throw error;\n  }\n  if (kind === 'snapshot-submissions' && Array.isArray(current) && Array.isArray(incoming) && incoming.length < current.length) {\n    const error = new Error('Refusing to shrink snapshot submission history during ordinary persistence. Use an explicit controlled retention/reset procedure.');\n    error.code = 'ATHLYRAX_SNAPSHOT_HISTORY_SHRINK_BLOCKED';\n    throw error;\n  }\n  if (kind === 'auth-invites' && Array.isArray(current) && Array.isArray(incoming) && incoming.length < current.length) {\n    const error = new Error('Refusing to shrink authentication invite history during ordinary persistence.');\n    error.code = 'ATHLYRAX_AUTH_INVITE_HISTORY_SHRINK_BLOCKED';\n    throw error;\n  }\n  if ((kind === 'auth-users' || kind === 'auth-users-backup')) {\n    const currentUsers = Array.isArray(current) ? current : (current && Array.isArray(current.users) ? current.users : []);\n    const incomingUsers = Array.isArray(incoming) ? incoming : (incoming && Array.isArray(incoming.users) ? incoming.users : []);\n    if (incomingUsers.length < currentUsers.length - 1) {\n      const error = new Error('Refusing authentication-store replacement that removes more than one account in a single ordinary operation.');\n      error.code = 'ATHLYRAX_AUTH_STORE_CATASTROPHIC_SHRINK_BLOCKED';\n      throw error;\n    }\n  }\n}`;
if (source.includes(criticalFunction)) source = source.replace(criticalFunction, strongCriticalFunction);
else if (!source.includes(`ATHLYRAX_SNAPSHOT_HISTORY_SHRINK_BLOCKED`)) throw new Error('Critical-store shrink guard anchor was not found.');

for (const required of ['coaches', 'documents', 'seasonPlans', 'timetables', 'notifications', 'trainingPlannerWeeks']) {
  if (!source.includes(`'${required}'`)) throw new Error(`Total-wipe guard is missing collection ${required}.`);
}
for (const required of [
  'hasRecognizedDatabaseShape', 'ATHLYRAX_DB_SHAPE_INVALID', 'ATHLYRAX_DB_CATASTROPHIC_SHRINK_BLOCKED',
  'ATHLYRAX_SNAPSHOT_HISTORY_EMPTY_WIPE_BLOCKED', 'ATHLYRAX_SNAPSHOT_HISTORY_SHRINK_BLOCKED',
  'ATHLYRAX_AUTH_INVITE_HISTORY_SHRINK_BLOCKED', 'ATHLYRAX_AUTH_STORE_CATASTROPHIC_SHRINK_BLOCKED',
]) if (!source.includes(required)) throw new Error(`Data-safety guard is missing ${required}.`);
if (source.includes('rollbackAuthorized') && !source.includes(`if (!rollbackAuthorized) {\n        assertNoTotalDataWipe(current, incoming);\n        assertNoCatastrophicDataShrink(current, incoming);`)) {
  throw new Error('Authorized rollback must be the only path that bypasses total-wipe/catastrophic-shrink guards.');
}

fs.writeFileSync(filePath, source, 'utf8');
console.log('DATA_SAFETY_COLLECTION_COVERAGE_OK');
