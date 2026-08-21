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

test('production startup refuses to boot if permanent deletion runtime invariants are absent', () => {
  const safeStart = fs.readFileSync('scripts/safe-start.mjs', 'utf8');
  assert.match(safeStart, /assertPermanentDeletionRuntimeContract\(indexSource\)/,
    'Safe-start must validate the transformed runtime instead of trusting postinstall implicitly.');
  assert.match(safeStart, /ATHLYRAX_PERMANENT_DELETE_GUARD_MISSING/);
  assert.match(safeStart, /TOMBSTONE_MAX_ENTRIES = Number\.POSITIVE_INFINITY/);
  assert.match(safeStart, /tombstonesForCollection\.delete\(rowId\)/,
    'Safe-start must explicitly reject the old same-id tombstone-retirement path.');
  assert.match(safeStart, /if \(rowMs > tombstoneMs\)/,
    'Safe-start must explicitly reject timestamp-based resurrection.');
  assert.match(safeStart, /app\.post\('\/db\/schedule-delete'/,
    'Safe-start must require the authoritative Scheduled Session deletion endpoint.');
  assert.match(safeStart, /Server-authoritative schedule deletion verification failed after persistence reread/,
    'Safe-start must require persisted reread verification.');
  assert.match(safeStart, /trainingSchedules: \[\]/,
    'Safe-start must require retirement of the legacy Schedule mirror at the persistence boundary.');
});
