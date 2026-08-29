import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATHLETE_SESSION_POLICIES,
  appendAthleteSessionWrite,
  athleteSessionPolicyForProjection,
  buildAthleteSessionWrite,
  selectAthleteSessionTarget,
} from '../athlete-session-write.mjs';

const authorised = [
  { tenantId: 'personal-tenant', clubId: 'personal', status: 'active', source: 'coach-link-source' },
  { tenantId: 'tenant-a', clubId: 'club-a', connectionId: 'link-a', status: 'active', source: 'coach-link' },
  { tenantId: 'tenant-b', clubId: 'club-b', connectionId: 'link-b', status: 'active', source: 'coach-link' },
  { tenantId: 'tenant-old', clubId: 'club-old', status: 'disconnected', source: 'coach-link' },
];

const projection = {
  athlete: { id: 'athlete-1' },
  clubConnections: [
    { clubId: 'club-a', tenantId: 'tenant-a', connectionId: 'link-a', sessionPolicies: { swimming: 'coach_only' } },
    { clubId: 'club-b', tenantId: 'tenant-b', connectionId: 'link-b', sessionPolicies: { swimming: 'approval_required', strength: 'athlete_extra' } },
  ],
};

test('target selection never accepts a disconnected or unknown club', () => {
  assert.equal(selectAthleteSessionTarget(authorised, { clubId: 'club-old', primaryTenantId: 'tenant-a' }), null);
  assert.equal(selectAthleteSessionTarget(authorised, { clubId: 'club-x', primaryTenantId: 'tenant-a' }), null);
  assert.equal(selectAthleteSessionTarget(authorised, { clubId: 'club-b', primaryTenantId: 'tenant-a' })?.tenantId, 'tenant-b');
});

test('independent writes prefer the retained personal source tenant', () => {
  const target = selectAthleteSessionTarget(authorised, { primaryTenantId: 'tenant-a' });
  assert.equal(target.tenantId, 'personal-tenant');
  assert.equal(target.independent, true);
});

test('club policy is evaluated per target club and discipline', () => {
  const clubA = selectAthleteSessionTarget(authorised, { clubId: 'club-a' });
  const clubB = selectAthleteSessionTarget(authorised, { clubId: 'club-b' });
  assert.equal(athleteSessionPolicyForProjection(projection, clubA, 'swimming').policy, ATHLETE_SESSION_POLICIES.COACH_ONLY);
  assert.equal(athleteSessionPolicyForProjection(projection, clubB, 'swimming').policy, ATHLETE_SESSION_POLICIES.APPROVAL_REQUIRED);
  assert.equal(athleteSessionPolicyForProjection(projection, clubB, 'strength').policy, ATHLETE_SESSION_POLICIES.ATHLETE_EXTRA);
});

test('coach-only club rejects athlete session creation', () => {
  const target = selectAthleteSessionTarget(authorised, { clubId: 'club-a' });
  const result = buildAthleteSessionWrite({
    athlete: projection.athlete,
    authUser: { username: 'swimmer1' },
    target,
    projection,
    input: { date: '2026-08-29', title: 'Not allowed', disciplineId: 'swimming' },
    sessionId: 'session-denied',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('approval-required club creates one pending canonical session with canonical linked sets', () => {
  const target = selectAthleteSessionTarget(authorised, { clubId: 'club-b' });
  const result = buildAthleteSessionWrite({
    athlete: projection.athlete,
    authUser: { username: 'swimmer1' },
    target,
    projection,
    input: {
      date: '2026-08-29',
      title: 'Extra aerobic swim',
      disciplineId: 'swimming',
      sets: [{ title: 'Main', rounds: 2, reps: 6, distance: 100, stroke: 'Free' }],
    },
    sessionId: 'athlete-session:1',
    setIdFactory: (index) => `athlete-session:1:set:${index + 1}`,
    createdAt: '2026-08-29T10:00:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.approvalRequired, true);
  assert.equal(result.session.approvalStatus, 'pending');
  assert.equal(result.session.ownerClubId, 'club-b');
  assert.equal(result.session.ownerTenantId, 'tenant-b');
  assert.equal(result.session.athleteProposed, true);
  assert.deepEqual(result.sets.map((row) => row.trainingSessionId), ['athlete-session:1']);
  assert.deepEqual(result.sets.map((row) => row.id), ['athlete-session:1:set:1']);

  const db = appendAthleteSessionWrite({ trainingSessions: [], trainingSessionSets: [] }, result);
  assert.equal(db.trainingSessions.length, 1);
  assert.equal(db.trainingSessionSets.length, 1);
  assert.equal(db.trainingSessions[0].id, db.trainingSessionSets[0].trainingSessionId);
});

test('independent session is approved immediately and has no club ownership', () => {
  const target = selectAthleteSessionTarget(authorised, { primaryTenantId: 'tenant-a' });
  const result = buildAthleteSessionWrite({
    athlete: projection.athlete,
    authUser: { username: 'swimmer1' },
    target,
    projection,
    input: { date: '2026-08-29', title: 'Easy run', disciplineId: 'running' },
    sessionId: 'independent-session:1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.policy, 'independent');
  assert.equal(result.approvalRequired, false);
  assert.equal(result.session.approvalStatus, 'approved');
  assert.equal(result.session.ownerClubId, '');
  assert.equal(result.session.athleteProposed, false);
});

test('server ignores client ownership and approval escalation fields', () => {
  const target = selectAthleteSessionTarget(authorised, { clubId: 'club-b' });
  const result = buildAthleteSessionWrite({
    athlete: projection.athlete,
    authUser: { username: 'swimmer1' },
    target,
    projection,
    input: {
      date: '2026-08-29',
      title: 'Cannot self approve',
      disciplineId: 'swimming',
      approvalStatus: 'approved',
      ownerType: 'club',
      ownerClubId: 'club-a',
      swimmerId: 'other-athlete',
    },
    sessionId: 'athlete-session:2',
  });
  assert.equal(result.ok, true);
  assert.equal(result.session.approvalStatus, 'pending');
  assert.equal(result.session.ownerType, 'athlete');
  assert.equal(result.session.ownerClubId, 'club-b');
  assert.equal(result.session.swimmerId, 'athlete-1');
});
