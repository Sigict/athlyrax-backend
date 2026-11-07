import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildClubResults, buildSelfReportedProgress, normalizeTest, testProtocols } from '../athlete-tests-races.mjs';
import { applyPersonalTrainingChanges, emptyPersonalTraining } from '../athlete-personal-training.mjs';
import { buildFixedTestTemplateRows } from '../capability-engine/src/utils/testTemplateCatalog.js';
import { engineFixtureDb } from './fixtures/capability-engine-fixture.mjs';
import { startServer, login, request, writeJson } from './helpers/athlete-server.mjs';

const race = (over = {}) => ({ protocolId: 'race', date: '2026-10-04', stroke: 'free', course: 'SCM', distance: 100, time: '1:02.50', meet: 'County Champs', splitMode: 'cumulative', splits: ['29.80', '1:02.50'], strokes: [16, 18], raceCheckIn: { plan: 'Yes', pacing: 'Partly', effort: 6 }, ...over });
const repeat = (over = {}) => ({ protocolId: 'rep-50', date: '2026-10-05', stroke: 'free', course: 'SCM', repTimes: ['32.1', '32.4', '32.0', '32.9', '33.1', '33.0', '32.8', '33.4'], ...over });

test('protocols come from the canonical catalogue, including the 5x400 aerobic check', () => {
  const ids = testProtocols().map((p) => p.id);
  for (const row of buildFixedTestTemplateRows()) assert.ok(ids.includes(row.id), `${row.id} from the catalogue`);
  const aerobic = testProtocols().find((p) => p.id === 'aerobic-5x400');
  assert.deepEqual([aerobic.reps, aerobic.distance, aerobic.category], [5, 400, 'aerobic']);
  assert.ok(ids.includes('race'));
});

test('validation follows Master v31: splits, strokes, repetitions, check-in', () => {
  const ok = normalizeTest(race());
  assert.equal(ok.verification, 'athlete-entered-unverified');
  assert.deepEqual(ok.raceCheckIn, { plan: 'Yes', pacing: 'Partly', effort: 6 });
  assert.throws(() => normalizeTest(race({ splits: ['29.80', '1:03.00'] })), /finish time/);
  assert.throws(() => normalizeTest(race({ splits: ['40.0', '30.0'] })), /increase/);
  assert.doesNotThrow(() => normalizeTest(race({ splitMode: 'individual', splits: ['29.80', '32.70'] })));
  assert.throws(() => normalizeTest(race({ splitMode: 'individual', splits: ['29.80', '30.00'] })), /add up/);
  assert.throws(() => normalizeTest(race({ strokes: [16] })), /stroke count/);
  assert.throws(() => normalizeTest(race({ course: '' })), /course/);
  assert.throws(() => normalizeTest(race({ distance: 75 })), /distance/);
  assert.throws(() => normalizeTest(race({ raceCheckIn: { effort: 9 } })), /1–7/);
  assert.throws(() => normalizeTest(repeat({ repTimes: ['32.1'] })), /all 8/);
  const r = normalizeTest(repeat());
  assert.deepEqual(r.statistics, { n: 8, mean: 32.71, best: 32, slowest: 33.4, spread: 1.4 });
  assert.throws(() => normalizeTest({ ...race(), protocolId: 'max-75' }), /catalogue/);
  assert.equal(normalizeTest({ ...race(), verification: 'validated' }).verification, 'athlete-entered-unverified');
});

test('edits keep a server-side amendment trail; sync stores tests with revisions', () => {
  let r = applyPersonalTrainingChanges(emptyPersonalTraining(), [{ kind: 'test', id: 'test-1', baseRev: 0, data: race() }]);
  assert.equal(r.results[0].status, 'applied');
  r = applyPersonalTrainingChanges(r.store, [{ kind: 'test', id: 'test-1', baseRev: 1, data: race({ time: '1:02.40', splits: ['29.80', '1:02.40'], amendments: [{ forged: true }] }) }]);
  const saved = r.store.tests['test-1'].data;
  assert.equal(saved.amendments.length, 1);
  assert.deepEqual(saved.amendments[0].changed.map((c) => c.field), ['time', 'splits']);
  assert.ok(!saved.amendments.some((a) => a.forged), 'a client cannot write its own amendment trail');
  const bad = applyPersonalTrainingChanges(r.store, [{ kind: 'test', id: 'test-2', baseRev: 0, data: race({ time: 'fast' }) }]);
  assert.equal(bad.results[0].status, 'invalid');
});

test('self-reported progress: labelled unverified, PBs by course via the canonical function', () => {
  const records = [
    { id: 'a', data: normalizeTest(race()) },
    { id: 'b', data: normalizeTest(race({ date: '2026-10-20', time: '1:01.90', splits: ['29.50', '1:01.90'] })) },
    { id: 'c', data: normalizeTest(race({ course: 'LCM', time: '1:04.00', splits: [], strokes: [] })) },
    { id: 'd', deleted: true, data: normalizeTest(race({ time: '55.00', splits: [], strokes: [] })) },
  ];
  const progress = buildSelfReportedProgress(records);
  assert.equal(progress.label, 'Self-reported / Unverified');
  assert.equal(progress.tests.length, 3, 'deleted entries are left out');
  assert.equal(progress.personalBests.length, 2, 'one section per course');
  assert.deepEqual(progress.personalBests.map((s) => s.events[0].time).sort(), ['1:01.90', '1:04.00'], 'fastest per course, deleted 55.00 ignored');
});

