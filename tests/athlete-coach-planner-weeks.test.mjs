// The athlete sees the coach's Training Planner for their own squad, read-only (22-11-2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAthleteHomeProjection } from '../athlete-home-projection.mjs';
import { mergeAthleteHomeProjections } from '../athlete-tenant-registry.mjs';

const db = {
  swimmers: [{ id: 'sw1', firstName: 'Ann', lastName: 'Lee', currentSquadId: 'sqA', swimmerAccountUsername: 'ann' }],
  squads: [{ id: 'sqA', name: 'A' }, { id: 'sqB', name: 'B' }],
  trainingPlannerWeeks: [
    { id: 'w1', squadId: 'sqA', weekStart: '2026-09-07', phase: 'AEROBIC', cycleBlock: 'AEROBIC — Block 1 — Week 1/4', plannedVolume: 27200, targetCompetition: '', coachNotes: 'private note', ownerUsername: 'coach', updatedAt: '2026-09-01' },
    { id: 'w1b', squadId: 'sqA', weekStart: '2026-09-07', phase: 'INTRO', updatedAt: '2026-08-01' },
    { id: 'w2', squadId: 'sqA', weekStartKey: '2026-11-02', cyclePhase: 'taper', cycleBlock: 'TAPER — Week 1/3', plannedVolume: '17200', targetCompetition: 'Autumn Meet' },
    { id: 'empty', squadId: 'sqA', weekStart: '2026-11-30' },
    { id: 'deleted', squadId: 'sqA', weekStart: '2026-11-09', phase: 'TAPER', deletedAt: '2026-11-01' },
    { id: 'other', squadId: 'sqB', weekStart: '2026-09-07', phase: 'RACE' },
  ],
};

test('own squad only, newest row per week, placeholder and deleted weeks left out, only plan fields', () => {
  const p = buildAthleteHomeProjection(db, { username: 'ann', swimmerId: 'sw1', role: 'swimmer' }, {});
  assert.deepEqual(p.coachPlannerWeeks, [
    { weekStart: '2026-09-07', phase: 'AEROBIC', cycleBlock: 'AEROBIC — Block 1 — Week 1/4', plannedVolume: 27200, targetCompetition: '' },
    { weekStart: '2026-11-02', phase: 'TAPER', cycleBlock: 'TAPER — Week 1/3', plannedVolume: 17200, targetCompetition: 'Autumn Meet' },
  ]);
  assert.equal(JSON.stringify(p.coachPlannerWeeks).includes('private note'), false);
  assert.equal(JSON.stringify(p.coachPlannerWeeks).includes('coach'), false);
});

test('a swimmer without a squad gets no coach plan; merging keeps one row per week', () => {
  const noSquad = { ...db, swimmers: [{ ...db.swimmers[0], currentSquadId: '' }] };
  assert.deepEqual(buildAthleteHomeProjection(noSquad, { username: 'ann', swimmerId: 'sw1', role: 'swimmer' }, {}).coachPlannerWeeks, []);
  const p = buildAthleteHomeProjection(db, { username: 'ann', swimmerId: 'sw1', role: 'swimmer' }, {});
  const merged = mergeAthleteHomeProjections([{ ...p, primaryTenantProjection: true }, { ...p, primaryTenantProjection: false }]);
  assert.equal(merged.coachPlannerWeeks.length, 2);
});
