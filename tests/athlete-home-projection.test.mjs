import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAthleteHomeProjection } from '../athlete-home-projection.mjs';

const db = {
  swimmers: [
    {
      id: 'athlete-1',
      name: 'Athlete One',
      swimmerAccountUsername: 'swimmer1',
      currentSquadId: 'squad-a',
      asaN: '123456',
    },
    { id: 'athlete-2', name: 'Other Athlete', swimmerAccountUsername: 'other', currentSquadId: 'squad-b' },
  ],
  swimmerClubConnections: [
    { connectionId: 'link-a', swimmerId: 'athlete-1', clubId: 'club-a', clubName: 'Club A', squadId: 'squad-a' },
    { connectionId: 'link-other', swimmerId: 'athlete-2', clubId: 'club-b', clubName: 'Club B', squadId: 'squad-b' },
    { connectionId: 'link-unscoped', clubId: 'club-secret', clubName: 'Secret Club', squadId: 'squad-a' },
  ],
  trainingSessions: [
    { id: 'session-a', squadId: 'squad-a', clubId: 'club-a', title: 'Coach swim', scheduleId: 'schedule-a' },
    { id: 'session-b', squadId: 'squad-b', clubId: 'club-b', title: 'Other squad' },
    { id: 'session-wrong-club', squadId: 'squad-a', clubId: 'club-secret', title: 'Same squad label, wrong club' },
  ],
  trainingSessionSets: [
    { id: 'set-a1', sessionId: 'session-a', reps: 8, distance: 100, stroke: 'Free' },
    { id: 'set-private', sessionId: 'session-a', coachPrivate: true, reps: 4, distance: 50 },
    { id: 'set-b1', sessionId: 'session-b', reps: 10, distance: 50 },
    { id: 'set-secret', sessionId: 'session-wrong-club', reps: 1, distance: 25 },
  ],
  billing: [{ secret: 'must-not-leak' }],
};

test('projection returns authenticated athlete with exact squad sessions and linked sets only', () => {
  const result = buildAthleteHomeProjection(db, { username: 'swimmer1' });
  assert.equal(result.athlete.id, 'athlete-1');
  assert.equal(result.athlete.asn, '123456');
  assert.deepEqual(result.clubConnections.map((row) => row.clubId), ['club-a']);
  assert.deepEqual(result.sessions.map((row) => row.id), ['session-a']);
  assert.deepEqual(result.sessions[0].sets.map((row) => row.id), ['set-a1']);
});

test('projection excludes unrelated and unscoped top-level club connections', () => {
  const result = buildAthleteHomeProjection(db, { username: 'swimmer1' });
  assert.equal(JSON.stringify(result).includes('club-secret'), false);
  assert.equal(JSON.stringify(result).includes('Secret Club'), false);
  assert.equal(JSON.stringify(result).includes('link-other'), false);
});

test('squad-name collision cannot expose a session belonging to another club', () => {
  const result = buildAthleteHomeProjection(db, { username: 'swimmer1' });
  assert.equal(JSON.stringify(result).includes('session-wrong-club'), false);
  assert.equal(JSON.stringify(result).includes('set-secret'), false);
});

test('nested athlete-owned club connections may omit redundant swimmer id', () => {
  const nestedDb = {
    swimmers: [{
      id: 'athlete-nested',
      swimmerAccountUsername: 'nested',
      clubConnections: [{ connectionId: 'nested-link', clubId: 'club-n', squadId: 'squad-n' }],
    }],
    trainingSessions: [{ id: 'nested-session', clubId: 'club-n', squadId: 'squad-n' }],
  };
  const result = buildAthleteHomeProjection(nestedDb, { username: 'nested' });
  assert.deepEqual(result.clubConnections.map((row) => row.connectionId), ['nested-link']);
  assert.deepEqual(result.sessions.map((row) => row.id), ['nested-session']);
});

