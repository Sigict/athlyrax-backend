// An athlete sends the repetitions recorded for one of their club's sessions to that club's Results
// inbox: identity and session come from the server, re-sending is a no-op, other athletes and unknown
// sessions are refused, coaches review before anything reaches club data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { engineFixtureDb } from './fixtures/capability-engine-fixture.mjs';
import { startServer, login, request, writeJson } from './helpers/athlete-server.mjs';

const seed = (paths) => {
  const file = path.join(paths.storageRoot, 'auth', 'auth-users.json');
  const users = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = new Date().toISOString();
  for (const username of ['athlete.one', 'athlete.two']) users.push({ username, password: 'Athlete!Pass1234', role: 'swimmer', tenantId: 'tenant-a', clubId: 'club-a', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now, email: `${username}@example.com`, athleteInviteManaged: true });
  writeJson(file, users); writeJson(path.join(paths.storageRoot, 'auth', 'auth-users.backup.json'), users);
  const dbFile = path.join(paths.storageRoot, 'tenants', 'tenant-a', 'db.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  db.swimmers = [...(db.swimmers || []), { ...engineFixtureDb.swimmers[0], swimmerAccountUsername: 'athlete.one' }, { id: 'swimmer-2', firstName: 'Other', lastName: 'Swimmer', currentSquadId: 'squad-1', swimmerAccountUsername: 'athlete.two' }];
  for (const key of ['squads', 'schedule', 'trainingSessions', 'trainingSessionSets']) db[key] = [...(db[key] || []), ...engineFixtureDb[key]];
  writeJson(dbFile, db);
};
const reps = (over = {}) => ({ coachSessionId: 'session-aerobic', results: [
  { setId: 'set-aerobic', rep: 1, swimTime: '4:58.20', strokes: 158, cumulativeSplits: ['1:13.00', '2:28.50', '3:43.90', '4:58.20'], poolLength: 25, capturedAt: '2026-01-10T18:05:00.000Z', startOffsetSeconds: 0 },
  { setIndex: 0, rep: 2, swimTime: '5:01.40', capturedAt: '2026-01-10T18:11:00.000Z', startOffsetSeconds: 360 },
], ...over });

test('athlete results reach the club Results inbox for coach review; identity is server-side; duplicates and spoofing refused', async () => {
  const server = await startServer({}, seed);
  try {
    const clubDbFile = path.join(server.tempRoot, 'storage', 'tenants', 'tenant-a', 'db.json');
    const before = fs.readFileSync(clubDbFile, 'utf8');
    const one = await login(server.baseUrl, 'athlete.one', 'Athlete!Pass1234');
    const home = await request(server.baseUrl, '/swimmer/athlete-home', one);
    assert.ok(home.payload.sessions.some((s) => s.id === 'session-aerobic'), 'the coach session is visible to the athlete');
    const sent = await request(server.baseUrl, '/swimmer/club-session-results', { ...one, method: 'POST', body: reps() });
    assert.equal(sent.response.status, 201, JSON.stringify(sent.payload)); assert.equal(sent.payload.sent, 2); assert.equal(sent.payload.duplicate, false);
    const again = await request(server.baseUrl, '/swimmer/club-session-results', { ...one, method: 'POST', body: reps() });
    assert.equal(again.payload.duplicate, true, 'sending the same results twice is a no-op');
    // Identity cannot be chosen by the client.
    const two = await login(server.baseUrl, 'athlete.two', 'Athlete!Pass1234');
    const spoof = await request(server.baseUrl, '/swimmer/club-session-results', { ...two, method: 'POST', body: { ...reps(), swimmer: { id: 'swimmer-1' } } });
    assert.equal(spoof.response.status, 201);
    assert.equal((await request(server.baseUrl, '/swimmer/club-session-results', { ...one, method: 'POST', body: reps({ coachSessionId: 'not-mine' }) })).response.status, 404);
    assert.equal((await request(server.baseUrl, '/swimmer/club-session-results', { ...one, method: 'POST', body: reps({ results: [{ setId: 'nope', setIndex: 9, rep: 1, swimTime: '30.0' }] }) })).response.status, 400);
    assert.equal((await request(server.baseUrl, '/swimmer/club-session-results', { ...one, method: 'POST', body: reps({ results: [{ setId: 'set-aerobic', rep: 1, swimTime: 'abc' }] }) })).response.status, 400);
    // The coach sees two inbox items, each with its own swimmer, labelled athlete-entered and awaiting review.
    const coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    assert.equal((await request(server.baseUrl, '/swimmer/club-session-results', { ...coach, method: 'POST', body: reps() })).response.status, 403);
    const inbox = await request(server.baseUrl, '/results-inbox', coach);
    const items = inbox.payload.items || inbox.payload;
    assert.equal(items.length, 2, JSON.stringify(inbox.payload).slice(0, 400));
    const files = await Promise.all(items.map((it) => request(server.baseUrl, `/results-inbox/${it.id}`, coach)));
    const swimmers = files.map((f) => (f.payload.file || f.payload).results[0].swimmer.id).sort();
    assert.deepEqual(swimmers, ['swimmer-1', 'swimmer-2']);
    const first = files.map((f) => f.payload.file || f.payload).find((f) => f.results[0].swimmer.id === 'swimmer-1');
    assert.deepEqual(first.results.map((r) => [r.source, r.enteredBy, r.review.status, r.setId, r.rep, r.time.seconds]), [['athlete', 'athlete', 'needs-review', 'set-aerobic', 1, 298.2], ['athlete', 'athlete', 'needs-review', 'set-aerobic', 2, 301.4]]);
    assert.equal(first.results[0].splits.length, 4); assert.equal(first.results[0].strokeCount, 158);
    assert.ok(items.every((it) => it.app === 'athlete' && it.waitingForReview === 2));
    assert.equal(fs.readFileSync(clubDbFile, 'utf8'), before, 'club data unchanged until the coach imports');
  } finally { await server.stop(); }
});
