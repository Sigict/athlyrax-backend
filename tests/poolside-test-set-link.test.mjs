import assert from 'node:assert/strict';
import test from 'node:test';

// ATHLYRAX_POOLSIDE_TEST_SET_LINK
test('poolside results on a planned test set become the linked test record (Testing evidence); never duplicated or overwritten', async () => {
  const { applyCoachPoolsideCanonicalResult } = await import('../coach-poolside-mutations.mjs');
  const base = {
    squads: [{ id: 'sq' }], swimmers: [{ id: 'amy', firstName: 'Amy', squadId: 'sq' }, { id: 'bob', firstName: 'Bob', squadId: 'sq' }],
    schedule: [{ id: 'sch', scheduleDate: '2026-11-08', squadIds: ['sq'] }],
    trainingSessions: [{ id: 'ts', scheduleId: 'sch', date: '2026-11-08' }],
    trainingSessionSets: [
      { id: 'set-max', trainingSessionId: 'ts', scheduleId: 'sch', setName: 'Max 100 free', isTestSet: true, setType: 'test', rounds: 1, reps: 1, distance: 100, stroke: 'free' },
      { id: 'set-train', trainingSessionId: 'ts', scheduleId: 'sch', setName: '4x100 aerobic', rounds: 1, reps: 4, distance: 100 },
    ],
    tests: [],
  };
  const r = applyCoachPoolsideCanonicalResult(base, { sessionId: 'ts', setId: 'set-max', swimmerId: 'amy', reps: [{ rep: 1, overallTime: '1:02.10', overallStrokeCount: '60' }], updatedBy: 'coachA' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.testsCreated, 1);
  const t = r.db.tests[0];
  assert.deepEqual([t.swimmerId, t.linkedSetId, t.templateId, t.date, t.repResults[0].overallTime, t.capabilityScoringEligible], ['amy', 'set-max', 'builtin-test-max', '2026-11-08', '1:02.10', true]);
  const again = applyCoachPoolsideCanonicalResult(r.db, { sessionId: 'ts', setId: 'set-max', swimmerId: 'amy', reps: [{ rep: 1, overallTime: '1:02.10' }], updatedBy: 'coachA' });
  assert.equal(again.db.tests.length, 1, 'no duplicate test record');
  const bob = applyCoachPoolsideCanonicalResult(again.db, { sessionId: 'ts', setId: 'set-max', swimmerId: 'bob', reps: [{ rep: 1, overallTime: '1:05.00' }], updatedBy: 'coachA' });
  assert.equal(bob.db.tests.length, 2);
  assert.equal(bob.db.tests.find((x) => x.swimmerId === 'amy').updatedAt, t.updatedAt, 'existing test record unchanged');
  const train = applyCoachPoolsideCanonicalResult(base, { sessionId: 'ts', setId: 'set-train', swimmerId: 'amy', reps: [{ rep: 1, overallTime: '1:20.00' }], updatedBy: 'coachA' });
  assert.equal(train.db.tests.length, 0, 'training sets do not create tests');
});
