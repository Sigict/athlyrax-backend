import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLegacy, normalizeOrigin, normalizeProfile } from '../athlete-development.mjs';
import { applyPersonalTrainingChanges, emptyPersonalTraining, listPersonalTraining } from '../athlete-personal-training.mjs';

const origin = { from: 'athlete-master-v31', originalId: 'entry-1', originalType: 'Max effort test', sourceLabel: 'athlete-entered; not independently verified', importedAt: '2026-11-08T10:00:00Z' };

test('legacy archive: original values kept, read-only, never used in capability, only from an import', () => {
  const original = { id: 'entry-75', type: 'Max effort test', distance: 75, stroke: 'Free', time: '45.20', splits: '21.80, 45.20', strokes: '14, 15', date: '2025-03-01', source: { kind: 'athlete-entered' } };
  const l = normalizeLegacy({ originalType: 'Max effort test', date: '2025-03-01', reason: 'Max 75 is not an active AthlyraX test', original, origin });
  assert.deepEqual(l.original, original);
  assert.deepEqual([l.readOnly, l.usedInCapability, l.verification], [true, false, 'athlete-entered-unverified']);
  assert.throws(() => normalizeLegacy({ original }), /imported backup/);
  assert.throws(() => normalizeLegacy({ origin }), /original record/);
  assert.equal(normalizeOrigin({ from: 'somewhere' }), null);
});

test('profile: the athlete\'s own details only', () => {
  assert.deepEqual(normalizeProfile({ preferredName: 'Lu', sex: 'Male', mainEvent: '100 free', dob: '2004-01-02' }).mainEvent, '100 free');
  assert.throws(() => normalizeProfile({ sex: 'X' }), /marker/);
  assert.throws(() => normalizeProfile({ dob: 'bad' }), /Date of birth/);
});

test('imports keep provenance and are safe to repeat (no duplicate, no new revision)', () => {
  const race = { protocolId: 'race', date: '2025-06-01', stroke: 'free', course: 'SCM', distance: 100, time: '1:02.40', splitMode: 'cumulative', splits: ['29.90', '1:02.40'], strokes: [17, 19], origin: { ...origin, originalType: 'Competition race' } };
  let r = applyPersonalTrainingChanges(emptyPersonalTraining(), [{ kind: 'test', id: 'm31-test-entry-1', baseRev: 0, data: race }, { kind: 'legacy', id: 'm31-legacy-entry-75', baseRev: 0, data: { originalType: 'Max effort test', original: { distance: 75 }, origin } }]);
  assert.deepEqual(r.results.map((x) => x.status), ['applied', 'applied']);
  const store = r.store;
  assert.equal(store.tests['m31-test-entry-1'].data.origin.from, 'athlete-master-v31');
  assert.equal(store.tests['m31-test-entry-1'].data.origin.originalId, 'entry-1');
  r = applyPersonalTrainingChanges(store, [{ kind: 'test', id: 'm31-test-entry-1', baseRev: 0, data: race }]);
  assert.equal(r.results[0].status, 'applied'); assert.equal(r.results[0].unchanged, true); assert.equal(r.store, null, 'repeat import changes nothing');
  assert.equal(listPersonalTraining(store).legacy.length, 1);
  // An unknown origin is dropped, never trusted.
  r = applyPersonalTrainingChanges(emptyPersonalTraining(), [{ kind: 'diary', id: 'diary-0001', baseRev: 0, data: { date: '2026-11-01', note: 'x', origin: { from: 'evil' } } }]);
  assert.equal(r.store.diary['diary-0001'].data.origin, undefined);
});
