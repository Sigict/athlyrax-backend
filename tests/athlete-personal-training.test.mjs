import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyPersonalTrainingChanges, emptyPersonalTraining, normalizeDay, personalTrainingPath } from '../athlete-personal-training.mjs';
import { startServer, login, request, writeJson } from './helpers/athlete-server.mjs';

const plan = (over = {}) => ({ date: '2026-11-10', start: '06:00', end: '07:30', pool: 'SCM', title: 'Threshold', repeat: 'weekly', until: '2026-12-15', sets: [{ id: 'pset-1', rounds: 1, reps: 6, distance: 200, stroke: 'free', sendoff: '3:00', rest: '', stagger: 0 }], ...over });
const day = (over = {}) => ({ date: '2026-11-10', sessions: [{ id: 'sess-1', label: 'AM Swim', type: 'Swim', completed: 'Full', feel: 'Hard', pool: 'SCM', planId: 'plan-1', occurrenceDate: '2026-11-10',
  questionnaire: { planned: 'Yes', recovered: 'Not sure' }, effort: 7, reflection: 'Felt strong on the back half.',
  sets: [{ id: 'set-1', reps: 3, distance: 100, stroke: 'free', sendoff: '1:40', results: [{ rep: 1, swimTime: '1:12.40', strokes: 36, cumulativeSplits: ['17.9', '36.4', '54.6', '1:12.40'], poolLength: 25, source: 'athlete-poolside-stopwatch', verification: 'validated' }] }] }], ...over });

test('sync: create, revision, conflict, idempotent repeat, tombstone', () => {
  let store = emptyPersonalTraining();
  let r = applyPersonalTrainingChanges(store, [{ kind: 'plan', id: 'plan-1', baseRev: 0, data: plan() }, { kind: 'day', id: 'day-1', baseRev: 0, data: day() }]);
  assert.deepEqual(r.results.map((x) => [x.status, x.rev]), [['applied', 1], ['applied', 1]]);
  store = r.store;
  // Repeating the same change (lost response, retry) is harmless.
  r = applyPersonalTrainingChanges(store, [{ kind: 'plan', id: 'plan-1', baseRev: 0, data: plan() }]);
  assert.equal(r.results[0].status, 'applied'); assert.equal(r.results[0].unchanged, true); assert.equal(r.store, null);
  // Device A edits (rev 1 -> 2); device B, still on rev 1, edits differently: conflict, server copy returned.
  r = applyPersonalTrainingChanges(store, [{ kind: 'plan', id: 'plan-1', baseRev: 1, data: plan({ title: 'Device A' }) }]); store = r.store;
  r = applyPersonalTrainingChanges(store, [{ kind: 'plan', id: 'plan-1', baseRev: 1, data: plan({ title: 'Device B' }) }]);
  assert.equal(r.results[0].status, 'conflict'); assert.equal(r.results[0].server.data.title, 'Device A'); assert.equal(r.store, null, 'nothing overwritten');
  // Delete keeps a tombstone; an offline device cannot bring it back with a stale revision.
  r = applyPersonalTrainingChanges(store, [{ kind: 'plan', id: 'plan-1', baseRev: 2, deleted: true }]); store = r.store;
  assert.equal(store.plans['plan-1'].deleted, true); assert.equal(store.plans['plan-1'].rev, 3);
  r = applyPersonalTrainingChanges(store, [{ kind: 'plan', id: 'plan-1', baseRev: 2, data: plan() }]);
  assert.equal(r.results[0].status, 'conflict');
});

test('validation: Master v31 limits; results are always athlete-entered and unverified', () => {
  const bad = (data, kind = 'day') => applyPersonalTrainingChanges(emptyPersonalTraining(), [{ kind, id: 'x-1', baseRev: 0, data }]).results[0];
  assert.equal(bad(plan({ sets: [{ id: 'p', reps: 0, distance: 100 }] }), 'plan').status, 'invalid');
  assert.equal(bad(plan({ sets: [{ id: 'p', reps: 4, distance: 4000 }] }), 'plan').status, 'invalid');
  assert.equal(bad(plan({ until: '2028-01-01' }), 'plan').status, 'invalid', 'weekly series limited to one year');
  assert.equal(bad(plan({ start: '08:00', end: '07:00' }), 'plan').status, 'invalid');
  assert.equal(bad(day({ sessions: [{ ...day().sessions[0], effort: 11 }] })).status, 'invalid');
  const s = day().sessions[0];
  assert.equal(bad(day({ sessions: [{ ...s, sets: [{ ...s.sets[0], results: [{ rep: 1, swimTime: 'fast' }] }] }] })).status, 'invalid');
  assert.equal(bad(day({ sessions: [{ ...s, sets: [{ ...s.sets[0], results: [{ rep: 1, swimTime: '1:10' }, { rep: 1, swimTime: '1:11' }] }] }] })).status, 'invalid', 'no duplicate repetition');
  assert.equal(bad(day({ sessions: [{ ...s, sets: [{ ...s.sets[0], results: [{ rep: 4, swimTime: '1:10' }] }] }] })).status, 'invalid', 'rep beyond the set');
  const normalized = normalizeDay(day());
  assert.equal(normalized.sessions[0].sets[0].results[0].verification, 'athlete-entered-unverified', 'a client cannot mark its own result as validated');
  assert.deepEqual(normalized.sessions[0].sets[0].results[0].cumulativeSplits, ['17.9', '36.4', '54.6', '1:12.40']);
});