const clubDb = () => ({
  ...engineFixtureDb,
  swimmers: [...engineFixtureDb.swimmers, { id: 'swimmer-2', firstName: 'Other', lastName: 'Swimmer', currentSquadId: 'squad-1' }],
  tests: [...engineFixtureDb.tests, { ...engineFixtureDb.tests[1], id: 'test-other', swimmerId: 'swimmer-2' }],
  competitionResults: [
    { id: 'comp-1', swimmerId: 'swimmer-1', date: '2026-02-01', fixtureName: 'Spring Open', distance: 100, stroke: 'free', resultValue: '1:01.20', course: 'SCM', completed: true },
    { id: 'comp-2', swimmerId: 'swimmer-2', date: '2026-02-01', fixtureName: 'Spring Open', distance: 100, stroke: 'free', resultValue: '58.00', course: 'SCM', completed: true },
  ],
});

test('club results: only the linked swimmer, read-only, data scopes respected', () => {
  const db = clubDb();
  const before = JSON.stringify(db);
  const mine = buildClubResults(db, 'swimmer-1');
  assert.equal(mine.label, 'Validated club records (read-only)');
  assert.deepEqual(mine.tests.map((t) => t.id).sort(), ['test-aerobic', 'test-sprint']);
  assert.ok(!JSON.stringify(mine).includes('swimmer-2') && !JSON.stringify(mine).includes('58.00'), 'no other swimmer');
  assert.equal(JSON.stringify(db), before, 'club data unchanged');
  const testsOnly = buildClubResults(db, 'swimmer-1', { dataScopes: ['tests'] });
  assert.deepEqual([testsOnly.tests.length > 0, testsOnly.races.length, testsOnly.personalBests.length], [true, 0, 0]);
  assert.equal(buildClubResults(db, ''), null);
});

const seed = (paths) => {
  const file = path.join(paths.storageRoot, 'auth', 'auth-users.json');
  const users = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = new Date().toISOString();
  for (const username of ['athlete.one', 'athlete.two']) users.push({ username, password: 'Athlete!Pass1234', role: 'swimmer', tenantId: 'tenant-a', clubId: 'club-a', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now, email: `${username}@example.com`, athleteInviteManaged: true });
  writeJson(file, users); writeJson(path.join(paths.storageRoot, 'auth', 'auth-users.backup.json'), users);
  const dbFile = path.join(paths.storageRoot, 'tenants', 'tenant-a', 'db.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const extra = clubDb();
  db.swimmers = [...(db.swimmers || []), { ...extra.swimmers[0], swimmerAccountUsername: 'athlete.one' }, { ...extra.swimmers[1], swimmerAccountUsername: 'athlete.two' }];
  for (const key of ['squads', 'schedule', 'trainingSessions', 'trainingSessionSets', 'tests', 'competitionResults']) db[key] = [...(db[key] || []), ...extra[key]];
  writeJson(dbFile, db);
};

test('progress route: own self-reported entries plus own club results; nothing written to the club', async () => {
  const server = await startServer({}, seed);
  try {
    const clubDbFile = path.join(server.tempRoot, 'storage', 'tenants', 'tenant-a', 'db.json');
    const clubBefore = fs.readFileSync(clubDbFile, 'utf8');
    const one = await login(server.baseUrl, 'athlete.one', 'Athlete!Pass1234');
    const catalogue = await request(server.baseUrl, '/swimmer/test-catalogue', one);
    assert.equal(catalogue.response.status, 200);
    assert.ok(catalogue.payload.protocols.some((p) => p.id === 'aerobic-5x400'));
    const saved = await request(server.baseUrl, '/swimmer/personal-training/sync', { ...one, method: 'POST', body: { changes: [{ kind: 'test', id: 'test-1', baseRev: 0, data: race() }] } });
    assert.equal(saved.payload.results[0].status, 'applied', JSON.stringify(saved.payload));
    const progress = await request(server.baseUrl, '/swimmer/progress', one);
    assert.equal(progress.response.status, 200, JSON.stringify(progress.payload));
    assert.equal(progress.payload.selfReported.label, 'Self-reported / Unverified');
    assert.equal(progress.payload.selfReported.tests[0].time, '1:02.50');
    const club = progress.payload.clubs.find((c) => c.available);
    assert.ok(club, JSON.stringify(progress.payload.clubs));
    assert.equal(club.label, 'Validated club records (read-only)');
    assert.ok(club.tests.some((t) => t.id === 'test-sprint'));
    assert.ok(!JSON.stringify(progress.payload).includes('58.00'), "the other swimmer's race is not visible");
    // The athlete home radar is the club's validated profile, unaffected by the self-reported race.
    const home = await request(server.baseUrl, '/swimmer/athlete-home', one);
    assert.equal(home.payload.integratedProfile?.source, 'club_evidence');
    const two = await login(server.baseUrl, 'athlete.two', 'Athlete!Pass1234');
    const other = await request(server.baseUrl, '/swimmer/progress', two);
    assert.equal(other.payload.selfReported.tests.length, 0, "athlete two cannot see athlete one's entries");
    assert.ok(!other.payload.clubs.some((c) => c.tests?.some((t) => t.id === 'test-sprint')));
    const coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    assert.equal((await request(server.baseUrl, '/swimmer/progress', coach)).response.status, 403);
    assert.equal((await request(server.baseUrl, '/swimmer/progress')).response.status, 401);
    assert.equal(fs.readFileSync(clubDbFile, 'utf8'), clubBefore, 'club database unchanged');
  } finally { await server.stop(); }
});
