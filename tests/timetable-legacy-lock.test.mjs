/**
 * Regression tests for TIMETABLE_LEGACY_LOCK_V1.
 *
 * Once a tenant DB has been migrated to the canonical shape
 * (__meta.timetableSlotsLegacyMigrationVersion >= 5), any subsequent write
 * that puts rows back into the legacy `timetable[]` collection must be
 * refused. This test proves the invariant with the helper function loaded
 * from index.js — same tactic as the deletion-protection tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_JS_PATH = path.join(__dirname, '..', 'index.js');

function loadLockHelper() {
  const source = fs.readFileSync(INDEX_JS_PATH, 'utf8');
  const start = source.indexOf('// [TIMETABLE_LEGACY_LOCK_V1] Timetable legacy-shape lock.');
  const end = source.indexOf('function applyOwnershipMetadataToDbShape(dbShape, existingDbShape, auth) {');
  if (start < 0 || end < 0 || end <= start) throw new Error('legacy lock block not found');
  const block = source.slice(start, end);
  const evalSource = `
    ${block}
    return { collectTimetableLegacyLockViolations, TIMETABLE_LEGACY_LOCK_MIN_VERSION };
  `;
  // eslint-disable-next-line no-new-func
  return new Function(evalSource)();
}

const helper = loadLockHelper();

test('lock is inactive when migration version < 5 (pre-migration tenants unaffected)', () => {
  const existing = { __meta: { timetableSlotsLegacyMigrationVersion: 3 } };
  const incoming = { timetable: [{ id: 'row1' }] };
  const violations = helper.collectTimetableLegacyLockViolations(existing, incoming);
  assert.deepEqual(violations, []);
});

test('lock is inactive when incoming timetable[] is empty (canonical write)', () => {
  const existing = { __meta: { timetableSlotsLegacyMigrationVersion: 5 } };
  const incoming = { timetable: [], timetableSlots: [{ id: 'slot1' }] };
  const violations = helper.collectTimetableLegacyLockViolations(existing, incoming);
  assert.deepEqual(violations, []);
});

test('lock REJECTS when tenant is migrated and incoming has rows in timetable[]', () => {
  const existing = { __meta: { timetableSlotsLegacyMigrationVersion: 5 } };
  const incoming = { timetable: [{ id: 'row1' }, { id: 'row2' }] };
  const violations = helper.collectTimetableLegacyLockViolations(existing, incoming);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'timetable_legacy_shape_locked');
  assert.equal(violations[0].existingMigrationVersion, 5);
  assert.equal(violations[0].incomingLegacyRowCount, 2);
});

test('lock is inactive when no migration version has ever been recorded', () => {
  const existing = { __meta: {} };
  const incoming = { timetable: [{ id: 'row1' }] };
  const violations = helper.collectTimetableLegacyLockViolations(existing, incoming);
  assert.deepEqual(violations, []);
});

test('lock catches attempted downgrade (client sends lower migration version)', () => {
  const existing = { __meta: { timetableSlotsLegacyMigrationVersion: 5 } };
  const incoming = {
    timetable: [{ id: 'x' }],
    __meta: { timetableSlotsLegacyMigrationVersion: 2 }, // client tries to lie
  };
  const violations = helper.collectTimetableLegacyLockViolations(existing, incoming);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].incomingMigrationVersion, 2);
  assert.equal(violations[0].existingMigrationVersion, 5);
});

test('lock minimum version constant matches migration script contract', () => {
  assert.equal(helper.TIMETABLE_LEGACY_LOCK_MIN_VERSION, 5,
    'must match migrateLegacyTimetableSlots.js version 5 -- if you bump the migration version, bump this too.');
});
