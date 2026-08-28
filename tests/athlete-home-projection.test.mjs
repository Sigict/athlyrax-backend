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
