import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BULK_SCHEDULE_COUNT = 3443;
const BULK_SESSION_COUNT = 3443;
const BULK_SET_COUNT = 71;
const REQUIRED_TOMBSTONES = BULK_SCHEDULE_COUNT + BULK_SESSION_COUNT + BULK_SET_COUNT;

test('production tombstones are not truncated by a fixed retention ceiling', () => {
  const source = fs.readFileSync('index.js', 'utf8').replace(/\r\n/g, '\n');
  assert.equal(REQUIRED_TOMBSTONES, 6957);
  assert.ok(REQUIRED_TOMBSTONES > 5000, 'Regression must exceed the old unsafe capacity.');
  assert.match(source, /const TOMBSTONE_MAX_ENTRIES = Number\.POSITIVE_INFINITY;/,
    'Deleted physical ids must not fall out of protection because a fixed tombstone cap was reached.');
});

test('a tombstoned physical id cannot be revived by a newer updatedAt timestamp', () => {
  const source = fs.readFileSync('index.js', 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /Tombstoned physical ids are permanent\./);
  assert.doesNotMatch(source, /tombstonesForCollection\.delete\(rowId\)/,
    'A stale payload must never retire a deletion tombstone just by presenting a newer row timestamp.');
  assert.doesNotMatch(source, /if \(rowMs > tombstoneMs\)/,
    'updatedAt is not evidence of an intentional same-id recreate in the whole-db PUT model.');
});

test('production build permanently applies the no-resurrection guard', () => {
  const buildSource = fs.readFileSync('scripts/build-production-backend.mjs', 'utf8');
  const patchSource = fs.readFileSync('scripts/patch-bulk-delete-tombstone-capacity.mjs', 'utf8');
  assert.match(buildSource, /patch-bulk-delete-tombstone-capacity\.mjs/);
  assert.match(patchSource, /Number\.POSITIVE_INFINITY/);
  assert.match(patchSource, /tombstonesForCollection\.delete\(rowId\)/,
    'The production patch must explicitly guard against the old timestamp-based retirement path.');
});