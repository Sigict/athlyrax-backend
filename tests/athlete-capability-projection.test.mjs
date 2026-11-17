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
test('athlete capability follows the ISP speed-level rule: no timed swim -> consistency areas Not Scored; a timed swim scales them', async () => {
  const demo = await import('../scripts/demo-showcase-dataset.mjs');
  const cap = await import('../athlete-club-capability.mjs');
  const db = demo.buildDemoTenantSeed();
  const s = db.swimmers[0];
  const before = cap.buildClubCapabilityProfile(db, s, { tenantId: 'demo' });
  const aerobic = (p) => p.axes.find((a) => a.id === 'aerobic_capacity');
  assert.equal(aerobic(before).value, null);
  assert.match(aerobic(before).reasons[0], /Needs a timed test or race/);
  const d = before.calculationDate;
  db.tests = [...(db.tests || []), { id: 't-max100', swimmerId: s.id, date: d, testDate: d, templateId: 'builtin-test-max', testItemKey: 'M100', testName: 'M100', category: 'Swimming', repResults: [{ overallTime: '1:02.50', overallStrokeCount: '58' }], resultTime: '1:02.50', distance: 100, stroke: 'free', capabilityScoringEligible: true, completed: true, status: 'completed' }];
  const after = cap.buildClubCapabilityProfile(db, s, { tenantId: 'demo' });
  assert.ok(aerobic(after).value > 0 && aerobic(after).value < 90, `aerobic is speed-scaled, not saturated: ${aerobic(after).value}`);
});
