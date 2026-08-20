import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('index.js'), 'utf8').replace(/\r\n/g, '\n');

assert.match(source, /ATHLYRAX_RETIRE_LEGACY_TRAINING_SCHEDULES_V1/);
assert.match(source, /persistedShape\.trainingSchedules = \[\];/);
assert.match(source, /body\.trainingSchedules = \[\];/);

const getParseIndex = source.indexOf("const persistedShape = JSON.parse(String(data || '{}'));");
const getRetireIndex = source.indexOf('persistedShape.trainingSchedules = [];', getParseIndex);
const getSuppressionIndex = source.indexOf('applyScheduleOccurrenceSuppressionsToDbShape(persistedShape', getParseIndex);
assert.ok(getParseIndex >= 0, 'GET /db persisted-shape parse anchor missing');
assert.ok(getRetireIndex > getParseIndex, 'GET /db must retire trainingSchedules after parsing');
assert.ok(getSuppressionIndex > getRetireIndex, 'GET /db must retire trainingSchedules before response suppression/filtering');

const putRouteIndex = source.indexOf("app.put('/db', requireAuth, requireWriteRole, requireBillingWriteAccess");
const putValidationIndex = source.indexOf("Invalid payload. Expected JSON object.", putRouteIndex);
const putRetireIndex = source.indexOf('body.trainingSchedules = [];', putValidationIndex);
const putWriteIndex = source.indexOf('writeAtomicJsonFile(storagePaths.dbPath, ownershipStampedBody);', putRetireIndex);
assert.ok(putRouteIndex >= 0, 'PUT /db route missing');
assert.ok(putRetireIndex > putValidationIndex, 'PUT /db must retire trainingSchedules after validating the payload');
assert.ok(putWriteIndex > putRetireIndex, 'PUT /db must retire trainingSchedules before persistence');

console.log('LEGACY_TRAINING_SCHEDULES_RETIREMENT_OK');
