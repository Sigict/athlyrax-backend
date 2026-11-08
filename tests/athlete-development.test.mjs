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

import { normalizeWeekPlan, normalizeGoal } from '../athlete-development.mjs';

test('weekly planner rows: Monday week, the five canonical phases, cycle note, target fixture', () => {
  assert.deepEqual(normalizeWeekPlan({ week: '2026-11-09', phase: 'Aerobic', cycle: 'Block A', targetFixtureId: 'fx-1' }).phase, 'Aerobic');
  assert.throws(() => normalizeWeekPlan({ week: '2026-11-10', phase: 'Aerobic' }), /Monday/);
  assert.throws(() => normalizeWeekPlan({ week: '2026-11-09', phase: 'Recovery' }), /Intro, Aerobic, Specific, Race or Taper/);
  assert.equal(normalizeWeekPlan({ week: '2026-11-09', phase: 'Race' }).phase, 'Race', 'the fifth canonical phase');
  for (const p of ['Intro', 'Aerobic', 'Specific', 'Taper']) assert.equal(normalizeWeekPlan({ week: '2026-11-09', phase: p }).phase, p, 'existing saved phases stay valid');
  assert.equal(normalizeWeekPlan({ week: '2026-11-09' }).phase, '');
});

test('goals (Master v31): text required, horizon and category from the Master lists, done is a self-report', () => {
  const g = normalizeGoal({ text: 'Hold pace on 8x100', horizon: 'Medium-term', category: 'Durability', measure: '8x100 spread', done: true });
  assert.deepEqual([g.horizon, g.category, g.done], ['Medium-term', 'Durability', true]);
  assert.equal(normalizeGoal({ text: 'x', horizon: 'Forever', category: 'Magic' }).category, 'Other');
  assert.throws(() => normalizeGoal({ text: '' }), /goal/);
  let r = applyPersonalTrainingChanges(emptyPersonalTraining(), [{ kind: 'goal', id: 'goal-0001', baseRev: 0, data: { text: 'Sub 1:02' } }, { kind: 'week', id: '2026-11-09', baseRev: 0, data: { week: '2026-11-09', phase: 'Specific' } }]);
  assert.deepEqual(r.results.map((x) => x.status), ['applied', 'applied']);
  assert.deepEqual([listPersonalTraining(r.store).goals.length, listPersonalTraining(r.store).weeks.length], [1, 1]);
});
