import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDiary, DIARY_TYPES } from '../athlete-development.mjs';
import { applyPersonalTrainingChanges, emptyPersonalTraining, listPersonalTraining } from '../athlete-personal-training.mjs';

test('diary entries follow Master v31: any date, day type, feeling or note, private unless shared', () => {
  const d = normalizeDiary({ date: '2026-11-07', type: 'Rest day', feel: 'Tired', note: 'Slept badly' });
  assert.deepEqual([d.type, d.feel, d.visibility], ['Rest day', 'Tired', 'private']);
  assert.equal(normalizeDiary({ date: '2026-11-07', feel: 'Good', visibility: 'share_with_coach' }).visibility, 'share_with_coach');
  assert.equal(normalizeDiary({ date: '2026-11-07', feel: 'Good', visibility: 'everyone' }).visibility, 'private');
  assert.equal(DIARY_TYPES.length, 5);
  assert.throws(() => normalizeDiary({ date: 'x', feel: 'Good' }), /date/);
  assert.throws(() => normalizeDiary({ date: '2026-11-07' }), /feeling or note/);
  assert.throws(() => normalizeDiary({ date: '2026-11-07', feel: 'Amazing' }), /feeling/);
});

test('diary syncs in the personal store; older stores still load', () => {
  let r = applyPersonalTrainingChanges(emptyPersonalTraining(), [{ kind: 'diary', id: 'dy-1', baseRev: 0, data: { date: '2026-11-07', feel: 'Good' } }]);
  assert.equal(r.results[0].status, 'applied');
  assert.equal(listPersonalTraining(r.store).diary.length, 1);
  r = applyPersonalTrainingChanges(r.store, [{ kind: 'diary', id: 'dy-1', baseRev: 0, data: { date: '2026-11-07', feel: 'OK' } }]);
  assert.equal(r.results[0].status, 'conflict');
  r = applyPersonalTrainingChanges({ version: 1, plans: {}, days: {}, tests: {} }, [{ kind: 'diary', id: 'dy-2', baseRev: 0, data: { date: '2026-11-07', note: 'x' } }]);
  assert.equal(r.results[0].status, 'applied');
});
