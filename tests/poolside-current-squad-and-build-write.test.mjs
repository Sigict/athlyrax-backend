import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildCoachPoolsideProjection } from '../coach-poolside-projection.mjs';

test('a swimmer recorded with currentSquadId only is in the Pool Console with their observation', () => {
  const db = {
    schedule: [{ id: 'sch-1', scheduleDate: '2026-09-29', squadIds: ['sq-1'] }],
    trainingSessions: [{ id: 'sess-1', scheduleId: 'sch-1', squadIds: ['sq-1'] }],
    swimmers: [
      { id: 'sw-current', firstName: 'Current', lastName: 'Only', currentSquadId: 'sq-1' },
      { id: 'sw-other', firstName: 'Other', lastName: 'Squad', currentSquadId: 'sq-2' },
    ],
    coachObservations: [{ id: 'obs-1', swimmerId: 'sw-current', sessionId: 'sess-1', date: '2026-09-29', notes: 'note' }],
  };
  const p = buildCoachPoolsideProjection(db, { date: '2026-09-29' });
  assert.deepEqual(p.swimmers.map((s) => s.id), ['sw-current'], 'other squads stay out');
  assert.equal(p.coachObservations.length, 1);
});

test('the production build keeps the compact atomic write for poolside changes', () => {
  const patch = fs.readFileSync(new URL('../scripts/patch-coach-poolside-api.mjs', import.meta.url), 'utf8');
  assert.match(patch, /writeAtomicJsonFileCompact\(tenantScope\.storagePaths\.dbPath, output\.db\)/);
  assert.doesNotMatch(patch, /\twriteAtomicJsonFile\(tenantScope\.storagePaths\.dbPath, output\.db\)/);
});
