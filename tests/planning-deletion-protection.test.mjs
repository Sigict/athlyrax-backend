/**
 * Regression tests for the planning-persistence deletion-protection layer.
 *
 * Covers:
 *   1. A row tombstoned in the previous PUT is dropped from an incoming PUT
 *      that still contains it (deletion resurrection is blocked).
 *   2. A tombstoned row that has been legitimately re-created (updatedAt >
 *      deletedAt) is NOT dropped (users can un-delete by re-creating).
 *   3. Tombstones are additive across writes (union, latest wins).
 *   4. Attendance rows pointing at a timetable template id (not a schedule
 *      id) cause the whole PUT to be rejected with HTTP 400.
 *   5. Attendance rows with a missing scheduleId are rejected.
 *
 * These are executed as pure unit tests against the helper functions
 * exported below via a small dynamic-import shim, because the whole server
 * lives in one file and starting Express-with-storage-safety-guards is
 * expensive. If any function is renamed, this test will fail closed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_JS_PATH = path.join(__dirname, '..', 'index.js');

// Read the source, extract the helper block we added, and evaluate it in an
// isolated function scope. This avoids booting the whole Express app just to
// unit-test pure helpers, while still guaranteeing we're testing the exact
// bytes shipped in index.js.
function loadHelpersFromIndex() {
	const source = fs.readFileSync(INDEX_JS_PATH, 'utf8');
	const startMarker = '// Tombstone-based deletion protection.';
	const endMarker = 'function applyOwnershipMetadataToDbShape(dbShape, existingDbShape, auth) {';
	const startIdx = source.indexOf(startMarker);
	const endIdx = source.indexOf(endMarker);
	if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
		throw new Error(`Could not locate tombstone helper block in ${INDEX_JS_PATH}. Refactored?`);
	}
	const block = source.slice(startIdx, endIdx);
	// The block relies on `toRowId`. Grab that too.
	const toRowIdMatch = source.match(/function toRowId\(value\) \{[\s\S]*?\n\}/);
	if (!toRowIdMatch) throw new Error('toRowId helper not found in index.js');
	const evalSource = `
		${toRowIdMatch[0]}
		${block}
		return {
			normalizeTombstoneEntry,
			mergeTombstoneLists,
			buildTombstoneLookup,
			applyTombstonesToDbShape,
			collectAttendanceLinkageViolations,
			TOMBSTONE_TRACKED_COLLECTION_KEYS,
		};
	`;
	// eslint-disable-next-line no-new-func
	return new Function(evalSource)();
}

const helpers = loadHelpersFromIndex();

// -------------------------------------------------------------------------
test('mergeTombstoneLists returns union with latest deletedAt winning per (collection,id)', () => {
	const existing = [
		{ collection: 'schedule', id: 'sch_a', deletedAt: '2026-01-01T00:00:00.000Z', deletedBy: 'alice' },
		{ collection: 'schedule', id: 'sch_b', deletedAt: '2026-01-01T00:00:00.000Z', deletedBy: 'alice' },
	];
	const incoming = [
		{ collection: 'schedule', id: 'sch_a', deletedAt: '2026-02-01T00:00:00.000Z', deletedBy: 'bob' }, // newer
		{ collection: 'schedule', id: 'sch_c', deletedAt: '2026-01-15T00:00:00.000Z', deletedBy: 'bob' }, // new
	];
	const merged = helpers.mergeTombstoneLists(existing, incoming);
	assert.equal(merged.length, 3);
	const a = merged.find((m) => m.id === 'sch_a');
	assert.equal(a.deletedAt, '2026-02-01T00:00:00.000Z');
	assert.equal(a.deletedBy, 'bob');
});

test('mergeTombstoneLists rejects entries for collections not on the tracked list', () => {
	const merged = helpers.mergeTombstoneLists([], [
		{ collection: 'not-a-real-collection', id: 'x', deletedAt: '2026-01-01T00:00:00.000Z' },
	]);
	assert.equal(merged.length, 0);
});

test('applyTombstonesToDbShape drops resurrected rows and reports them', () => {
	const tombstones = [
		{ collection: 'schedule', id: 'sch_dead', deletedAt: '2026-05-01T12:00:00.000Z' },
	];
	const lookup = helpers.buildTombstoneLookup(tombstones);
	const dbShape = {
		schedule: [
			{ id: 'sch_alive', scheduleDate: '2026-05-01', updatedAt: '2026-05-01T13:00:00.000Z' },
			{ id: 'sch_dead', scheduleDate: '2026-05-02', updatedAt: '2026-04-30T09:00:00.000Z' }, // older than tombstone
		],
	};
	const { dbShape: next, blockedResurrections } = helpers.applyTombstonesToDbShape(dbShape, lookup);
	assert.equal(next.schedule.length, 1, 'dead schedule row must be dropped');
	assert.equal(next.schedule[0].id, 'sch_alive');
	assert.deepEqual(blockedResurrections, [{ collection: 'schedule', id: 'sch_dead' }]);
});

test('applyTombstonesToDbShape KEEPS a row that was legitimately re-created after the tombstone', () => {
	const tombstones = [
		{ collection: 'timetable', id: 'tt_x', deletedAt: '2026-05-01T12:00:00.000Z' },
	];
	const lookup = helpers.buildTombstoneLookup(tombstones);
	const dbShape = {
		timetable: [
			{ id: 'tt_x', updatedAt: '2026-05-02T09:00:00.000Z' }, // recreated 21h after tombstone
		],
	};
	const { dbShape: next, blockedResurrections } = helpers.applyTombstonesToDbShape(dbShape, lookup);
	assert.equal(next.timetable.length, 1, 'legitimately-recreated row must be kept');
	assert.equal(blockedResurrections.length, 0);
});

test('applyTombstonesToDbShape handles rows without ids gracefully', () => {
	const lookup = helpers.buildTombstoneLookup([{ collection: 'schedule', id: 'sch_dead', deletedAt: '2026-01-01T00:00:00.000Z' }]);
	const dbShape = { schedule: [{ id: '', someField: 'no-id' }, { id: 'sch_dead' }] };
	const { dbShape: next, blockedResurrections } = helpers.applyTombstonesToDbShape(dbShape, lookup);
	assert.equal(next.schedule.length, 1);
	assert.equal(next.schedule[0].someField, 'no-id');
	assert.equal(blockedResurrections.length, 1);
});

test('collectAttendanceLinkageViolations flags attendance with missing scheduleId', () => {
	const violations = helpers.collectAttendanceLinkageViolations({
		attendance: [{ id: 'att_1', swimmerId: 'swm_1' }],
		schedule: [],
	});
	assert.equal(violations.length, 1);
	assert.equal(violations[0].reason, 'missing_scheduleId');
});

test('collectAttendanceLinkageViolations flags attendance pointing at a timetable template id', () => {
	const violations = helpers.collectAttendanceLinkageViolations({
		attendance: [{ id: 'att_1', swimmerId: 'swm_1', scheduleId: 'tt_template' }],
		schedule: [{ id: 'sch_real' }],
		timetable: [{ id: 'tt_template' }],
	});
	assert.equal(violations.length, 1);
	assert.equal(violations[0].reason, 'points_at_timetable_template');
	assert.equal(violations[0].scheduleId, 'tt_template');
});

test('collectAttendanceLinkageViolations returns [] for correct linkage', () => {
	const violations = helpers.collectAttendanceLinkageViolations({
		attendance: [{ id: 'att_1', swimmerId: 'swm_1', scheduleId: 'sch_real' }],
		schedule: [{ id: 'sch_real' }],
		timetable: [{ id: 'tt_template' }],
	});
	assert.deepEqual(violations, []);
});

test('applyTombstonesToDbShape is a no-op when tombstone list is empty', () => {
	const lookup = helpers.buildTombstoneLookup([]);
	const dbShape = { schedule: [{ id: 'sch_a' }, { id: 'sch_b' }] };
	const { dbShape: next, blockedResurrections } = helpers.applyTombstonesToDbShape(dbShape, lookup);
	assert.equal(next.schedule.length, 2);
	assert.equal(blockedResurrections.length, 0);
});

test('TOMBSTONE_TRACKED_COLLECTION_KEYS includes both legacy timetable and canonical timetableSlots', () => {
	assert.ok(helpers.TOMBSTONE_TRACKED_COLLECTION_KEYS.includes('timetable'), 'legacy singular must be tracked (real production shape)');
	assert.ok(helpers.TOMBSTONE_TRACKED_COLLECTION_KEYS.includes('timetableSlots'), 'canonical shape must be tracked (post-migration)');
	assert.ok(helpers.TOMBSTONE_TRACKED_COLLECTION_KEYS.includes('schedule'));
	assert.ok(helpers.TOMBSTONE_TRACKED_COLLECTION_KEYS.includes('attendance'));
});
