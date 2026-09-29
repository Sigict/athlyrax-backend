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
