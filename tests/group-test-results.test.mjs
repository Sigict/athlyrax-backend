import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyScopedGroupTestSubmission, groupTestResultFingerprint } from '../group-test-results.mjs';

const db = () => ({
  squads: [{ id: 'sq', name: 'Squad' }, { id: 'other', name: 'Other' }],
  swimmers: [{ id: 'sw', name: 'Swimmer', currentSquadId: 'sq' }, { id: 'x', name: 'Other swimmer', currentSquadId: 'other' }],
  templateTests: [{ id: 'swim', name: 'Swim', testCategory: 'Swimming', rows: [{ label: '2x50', reps: 2, distance: 50 }] }],
  tests: [], trainingSessionSets: [],
});
const submit = (base, entries, extra = {}) => applyScopedGroupTestSubmission(base,
  { date: '2026-10-03', squadId: 'sq', templateId: 'swim', entries, ...extra });

test('saves repetition times, arm strokes and stroke cycles as separate measurements', () => {
  const saved = submit(db(), [{ swimmerId: 'sw', testItemKey: '2x50', expectedUpdatedAt: '',
    repResults: [{ overallTime: '31.50', overallStrokeCount: '36', strokeCycles: '18' }, { overallTime: '32.00', overallStrokeCount: '38' }] }]);
  assert.equal(saved.changedCount, 1);
  const reps = saved.db.tests[0].repResults;
  assert.deepEqual([reps[0].overallTime, reps[0].overallStrokeCount, reps[0].strokeCountUnit, reps[0].strokeCycles, reps[0].strokeCycleUnit],
    ['31.50', '36', 'strokes', '18', 'cycles']);
  assert.equal(reps[1].strokeCycles, undefined, 'no cycle value is invented');
  assert.equal(saved.db.tests[0].swimmerId, 'sw');
  assert.equal(saved.db.tests[0].date, '2026-10-03');
});

test('rejects invalid input, other squads and stale edits without changing data', () => {
  const base = db();
  assert.throws(() => submit(base, [{ swimmerId: 'x', testItemKey: '2x50', expectedUpdatedAt: '', repResults: [{ overallTime: '30.00' }] }]),
    (error) => error.status === 403);
  assert.throws(() => submit(base, [{ swimmerId: 'sw', testItemKey: '2x50', expectedUpdatedAt: '', repResults: [{ overallTime: 'fast' }] }]),
    (error) => error.status === 400);
  assert.throws(() => submit(base, [{ swimmerId: 'sw', testItemKey: '2x50', expectedUpdatedAt: '', repResults: [{ overallTime: '30.00', strokeCycles: 'x' }] }]),
    /stroke-cycle/);
  assert.throws(() => submit(base, [{ swimmerId: 'sw', testItemKey: '2x50', expectedUpdatedAt: '' , repResults: [{ overallTime: '30.00' }] }], { squadId: 'missing' }),
    /not in this workspace/);
  const saved = submit(base, [{ swimmerId: 'sw', testItemKey: '2x50', expectedUpdatedAt: '', repResults: [{ overallTime: '30.00' }] }]);
  assert.throws(() => submit(saved.db, [{ swimmerId: 'sw', testItemKey: '2x50', expectedUpdatedAt: '', repResults: [{ overallTime: '29.00' }] }]),
    (error) => error.status === 409);
  assert.equal(base.tests.length, 0, 'the input database is never mutated');
});

test('production build registers the scoped, authenticated route', () => {
  const build = fs.readFileSync(new URL('../scripts/build-production-backend.mjs', import.meta.url), 'utf8');
  assert.match(build, /'scripts\/patch-group-test-results\.mjs'/);
  const patch = fs.readFileSync(new URL('../scripts/patch-group-test-results.mjs', import.meta.url), 'utf8');
  assert.match(patch, /app\.post\('\/coach\/tests\/group-results', requireStrictAuth, requireWriteRole, requireBillingWriteAccess,/);
  assert.match(patch, /resolveStoragePathsForRequest\(req\)/);
  assert.match(patch, /enqueueWrite/);
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  if (index.includes('// ATHLYRAX_TARGETED_FIXTURE_SAVE_V1')) {
    // Built tree (after npm ci / postinstall): the route must be present.
    assert.ok(index.includes('// ATHLYRAX_GROUP_TEST_RESULTS_V1'));
  }
});

test('an edit is refused only when the recorded result changed, not when a whole-database save re-stamped updatedAt', () => {
  const first = submit(db(), [{ swimmerId: 'sw', testItemKey: '2x50', expectedUpdatedAt: '', expectedFingerprint: '',
    repResults: [{ overallTime: '31.50', overallStrokeCount: '36', strokeCycles: '18' }, { overallTime: '32.00' }] }]);
  const opened = first.db.tests[0];
  // A normal PUT /db stamps every row with a new updatedAt; the result is unchanged.
  const restamped = { ...first.db, tests: first.db.tests.map((row) => ({ ...row, updatedAt: '2099-01-01T00:00:00.000Z' })) };
  const edited = submit(restamped, [{ swimmerId: 'sw', testItemKey: '2x50', expectedUpdatedAt: opened.updatedAt,
    expectedFingerprint: groupTestResultFingerprint(opened), repResults: [{ overallTime: '31.20', overallStrokeCount: '36', strokeCycles: '18' }, { overallTime: '32.00' }] }]);
  assert.equal(edited.db.tests.length, 1, 'updated, not duplicated');
  assert.equal(edited.db.tests[0].id, opened.id);
  assert.equal(edited.db.tests[0].repResults[0].overallTime, '31.20');
  // Someone else changed the result: refused, nothing written.
  const changed = { ...restamped, tests: restamped.tests.map((row) => ({ ...row, repResults: [{ ...row.repResults[0], overallTime: '30.90' }, row.repResults[1]] })) };
  assert.throws(() => submit(changed, [{ swimmerId: 'sw', testItemKey: '2x50', expectedUpdatedAt: opened.updatedAt,
    expectedFingerprint: groupTestResultFingerprint(opened), repResults: [{ overallTime: '31.20' }] }]), (error) => error.status === 409);
});