test('the store path is derived from a hash of the account, never from raw input', () => {
  const p = personalTrainingPath('/srv/storage', '../../etc/passwd');
  assert.ok(p.startsWith('/srv/storage/athletes/'));
  assert.ok(!p.includes('..'));
  assert.notEqual(personalTrainingPath('/s', 'a'), personalTrainingPath('/s', 'b'));
  assert.equal(personalTrainingPath('/s', 'Ann'), personalTrainingPath('/s', 'ann'));
});

const seedAthletes = (paths) => {
  const file = path.join(paths.storageRoot, 'auth', 'auth-users.json');
  const users = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = new Date().toISOString();
  users.push({ username: 'athlete.one', password: 'Athlete!Pass1234', role: 'swimmer', tenantId: 'tenant-a', clubId: 'club-a', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now, email: 'one@example.com' });
  users.push({ username: 'athlete.two', password: 'Athlete!Pass1234', role: 'swimmer', tenantId: 'tenant-a', clubId: 'club-a', createdVia: 'admin', isApproved: true, onboardingCompletedAt: now, email: 'two@example.com' });
  writeJson(file, users); writeJson(path.join(paths.storageRoot, 'auth', 'auth-users.backup.json'), users);
};
const sync = (base, auth, changes) => request(base, '/swimmer/personal-training/sync', { ...auth, method: 'POST', body: { changes } });

test('personal training: saved per athlete, survives restart, private, never touches club data', async () => {
  let server = await startServer({}, seedAthletes);
  try {
    const clubDbFile = path.join(server.tempRoot, 'storage', 'tenants', 'tenant-a', 'db.json');
    const clubBefore = fs.readFileSync(clubDbFile, 'utf8');
    let one = await login(server.baseUrl, 'athlete.one', 'Athlete!Pass1234');
    const saved = await sync(server.baseUrl, one, [{ kind: 'plan', id: 'plan-1', baseRev: 0, data: plan() }, { kind: 'day', id: 'day-1', baseRev: 0, data: day() }]);
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    assert.deepEqual(saved.payload.results.map((r) => r.status), ['applied', 'applied']);
    // Application restart and a new sign-in: the records are still there.
    server = await server.restart();
    one = await login(server.baseUrl, 'athlete.one', 'Athlete!Pass1234');
    const list = await request(server.baseUrl, '/swimmer/personal-training', one);
    assert.equal(list.response.status, 200);
    assert.equal(list.payload.plans[0].data.title, 'Threshold');
    assert.equal(list.payload.days[0].data.sessions[0].sets[0].results[0].swimTime, '1:12.40');
    assert.equal(list.payload.days[0].data.sessions[0].effort, 7);
    // Another athlete of the same club sees nothing of it; coaches and anonymous users are refused.
    const two = await login(server.baseUrl, 'athlete.two', 'Athlete!Pass1234');
    const other = await request(server.baseUrl, '/swimmer/personal-training', two);
    assert.deepEqual([other.payload.plans.length, other.payload.days.length], [0, 0]);
    const coach = await login(server.baseUrl, 'coachA', 'CoachA!Pass1234');
    assert.equal((await request(server.baseUrl, '/swimmer/personal-training', coach)).response.status, 403);
    assert.equal((await request(server.baseUrl, '/swimmer/personal-training')).response.status, 401);
    // The club's database was not touched.
    assert.equal(fs.readFileSync(clubDbFile, 'utf8'), clubBefore);
  } finally { await server.stop(); }
});

test('personal training: two devices conflict without overwriting; a failed save changes nothing', async () => {
  let server = await startServer({}, seedAthletes);
  try {
    const a = await login(server.baseUrl, 'athlete.one', 'Athlete!Pass1234');
    const b = await login(server.baseUrl, 'athlete.one', 'Athlete!Pass1234');
    await sync(server.baseUrl, a, [{ kind: 'plan', id: 'plan-1', baseRev: 0, data: plan() }]);
    // Both devices hold rev 1; device A saves first, device B's offline edit then conflicts.
    const first = await sync(server.baseUrl, a, [{ kind: 'plan', id: 'plan-1', baseRev: 1, data: plan({ title: 'From phone' }) }]);
    const second = await sync(server.baseUrl, b, [{ kind: 'plan', id: 'plan-1', baseRev: 1, data: plan({ title: 'From tablet' }) }]);
    assert.equal(first.payload.results[0].status, 'applied');
    assert.equal(second.payload.results[0].status, 'conflict');
    assert.equal(second.payload.results[0].server.data.title, 'From phone');
    // Simultaneous creates of the same record from two devices: one record, no duplicate.
    const [x, y] = await Promise.all([sync(server.baseUrl, a, [{ kind: 'day', id: 'day-9', baseRev: 0, data: day() }]), sync(server.baseUrl, b, [{ kind: 'day', id: 'day-9', baseRev: 0, data: day() }])]);
    assert.deepEqual([x.payload.results[0].status, y.payload.results[0].status], ['applied', 'applied']);
    assert.equal((await request(server.baseUrl, '/swimmer/personal-training', a)).payload.days.length, 1);
    await server.stop();
    // Save failure: 503, nothing written; the device keeps its change and retries later.
    server = await startServer({ ATHLYRAX_TEST_FAIL_PERSONAL_TRAINING_WRITE: '1' }, seedAthletes);
    const c = await login(server.baseUrl, 'athlete.one', 'Athlete!Pass1234');
    const failed = await sync(server.baseUrl, c, [{ kind: 'plan', id: 'plan-2', baseRev: 0, data: plan() }]);
    assert.equal(failed.response.status, 503);
    assert.match(failed.payload.error, /stays on this device/);
    assert.equal((await request(server.baseUrl, '/swimmer/personal-training', c)).payload.plans.length, 0);
  } finally { await server.stop(); }
});
