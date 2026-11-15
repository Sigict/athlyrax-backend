// A swimmer changes their username after activation: sign-in works with the new name (any case) and
// not the old one; the swimmer record, its id, club history and personal training stay; reserved,
// taken and previously used names are refused; a wrong password or a coach account cannot do it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { engineFixtureDb } from './fixtures/capability-engine-fixture.mjs';
import { startServer, login, request, writeJson } from './helpers/athlete-server.mjs';
import { usernameProblem, renameSwimmerLinks } from '../account-username.mjs';

test('username rules: pattern, reserved, taken, previously used by someone else', () => {
  const users = [{ username: 'noah.reed' }, { username: 'mia', previousUsernames: [{ username: 'oldmia' }] }, { username: 'amelia1' }];
  assert.equal(usernameProblem('ab', { users }), 'Username must be 3-32 letters, numbers, dot, underscore or dash.');
  assert.match(usernameProblem('Admin', { users }), /reserved/);
  assert.match(usernameProblem('Noah.Reed', { users }), /taken/, 'case-insensitive');
  assert.match(usernameProblem('oldmia', { users }), /taken/, 'a name someone used before stays reserved');
  assert.equal(usernameProblem('Amelia1', { users, self: 'amelia1' }), '', 'your own name is not a conflict');
  const db = { swimmers: [{ id: 's1', swimmerAccountUsername: 'Old.Name' }, { id: 's2', swimmerAccountUsername: 'other' }], tests: [{ id: 't', swimmerId: 's1' }] };
  const out = renameSwimmerLinks(db, 'old.name', 'Amelia1');
  assert.equal(out.changed, 1); assert.deepEqual(out.db.swimmers.map((r) => r.swimmerAccountUsername), ['amelia1', 'other']); assert.equal(out.db.tests, db.tests);
});

const seed = (paths) => {
  const file = path.join(paths.storageRoot, 'auth', 'auth-users.json');
  const users = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = new Date().toISOString();
  for (const username of ['athlete.one', 'athlete.two']) users.push({ username, password: 'Athlete!Pass1234', role: 'swimmer', tenantId: 'tenant-a', clubId: 'club-a', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now, email: `${username}@example.com`, athleteInviteManaged: true });
  writeJson(file, users); writeJson(path.join(paths.storageRoot, 'auth', 'auth-users.backup.json'), users);
  const dbFile = path.join(paths.storageRoot, 'tenants', 'tenant-a', 'db.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  db.swimmers = [...(db.swimmers || []), { ...engineFixtureDb.swimmers[0], swimmerAccountUsername: 'athlete.one' }, { id: 'swimmer-2', firstName: 'Other', lastName: 'Swimmer', currentSquadId: 'squad-1', swimmerAccountUsername: 'athlete.two' }];
  for (const key of ['squads', 'schedule', 'trainingSessions', 'trainingSessionSets', 'tests']) db[key] = [...(db[key] || []), ...(engineFixtureDb[key] || [])];
  writeJson(dbFile, db);
};

test('swimmer changes username: new name signs in, old does not; record, history and personal training kept', async () => {
  const server = await startServer({}, seed);
  try {
    const base = server.baseUrl;
    const dbFile = path.join(server.tempRoot, 'storage', 'tenants', 'tenant-a', 'db.json');
    const one = await login(base, 'athlete.one', 'Athlete!Pass1234');
    const race = { protocolId: 'race', date: '2026-10-04', stroke: 'free', course: 'SCM', distance: 100, time: '1:05.00', meet: 'County Champs', splitMode: 'cumulative', splits: ['31.80', '1:05.00'], strokes: [16, 18], raceCheckIn: { plan: 'Yes', pacing: 'Partly', effort: 6 } };
    const saved = await request(base, '/swimmer/personal-training/sync', { ...one, method: 'POST', body: { changes: [{ kind: 'test', id: 'test-1', baseRev: 0, data: race }] } });
    assert.equal(saved.payload.results?.[0]?.status, 'applied', JSON.stringify(saved.payload).slice(0, 300));
    const homeBefore = await request(base, '/swimmer/athlete-home', one);
    const change = (who, body) => request(base, '/auth/username', { ...who, method: 'POST', body });
    assert.equal((await change(one, { username: 'Amelia1', currentPassword: 'wrong-password-123' })).response.status, 401);
    assert.equal((await change(one, { username: 'admin', currentPassword: 'Athlete!Pass1234' })).response.status, 400);
    assert.equal((await change(one, { username: 'Athlete.Two', currentPassword: 'Athlete!Pass1234' })).response.status, 409);
    const ok = await change(one, { username: 'Amelia1', currentPassword: 'Athlete!Pass1234' });
    assert.equal(ok.response.status, 200, JSON.stringify(ok.payload)); assert.equal(ok.payload.username, 'amelia1'); assert.equal(ok.payload.clubsUpdated, 1);
    assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'athlete.one', password: 'Athlete!Pass1234' }) })).status, 401, 'old name no longer signs in');
    for (const name of ['Amelia1', 'amelia1', 'athlete.one@example.com']) {
      const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'Athlete!Pass1234' }) });
      assert.equal(r.status, 200, `sign in as ${name}`);
    }
    const me = await login(base, 'Amelia1', 'Athlete!Pass1234');
    const homeAfter = await request(base, '/swimmer/athlete-home', me);
    assert.equal(homeAfter.payload.athlete.id, homeBefore.payload.athlete.id, 'same swimmer record');
    assert.equal(homeAfter.payload.sessions.length, homeBefore.payload.sessions.length, 'same club history');
    const personal = await request(base, '/swimmer/personal-training', me);
    assert.ok(JSON.stringify(personal.payload).includes('1:05.00'), 'personal training kept');
    const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    assert.deepEqual(db.swimmers.filter((s) => s.swimmerAccountUsername).map((s) => [s.id, s.swimmerAccountUsername]).sort(), [['swimmer-1', 'amelia1'], ['swimmer-2', 'athlete.two']]);
    // The old name stays reserved; coaches cannot use the route.
    const two = await login(base, 'athlete.two', 'Athlete!Pass1234');
    assert.equal((await change(two, { username: 'athlete.one', currentPassword: 'Athlete!Pass1234' })).response.status, 409);
    const coach = await login(base, 'coachA', 'CoachA!Pass1234');
    assert.equal((await change(coach, { username: 'coach.new', currentPassword: 'CoachA!Pass1234' })).response.status, 403);
  } finally { await server.stop(); }
});
