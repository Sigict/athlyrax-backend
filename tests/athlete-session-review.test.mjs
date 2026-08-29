import assert from 'node:assert/strict';
import test from 'node:test';
import { listPendingAthleteSessionProposals, reviewAthleteSessionProposal } from '../athlete-session-review.mjs';

function fixture() {
  return {
    trainingSessions: [
      {
        id: 'proposal-1',
        swimmerId: 'athlete-1',
        athleteId: 'athlete-1',
        athleteProposed: true,
        approvalStatus: 'pending',
        status: 'Pending Approval',
        title: 'Aerobic extra',
        date: '2026-08-29',
        ownerClubId: 'club-a',
      },
      {
        id: 'coach-session',
        athleteProposed: false,
        approvalStatus: 'approved',
        title: 'Coach session',
      },
    ],
    trainingSessionSets: [
      { id: 'set-1', trainingSessionId: 'proposal-1', approvalStatus: 'pending' },
    ],
  };
}

test('pending proposal list exposes only athlete-created pending sessions', () => {
  assert.deepEqual(listPendingAthleteSessionProposals(fixture()).map((row) => row.id), ['proposal-1']);
});

test('coach approval updates the canonical session and linked canonical sets once', () => {
  const reviewed = reviewAthleteSessionProposal(fixture(), {
    sessionId: 'proposal-1',
    decision: 'approved',
    reviewer: 'coachA',
    reviewedAt: '2026-08-29T11:00:00.000Z',
  });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.session.approvalStatus, 'approved');
  assert.equal(reviewed.session.status, 'Planned');
  assert.equal(reviewed.db.trainingSessions.length, 2);
  assert.equal(reviewed.db.trainingSessionSets[0].approvalStatus, 'approved');
  assert.equal(reviewed.db.trainingSessionSets[0].reviewedBy, 'coachA');
});

test('coach rejection is durable and proposal cannot be reviewed twice', () => {
  const first = reviewAthleteSessionProposal(fixture(), {
    sessionId: 'proposal-1',
    decision: 'rejected',
    reviewer: 'coachA',
  });
  assert.equal(first.ok, true);
  assert.equal(first.session.approvalStatus, 'rejected');
  assert.equal(first.session.status, 'Rejected');

  const second = reviewAthleteSessionProposal(first.db, {
    sessionId: 'proposal-1',
    decision: 'approved',
    reviewer: 'coachA',
  });
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
});