test('explicit authorised tenant context scopes a copied athlete to that club without opening other clubs', () => {
  const copiedDb = {
    swimmers: [{ id: 'athlete-1', swimmerAccountUsername: 'swimmer1', currentSquadId: 'shared-squad' }],
    trainingSessions: [
      { id: 'club-b-session', clubId: 'club-b', squadId: 'shared-squad' },
      { id: 'club-secret-session', clubId: 'club-secret', squadId: 'shared-squad' },
    ],
  };
  const result = buildAthleteHomeProjection(copiedDb, { username: 'swimmer1' }, {
    tenantId: 'tenant-b',
    connection: { tenantId: 'tenant-b', connectionId: 'tenant:tenant-b', clubId: 'club-b', clubName: 'Club B', squadId: 'shared-squad' },
  });
  assert.deepEqual(result.clubConnections.map((row) => row.clubId), ['club-b']);
  assert.deepEqual(result.sessions.map((row) => row.id), ['club-b-session']);
  assert.equal(JSON.stringify(result).includes('club-secret-session'), false);
});

test('projection does not expose unrelated tenant collections or private coach sets', () => {
  const result = buildAthleteHomeProjection(db, { username: 'swimmer1' });
  assert.equal(Object.hasOwn(result, 'billing'), false);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('set-private'), false);
  assert.equal(JSON.stringify(result).includes('session-b'), false);
});

test('projection fails closed when authenticated account has no mapped athlete', () => {
  assert.equal(buildAthleteHomeProjection(db, { username: 'missing' }), null);
});

// ATHLYRAX_ATHLETE_HOME_PLANNER_SESSIONS
test('a Planner session (schedule with squadIds + training session with sets) reaches its squad once, complete', () => {
  const planner = () => ({
    swimmers: [
      { id: 'sw-amy', name: 'Amy Test', squadIds: ['sq-1'], swimmerAccountUsername: 'amy.athlete' },
      { id: 'sw-ben', name: 'Ben Other', squadId: 'sq-2', swimmerAccountUsername: 'ben.athlete' },
    ],
    schedule: [
      { id: 'sch-1', scheduleDate: '2026-11-20', startTime: '06:00', endTime: '07:00', squadIds: ['sq-1'], squadNames: ['Squad One'], mainFocus: 'ATHLETE TEST session' },
      { id: 'sch-gone', scheduleDate: '2026-11-21', squadIds: ['sq-1'], mainFocus: 'Deleted', status: 'deleted' },
    ],
    trainingSessions: [{ id: 'ts-1', scheduleId: 'sch-1' }],
    trainingSessionSets: [
      { id: 'set-a', trainingSessionId: 'ts-1', order: 1, reps: 3, distance: 100, stroke: 'free', sendOff: '1:40', restTime: '20s', title: '3x100 free' },
      { id: 'set-p', trainingSessionId: 'ts-1', order: 2, reps: 1, distance: 50, coachPrivate: true, title: 'coach only' },
    ],
  });
  const db = planner();
  const amy = buildAthleteHomeProjection(db, { username: 'amy.athlete', role: 'swimmer' });
  assert.equal(amy.athlete.id, 'sw-amy');
  assert.equal(amy.sessions.length, 1, 'one session, not a schedule copy plus a session copy; deleted schedules hidden');
  const s = amy.sessions[0];
  assert.deepEqual([s.id, s.scheduleId, s.date, s.title, s.startTime], ['ts-1', 'sch-1', '2026-11-20', 'ATHLETE TEST session', '06:00']);
  assert.deepEqual(s.sets.map((x) => [x.id, x.reps, x.distance, x.stroke, x.sendoff, x.rest]), [['set-a', 3, 100, 'free', '1:40', '20s']], 'complete set instructions; coach-private set hidden');
  // Another squad's swimmer does not get it.
  assert.equal(buildAthleteHomeProjection(db, { username: 'ben.athlete', role: 'swimmer' }).sessions.length, 0);
  // A coach change (Console: 3 -> 4 reps, send-off 1:45) is what the athlete sees next.
  db.trainingSessionSets[0].reps = 4; db.trainingSessionSets[0].sendOff = '1:45';
  const updated = buildAthleteHomeProjection(db, { username: 'amy.athlete', role: 'swimmer' }).sessions[0].sets[0];
  assert.deepEqual([updated.reps, updated.sendoff], [4, '1:45']);
  // A schedule that names its training session directly is linked the same way.
  const db2 = planner(); db2.schedule[0].trainingSessionId = 'ts-1'; db2.trainingSessions[0] = { id: 'ts-1' };
  const viaSchedule = buildAthleteHomeProjection(db2, { username: 'amy.athlete', role: 'swimmer' }).sessions;
  assert.deepEqual(viaSchedule.map((x) => [x.id, x.date, x.sets.length]), [['ts-1', '2026-11-20', 1]]);
});

