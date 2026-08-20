import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('index.js'), 'utf8').replace(/\r\n/g, '\n');

assert.match(source, /ATHLYRAX_RETIRE_LEGACY_TRAINING_SCHEDULES_V1/);
assert.match(source, /body\.trainingSchedules = \[\];/);
assert.ok(
  source.includes('parsedDatabase.trainingSchedules = [];')
    || source.includes('persistedShape.trainingSchedules = [];'),
  'GET /db must retire the legacy trainingSchedules mirror.',
);

const getRouteIndex = source.indexOf("app.get('/db', requireAuth");
const hardenedParseIndex = source.indexOf("parsedDatabase = JSON.parse(String(data || ''));", getRouteIndex);
const rawParseIndex = source.indexOf("const persistedShape = JSON.parse(String(data || '{}'));", getRouteIndex);
const getParseIndex = hardenedParseIndex >= 0 ? hardenedParseIndex : rawParseIndex;
const getRetireIndex = source.indexOf(
  hardenedParseIndex >= 0 ? 'parsedDatabase.trainingSchedules = [];' : 'persistedShape.trainingSchedules = [];',
  getParseIndex,
);
const getSuppressionIndex = source.indexOf('applyScheduleOccurrenceSuppressionsToDbShape(', getRetireIndex);
assert.ok(getRouteIndex >= 0, 'GET /db route missing');
assert.ok(getParseIndex >= 0, 'GET /db database parse anchor missing');
assert.ok(getRetireIndex > getParseIndex, 'GET /db must retire trainingSchedules after parsing');
assert.ok(getSuppressionIndex > getRetireIndex, 'GET /db must retire trainingSchedules before response suppression/filtering');

const putRouteIndex = source.indexOf("app.put('/db', requireAuth, requireWriteRole, requireBillingWriteAccess");
const putValidationIndex = source.indexOf("Invalid payload. Expected JSON object.", putRouteIndex);
const putRetireIndex = source.indexOf('body.trainingSchedules = [];', putValidationIndex);
const putWriteIndex = source.indexOf('writeAtomicJsonFile(storagePaths.dbPath, ownershipStampedBody);', putRetireIndex);
assert.ok(putRouteIndex >= 0, 'PUT /db route missing');
assert.ok(putRetireIndex > putValidationIndex, 'PUT /db must retire trainingSchedules after validating the payload');
assert.ok(putWriteIndex > putRetireIndex, 'PUT /db must retire trainingSchedules before persistence');

const legacyOnlyDb = {
  trainingSchedules: [
    { id: 'legacy-1', scheduleDate: '2026-08-21', startTime: '06:00', endTime: '07:00' },
  ],
  schedule: [],
};
const readShape = structuredClone(legacyOnlyDb);
readShape.trainingSchedules = [];
assert.equal(readShape.schedule.length, 0);
assert.equal(readShape.trainingSchedules.length, 0);

const incomingWrite = structuredClone(legacyOnlyDb);
incomingWrite.trainingSchedules = [];
assert.equal(incomingWrite.schedule.length, 0);
assert.equal(incomingWrite.trainingSchedules.length, 0);

console.log('LEGACY_TRAINING_SCHEDULES_RETIREMENT_OK');
