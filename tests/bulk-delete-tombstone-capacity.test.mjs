import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BULK_SCHEDULE_COUNT = 3443;
const BULK_SESSION_COUNT = 3443;
const BULK_SET_COUNT = 71;
const REQUIRED_TOMBSTONES = BULK_SCHEDULE_COUNT + BULK_SESSION_COUNT + BULK_SET_COUNT;

test('production tombstone capacity retains the complete 3443-session destructive delete', () => {
  const source = fs.readFileSync('index.js', 'utf8').replace(/\r\n/g, '\n');
  const match = source.match(/const TOMBSTONE_MAX_ENTRIES = (\d+);/);
  assert.ok(match, 'Backend tombstone capacity constant is missing.');
  const capacity = Number(match[1]);
  assert.equal(REQUIRED_TOMBSTONES, 6957);
  assert.ok(REQUIRED_TOMBSTONES > 5000, 'Regression must exceed the old unsafe capacity.');
  assert.ok(capacity >= 20000, `Backend tombstone capacity ${capacity} is too small for durable bulk deletion.`);
  assert.ok(REQUIRED_TOMBSTONES < capacity, 'The full Schedule + Training Session + set deletion must fit without truncation.');
});

test('production build permanently applies the tombstone capacity guard', () => {
  const buildSource = fs.readFileSync('scripts/build-production-backend.mjs', 'utf8');
  const patchSource = fs.readFileSync('scripts/patch-bulk-delete-tombstone-capacity.mjs', 'utf8');
  assert.match(buildSource, /patch-bulk-delete-tombstone-capacity\.mjs/);
  assert.match(patchSource, /TOMBSTONE_MAX_ENTRIES = 5000/);
  assert.match(patchSource, /TOMBSTONE_MAX_ENTRIES = 20000/);
});
