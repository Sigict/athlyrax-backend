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
