import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyCoachObservation } from '../coach-observations.mjs';

test('canonical coach observation stores swimmer and optional session context', () => {
  const db = { swimmers: [{ id: 'sw-1' }], coachObservations: [] };
  const result = applyCoachObservation(db, {
    swimmerId: 'sw-1',
    date: '2026-09-29',
    notes: 'Held streamline under fatigue.',
    mainFocus: 'Turns',
    sessionId: 'session-1',
    scheduleId: 'schedule-1',
    setId: 'set-2',
    source: 'athlyrax-software',
    updatedBy: 'coach.one',
    updatedAt: '2026-09-29T15:30:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.observation.swimmerId, 'sw-1');
  assert.equal(result.observation.sessionId, 'session-1');
  assert.equal(result.observation.scheduleId, 'schedule-1');
  assert.equal(result.observation.setId, 'set-2');
  assert.equal(result.observation.notes, 'Held streamline under fatigue.');
  assert.equal(result.observation.source, 'athlyrax-software');
  assert.equal(result.db.coachObservations.length, 1);
});

test('poolside and software endpoints share the same observation mutation', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /app\.post\('\/coach\/observations'/);
  assert.match(source, /app\.post\('\/coach\/poolside\/sessions\/:sessionId\/swimmers\/:swimmerId\/observations'/);
  assert.ok((source.match(/applyCoachObservation\(db,/g) || []).length >= 2);
});


test('poolside projection exposes canonical swimmer observations for the selected day', async () => {
  const { buildCoachPoolsideProjection } = await import('../coach-poolside-projection.mjs');
  const db = {
    schedule: [{ id: 'sch-1', scheduleDate: '2026-09-29', squadIds: ['sq-1'] }],
    trainingSessions: [{ id: 'sess-1', scheduleId: 'sch-1', squadIds: ['sq-1'] }],
    swimmers: [{ id: 'sw-1', firstName: 'Test', lastName: 'Swimmer', currentSquadId: 'sq-1' }],
    coachObservations: [{
      id: 'obs-1',
      swimmerId: 'sw-1',
      sessionId: 'sess-1',
      scheduleId: 'sch-1',
      date: '2026-09-29',
      notes: 'Individual note',
      source: 'athlyrax-software',
    }],
  };
  const projection = buildCoachPoolsideProjection(db, { date: '2026-09-29' });
  assert.equal(projection.coachObservations.length, 1);
  assert.equal(projection.coachObservations[0].swimmerId, 'sw-1');
  assert.equal(projection.coachObservations[0].notes, 'Individual note');
});
