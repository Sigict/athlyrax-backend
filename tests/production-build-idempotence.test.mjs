import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('production start does not rerun one-shot transforms over an already hardened backend', () => {
  const start = read('scripts/production-start.mjs');
  assert.match(start, /function runtimeAlreadyHardened\(\)/);
  assert.match(start, /if \(!runtimeAlreadyHardened\(\)\)/);
  assert.match(start, /Production runtime hardening build/);
  assert.match(start, /build-production-backend\.mjs/);
  assert.match(start, /ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_V1/);
  assert.match(start, /ATHLYRAX_SCHEDULE_DELETE_BLOCK_INTEGRITY_V1/);
  assert.match(start, /ATHLYRAX_SCHEDULE_SUPPRESSION_BLOCK_OWNER_INTEGRITY_V1/);
  assert.match(start, /const TOMBSTONE_MAX_ENTRIES = Number\.POSITIVE_INFINITY;/);

  const conditionIndex = start.indexOf('if (!runtimeAlreadyHardened())');
  const buildIndex = start.indexOf("'Production runtime hardening build'");
  assert.ok(conditionIndex >= 0 && buildIndex > conditionIndex,
    'the one-shot build must execute only when hardened runtime markers are absent');
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
    'ATHLYRAX_LEGACY_TRAINING_SCHEDULES_RETIRED_V1',
  ]) {
    assert.ok(source.includes(token), `installed backend is missing production-start marker: ${token}`);
  }
});
