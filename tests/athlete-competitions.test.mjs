import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFixture, normalizeReflection, clubFixturesForSwimmer, FIXTURE_STATUSES } from '../athlete-competitions.mjs';
import { applyPersonalTrainingChanges, emptyPersonalTraining, listPersonalTraining } from '../athlete-personal-training.mjs';
import { buildClubResults } from '../athlete-tests-races.mjs';

const fixture = (over = {}) => ({ name: 'County Champs', date: '2026-12-05', endDate: '2026-12-06', deadline: '2026-11-20', course: 'LCM', status: 'Entry submitted', isMainEvent: true, venue: 'City pool', events: [{ id: 'e1', distance: 100, stroke: 'free', entryTime: '1:03.20', targetTime: '1:02.50' }], ...over });

test('fixtures follow Master v31: dates, course, status, events with plan times; always unverified', () => {
  const f = normalizeFixture(fixture());
  assert.equal(f.isMainEvent, true); assert.equal(f.events[0].targetTime, '1:02.50'); assert.equal(f.verification, 'athlete-entered-unverified');
  assert.equal(FIXTURE_STATUSES.length, 6);
  assert.throws(() => normalizeFixture(fixture({ name: '' })), /meet name/);
  assert.throws(() => normalizeFixture(fixture({ endDate: '2026-12-01' })), /last competition day/);
  assert.throws(() => normalizeFixture(fixture({ deadline: '2026-12-10' })), /deadline/);
  assert.throws(() => normalizeFixture(fixture({ course: 'XX' })), /Course/);
  assert.throws(() => normalizeFixture(fixture({ status: 'Won' })), /status/);
  assert.throws(() => normalizeFixture(fixture({ events: [{ distance: 75, stroke: 'free' }] })), /distance/);
  assert.throws(() => normalizeFixture(fixture({ events: [{ distance: 100, stroke: 'free', targetTime: 'fast' }] })), /times/);
  assert.equal(normalizeFixture({ ...fixture(), verification: 'validated' }).verification, 'athlete-entered-unverified');
});

test('competition reflections: Master v31 answers only', () => {
  const r = normalizeReflection({ date: '2026-12-06', meet: 'County Champs', recovery: 'Good', preparation: 'Partly', satisfaction: 'Satisfied', note: 'Strong finish' });
  assert.equal(r.recovery, 'Good');
  assert.throws(() => normalizeReflection({ date: '2026-12-06', meet: 'X', recovery: 'Superb' }), /recovery/);
  assert.throws(() => normalizeReflection({ date: 'bad', meet: 'X' }), /name and date/);
});

test('fixtures and reflections sync in the personal store with revisions and conflicts', () => {
  let r = applyPersonalTrainingChanges(emptyPersonalTraining(), [{ kind: 'fixture', id: 'fx-1', baseRev: 0, data: fixture() }, { kind: 'reflection', id: 'rf-1', baseRev: 0, data: { date: '2026-12-06', meet: 'County Champs', satisfaction: 'Mixed' } }]);
  assert.deepEqual(r.results.map((x) => x.status), ['applied', 'applied']);
  const listed = listPersonalTraining(r.store);
  assert.equal(listed.fixtures.length, 1); assert.equal(listed.reflections.length, 1);
  const store = r.store;
  r = applyPersonalTrainingChanges(store, [{ kind: 'fixture', id: 'fx-1', baseRev: 0, data: fixture({ name: 'Stale device' }) }]);
  assert.equal(r.results[0].status, 'conflict');
  r = applyPersonalTrainingChanges(store, [{ kind: 'fixture', id: 'fx-2', baseRev: 0, data: fixture({ date: 'x' }) }]);
  assert.equal(r.results[0].status, 'invalid');
  // Older stores (before fixtures existed) still load and accept the new kinds.
  r = applyPersonalTrainingChanges({ version: 1, plans: {}, days: {}, tests: {} }, [{ kind: 'fixture', id: 'fx-3', baseRev: 0, data: fixture() }]);
  assert.equal(r.results[0].status, 'applied'); assert.ok(r.store.plans && r.store.fixtures['fx-3']);
});

test('club fixtures: only upcoming events the linked swimmer is entered in, read-only, scope applies', () => {
  const db = { swimmers: [{ id: 's1' }, { id: 's2' }], fixtures: [
    { id: 'f-up', name: 'Winter Open', startDate: '2026-12-12', events: [{ id: 'ev1', distance: 100, stroke: 'free', attendeeIds: ['s1'] }, { id: 'ev2', distance: 50, stroke: 'fly', attendeeIds: ['s2'] }] },
    { id: 'f-past', name: 'Autumn', startDate: '2026-10-01', events: [{ id: 'ev3', distance: 100, stroke: 'free', attendeeIds: ['s1'] }] },
    { id: 'f-other', name: 'Not entered', startDate: '2026-12-20', events: [{ id: 'ev4', distance: 200, stroke: 'free', attendeeIds: ['s2'] }] },
  ] };
  const before = JSON.stringify(db);
  const mine = clubFixturesForSwimmer(db, 's1', { today: '2026-11-08' });
  assert.deepEqual(mine.map((f) => [f.id, f.events.map((e) => e.id)]), [['f-up', ['ev1']]]);
  assert.equal(JSON.stringify(db), before);
  assert.deepEqual(clubFixturesForSwimmer(db, '', { today: '2026-11-08' }), []);
  assert.deepEqual(buildClubResults(db, 's1', { dataScopes: ['tests'] }).fixtures, [], 'competition scope controls club fixtures');
});
