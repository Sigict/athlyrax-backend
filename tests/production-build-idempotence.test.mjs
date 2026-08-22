import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('production start never reruns source transforms and fails closed when hardening is missing', () => {
  const start = read('scripts/production-start.mjs');
  assert.match(start, /function runtimeAlreadyHardened\(\)/);
  assert.match(start, /if \(!runtimeAlreadyHardened\(\)\)/);
  assert.match(start, /ATHLYRAX_PRODUCTION_START_REQUIRES_PREBUILT_RUNTIME/);
  assert.match(start, /Refusing startup instead of mutating source/);
  assert.match(start, /package postinstall runs scripts\/build-production-backend\.mjs/);
  assert.doesNotMatch(start, /'Production runtime hardening build'/);
  assert.doesNotMatch(start, /\[path\.join\(sourceRoot, 'scripts', 'build-production-backend\.mjs'\)\]/);
  assert.match(start, /ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_V1/);
  assert.match(start, /ATHLYRAX_SCHEDULE_DELETE_BLOCK_INTEGRITY_V1/);
  assert.match(start, /ATHLYRAX_SCHEDULE_SUPPRESSION_BLOCK_OWNER_INTEGRITY_V1/);
  assert.match(start, /ATHLYRAX_RETIRE_LEGACY_TRAINING_SCHEDULES_V1/);
  assert.match(start, /const TOMBSTONE_MAX_ENTRIES = Number\.POSITIVE_INFINITY;/);
});

test('the installed backend currently satisfies every production-start hardened marker', () => {
  const source = read('index.js');
  for (const token of [
    'installSignupLegalAcceptanceGuard(express);',
    'ATHLYRAX_CANONICAL_STORAGE_RUNTIME_GUARD',
    'const TOMBSTONE_MAX_ENTRIES = Number.POSITIVE_INFINITY;',
    'Tombstoned physical ids are permanent.',
    'ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_V1',
    'ATHLYRAX_SCHEDULE_DELETE_BLOCK_INTEGRITY_V1',
    'ATHLYRAX_SCHEDULE_SUPPRESSION_BLOCK_OWNER_INTEGRITY_V1',
    'ATHLYRAX_RETIRE_LEGACY_TRAINING_SCHEDULES_V1',
  ]) {
    assert.ok(source.includes(token), `installed backend is missing production-start marker: ${token}`);
  }
});

test('safe-start validates the actual legacy trainingSchedules retirement invariant used by the installed backend', () => {
  const safeStart = read('scripts/safe-start.mjs');
  assert.match(safeStart, /ATHLYRAX_RETIRE_LEGACY_TRAINING_SCHEDULES_V1/);
  assert.match(safeStart, /body\.trainingSchedules = \[\];/);
  assert.match(safeStart, /parsedDatabase\.trainingSchedules = \[\];/);
  assert.match(safeStart, /persistedShape\.trainingSchedules = \[\];/);
  assert.doesNotMatch(
    safeStart,
    /source\.includes\('trainingSchedules: \[\]'\)/,
    'safe-start must not reject the transformed backend for an unrelated object-literal spelling',
  );

  const installed = read('index.js');
  assert.ok(installed.includes('ATHLYRAX_RETIRE_LEGACY_TRAINING_SCHEDULES_V1'));
  assert.ok(installed.includes('body.trainingSchedules = [];'));
  assert.ok(
    installed.includes('parsedDatabase.trainingSchedules = [];')
      || installed.includes('persistedShape.trainingSchedules = [];'),
    'installed backend must retire the legacy mirror on GET /db',
  );
});
