import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAthleteCapabilityProjection } from '../athlete-capability-projection.mjs';

test('latest server-calculated snapshot becomes athlete integrated and swimming profile', () => {
  const result = buildAthleteCapabilityProjection([
    {
      id: 'snapshot-new',
      username: 'athlete.one',
      snapshotDate: '2026-08-29T10:00:00.000Z',
      summary: {
        radar: {
          labels: ['Technical Control', 'Efficiency', 'Robustness of Efficiency'],
          integrated: [80, 70, 90],
        },
      },
    },
    {
      id: 'snapshot-old',
      username: 'athlete.one',
      snapshotDate: '2026-08-20T10:00:00.000Z',
      summary: {
        radar: {
          labels: ['Technical Control', 'Efficiency', 'Robustness of Efficiency'],
          integrated: [70, 60, 80],
        },
      },
    },
    {
      id: 'other-athlete',
      username: 'someone.else',
      snapshotDate: '2026-08-30T10:00:00.000Z',
      summary: { radar: { labels: ['Wrong'], integrated: [100] } },
    },
  ], { username: 'athlete.one' });

  assert.equal(result.integratedProfile.score, 80);
  assert.equal(result.integratedProfile.trend, 10);
  assert.equal(result.integratedProfile.source, 'athlyrax_snapshot');
  assert.equal(result.integratedProfile.snapshotId, 'snapshot-new');
  assert.deepEqual(result.disciplines[0].graph.values, [80, 70, 90]);
  assert.deepEqual(result.disciplines[0].metrics.map((row) => row.label), [
    'Technical Control',
    'Efficiency',
    'Robustness of Efficiency',
  ]);
});

test('athlete projection exposes no invented capability when no saved server snapshot exists', () => {
  assert.deepEqual(
    buildAthleteCapabilityProjection([], { username: 'athlete.one' }),
    { integratedProfile: null, disciplines: [] },
  );
});

// ATHLYRAX_ATHLETE_CAPABILITY_SPEED_LEVEL
// EXPERIMENTAL v0.2 branch (replaces the previous engine's speed-level-rule test): a new timed swim is recalculated
// at once and changes only the domain its protocol belongs to (R2: M100 -> Anaerobic), on the absolute World Aquatics
// points / 10 scale; no other level domain changes.
test('athlete capability recalculates a new M100 into Anaerobic only, on the absolute scale', async () => {
  const demo = await import('../scripts/demo-showcase-dataset.mjs');
  const cap = await import('../athlete-club-capability.mjs');
  const db = demo.buildDemoTenantSeed();
  const s = db.swimmers[0];
  const before = cap.buildClubCapabilityProfile(db, s, { tenantId: 'demo' });
  const axis = (p, id) => p.axes.find((a) => a.id === id);
  const d = before.calculationDate;
  db.tests = [...(db.tests || []), { id: 't-max100', swimmerId: s.id, date: d, testDate: d, templateId: 'builtin-test-max', templateName: 'Max', testItemKey: 'M100', testName: 'M100', category: 'Swimming', repResults: [{ overallTime: '1:02.50', overallStrokeCount: '58' }], resultTime: '1:02.50', distance: 100, stroke: 'free', capabilityScoringEligible: true, completed: true, status: 'completed' }];
  const after = cap.buildClubCapabilityProfile(db, s, { tenantId: 'demo' });
  assert.notEqual(axis(after, 'anaerobic_capacity').value, axis(before, 'anaerobic_capacity').value, 'Anaerobic recalculated');
  assert.ok(axis(after, 'anaerobic_capacity').value > 0 && axis(after, 'anaerobic_capacity').value < 90, `absolute scale, not saturated: ${axis(after, 'anaerobic_capacity').value}`);
  for (const id of ['aerobic_capacity', 'power_speed_expression']) assert.equal(axis(after, id).value, axis(before, id).value, `${id} unchanged by an M100`);
});