// ATHLYRAX_ATHLETE_EXPLICIT_LINK_FIRST
test('an invitation-managed account sees only its explicitly linked swimmer, never a loose email match', () => {
  const db = { swimmers: [
    { id: 'victim', name: 'Victim', email: 'me@example.com', squadId: 'sq' },
    { id: 'mine', name: 'Mine', swimmerAccountUsername: 'me.athlete', squadId: 'sq' },
  ] };
  assert.equal(buildAthleteHomeProjection(db, { username: 'me.athlete', email: 'me@example.com', athleteInviteManaged: true }).athlete.id, 'mine');
  // Unlinked (after a correction): no record at all, not the email match.
  db.swimmers[1].swimmerAccountUsername = '';
  assert.equal(buildAthleteHomeProjection(db, { username: 'me.athlete', email: 'me@example.com', athleteInviteManaged: true }), null);
});

// Send-offs saved as plain seconds are shown as clock time.
test('athlete sets show numeric send-offs as clock time', () => {
  const db = { swimmers: [{ id: 'a', swimmerAccountUsername: 'a.user', squadId: 'sq' }], trainingSessions: [{ id: 's', date: '2026-11-20', squadId: 'sq' }],
    trainingSessionSets: [{ id: 'x', trainingSessionId: 's', sendOff: 105 }, { id: 'y', trainingSessionId: 's', sendOff: '1:40' }, { id: 'z', trainingSessionId: 's', sendoff: '95' }] };
  const sets = buildAthleteHomeProjection(db, { username: 'a.user' }).sessions[0].sets;
  assert.deepEqual(sets.map((x) => x.sendoff), ['1:45', '1:40', '1:35']);
});

// ATHLYRAX_ATHLETE_OWN_CLUB_RESULTS
test('athlete sees only their own recorded club results, lane and start offset', async () => {
  const { buildAthleteHomeProjection } = await import('../athlete-home-projection.mjs');
  const db = {
    squads: [{ id: 'sq' }],
    swimmers: [{ id: 'amy', firstName: 'Amy', squadId: 'sq', swimmerAccountUsername: 'amy.app' }, { id: 'ben', firstName: 'Ben', squadId: 'sq' }],
    schedule: [{ id: 'sch', scheduleDate: '2026-11-08', squadIds: ['sq'], mainFocus: 'Test' }],
    trainingSessions: [{ id: 'ts', scheduleId: 'sch', poolsideLanePlan: { lanes: [{ lane: 'Lane 2', swimmerIds: ['ben', 'amy'], sendoffSeconds: 60, staggerSeconds: 5 }] } }],
    trainingSessionSets: [{ id: 'set', trainingSessionId: 'ts', reps: 2, distance: 50, sendOff: '1:00', resultsBySwimmer: {
      amy: { reps: [{ rep: 1, overallTime: '31.20', overallStrokeCount: '36', splits: [{ time: '15.10', strokeCount: '18' }, { time: '16.10', strokeCount: '18' }], coachNote: 'private' }, {}], source: 'coach-poolside', updatedBy: 'coachA' },
      ben: { reps: [{ rep: 1, overallTime: '29.90' }] },
    } }],
  };
  const home = buildAthleteHomeProjection(db, { username: 'amy.app', athleteInviteManaged: true });
  const s = home.sessions.find((x) => x.id === 'ts');
  const set = s.sets[0];
  assert.deepEqual(set.myResult.reps, [{ rep: 1, overallTime: '31.20', overallStrokeCount: '36', splits: [{ time: '15.10', strokeCount: '18', distance: null }, { time: '16.10', strokeCount: '18', distance: null }] }]);
  assert.equal(set.myResult.label, 'Recorded by the club (read-only)');
  assert.ok(!JSON.stringify(home).includes('29.90'), 'another swimmer\'s time is never included');
  assert.ok(!JSON.stringify(home).includes('private') && !JSON.stringify(home).includes('coachA'), 'no coach-only fields');
  assert.deepEqual(s.myLane, { lane: 'Lane 2', position: 2, swimmersInLane: 2, sendoffSeconds: 60, staggerSeconds: 5, startOffsetSeconds: 5 });
});
