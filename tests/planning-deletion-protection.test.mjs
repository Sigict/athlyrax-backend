/**
 * Regression tests for the planning-persistence deletion-protection layer.
 *
 * Covers:
 *   1. A row tombstoned in the previous PUT is dropped from an incoming PUT
 *      that still contains it (deletion resurrection is blocked).
 *   2. A tombstoned row that has been legitimately re-created (updatedAt >
 *      deletedAt) is NOT dropped (users can un-delete by re-creating).
 *   3. Tombstones are additive across writes (union, latest wins).
 *   4. Semantic Schedule occurrence suppressions are additive across writes.
 *   5. A deleted generated occurrence cannot return under a fresh Schedule id.
 *   6. Blocking a regenerated occurrence also removes its linked Planner data.
 *   7. A different recurrence date and manual Schedule rows remain allowed.
 *   8. Attendance rows pointing at a timetable template id (not a schedule
 *      id) cause the whole PUT to be rejected with HTTP 400.
 *   9. Attendance rows with a missing scheduleId are rejected.
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
			getScheduleOccurrenceIdentityParts,
			getScheduleOccurrenceIdentityKey,
			normalizeScheduleOccurrenceSuppressionEntry,
			mergeScheduleOccurrenceSuppressionLists,
			applyScheduleOccurrenceSuppressionsToDbShape,
		};
	`;
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
		{ collection: 'schedule', id: 'sch_a', deletedAt: '2026-02-01T00:00:00.000Z', deletedBy: 'bob' },
		{ collection: 'schedule', id: 'sch_c', deletedAt: '2026-01-15T00:00:00.000Z', deletedBy: 'bob' },
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
			{ id: 'sch_dead', scheduleDate: '2026-05-02', updatedAt: '2026-04-30T09:00:00.000Z' },
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
			{ id: 'tt_x', updatedAt: '2026-05-02T09:00:00.000Z' },
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

test('semantic Schedule suppressions survive an incoming whole-db write that omits the old suppression', () => {
	const existing = [{
		sourceSlotId: 'slot_1',
		scheduleDate: '2026-08-19',
		timetableId: 'tt_1',
		deletedAt: '2026-08-19T00:10:00.000Z',
		deletedBy: 'scheduled-sessions-bulk-delete',
	}];
	const merged = helpers.mergeScheduleOccurrenceSuppressionLists(existing, []);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].sourceSlotId, 'slot_1');
	assert.equal(merged[0].scheduleDate, '2026-08-19');
	assert.equal(merged[0].timetableId, 'tt_1');
});

test('semantic Schedule suppression latest delete wins without changing occurrence identity', () => {
	const existing = [{ sourceSlotId: 'slot_1', scheduleDate: '2026-08-19', timetableId: 'tt_1', deletedAt: '2026-08-19T00:10:00.000Z', deletedBy: 'one' }];
	const incoming = [{ generatedSourceSlotId: 'slot_1', date: '2026-08-19', timetableSourceId: 'tt_1', deletedAt: '2026-08-19T00:20:00.000Z', deletedBy: 'two' }];
	const merged = helpers.mergeScheduleOccurrenceSuppressionLists(existing, incoming);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].deletedAt, '2026-08-19T00:20:00.000Z');
	assert.equal(merged[0].deletedBy, 'two');
});

test('server blocks a deleted generated occurrence recreated under a fresh Schedule id and removes linked Planner data', () => {
	const suppressions = [{
		sourceSlotId: 'slot_1',
		scheduleDate: '2026-08-19',
		timetableId: 'tt_1',
		deletedAt: '2026-08-19T00:10:00.000Z',
	}];
	const dbShape = {
		schedule: [
		{ id: 'schedule_new_id', generatedSourceSlotId: 'slot_1', scheduleDate: '2026-08-19', timetableId: 'tt_1' },
		{ id: 'schedule_later', generatedSourceSlotId: 'slot_1', scheduleDate: '2026-08-20', timetableId: 'tt_1' },
	],
		trainingSchedules: [
		{ id: 'legacy_new_id', generatedSourceSlotId: 'slot_1', scheduleDate: '2026-08-19', timetableId: 'tt_1' },
	],
		trainingSessions: [
		{ id: 'session_blocked', scheduleId: 'schedule_new_id' },
		{ id: 'session_later', scheduleId: 'schedule_later' },
		],
		trainingSessionSets: [
		{ id: 'set_blocked', sessionId: 'session_blocked' },
		{ id: 'set_later', sessionId: 'session_later' },
		],
		trainingSetBlocks: [
		{ id: 'block_blocked', sessionId: 'session_blocked', setIds: ['set_blocked'] },
		{ id: 'block_shared', sessionId: 'session_later', setIds: ['set_blocked', 'set_later'] },
		],
		attendance: [
		{ id: 'attendance_blocked', scheduleId: 'schedule_new_id' },
		{ id: 'attendance_later', scheduleId: 'schedule_later' },
		],
	};

	const result = helpers.applyScheduleOccurrenceSuppressionsToDbShape(dbShape, suppressions);
	assert.deepEqual(result.dbShape.schedule.map((row) => row.id), ['schedule_later']);
	assert.equal(result.dbShape.trainingSchedules.length, 0, 'legacy mirror must not retain the suppressed occurrence');
	assert.deepEqual(result.dbShape.trainingSessions.map((row) => row.id), ['session_later']);
	assert.deepEqual(result.dbShape.trainingSessionSets.map((row) => row.id), ['set_later']);
	assert.deepEqual(result.dbShape.trainingSetBlocks.map((row) => row.id), ['block_shared']);
	assert.deepEqual(result.dbShape.trainingSetBlocks[0].setIds, ['set_later']);
	assert.deepEqual(result.dbShape.attendance.map((row) => row.id), ['attendance_later']);
	assert.equal(result.blockedResurrections.some((row) => row.collection === 'schedule' && row.id === 'schedule_new_id'), true);
});

test('semantic Schedule suppression allows a later recurrence from the same Timetable slot', () => {
	const suppressions = [{ sourceSlotId: 'slot_1', scheduleDate: '2026-08-19', timetableId: 'tt_1', deletedAt: '2026-08-19T00:10:00.000Z' }];
	const dbShape = {
		schedule: [{ id: 'schedule_later', generatedSourceSlotId: 'slot_1', scheduleDate: '2026-08-20', timetableId: 'tt_1' }],
	};
	const result = helpers.applyScheduleOccurrenceSuppressionsToDbShape(dbShape, suppressions);
	assert.equal(result.dbShape.schedule.length, 1);
	assert.equal(result.blockedResurrections.length, 0);
});

test('semantic Schedule suppression does not block manual same-day Schedule rows without generated source identity', () => {
	const suppressions = [{ sourceSlotId: 'slot_1', scheduleDate: '2026-08-19', timetableId: 'tt_1', deletedAt: '2026-08-19T00:10:00.000Z' }];
	const dbShape = {
		schedule: [{ id: 'manual_same_day', scheduleDate: '2026-08-19', timetableId: 'tt_1', manualScheduleEntry: true }],
	};
	const result = helpers.applyScheduleOccurrenceSuppressionsToDbShape(dbShape, suppressions);
	assert.equal(result.dbShape.schedule.length, 1);
	assert.equal(result.blockedResurrections.length, 0);
});

test('semantic suppression merge retains 3443 deleted generated occurrences without truncation', () => {
	const suppressions = Array.from({ length: 3443 }, (_, index) => ({
		sourceSlotId: `slot_${index}`,
		scheduleDate: '2026-08-19',
		timetableId: 'tt_1',
		deletedAt: '2026-08-19T00:10:00.000Z',
	}));
	const merged = helpers.mergeScheduleOccurrenceSuppressionLists([], suppressions);
	assert.equal(merged.length, 3443);
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
