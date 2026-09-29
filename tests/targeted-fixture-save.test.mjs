import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTargetedFixtureSave } from '../targeted-fixture-save.mjs';

test('targeted fixture save updates only canonical fixture data', () => {
  const db = {
    fixtures: [{
      id: 'fx1',
      name: 'Old',
      startDate: '2026-10-01',
      endDate: '2026-10-01',
      venue: 'Old Venue',
      squadIds: ['s1'],
      coachIds: ['c1'],
      attendeeIds: ['sw1'],
      events: [{ id: 'ev1', eventN: '1', eventNumber: '1', number: '1', attendeeIds: ['sw1'] }],
    }],
    venues: [{ id: 'v-old', name: 'Old Venue' }],
    swimmers: [{ id: 'sw1', name: 'A' }],
  };
  const result = applyTargetedFixtureSave(db, {
    fixtureReference: 'fx1',
    name: 'New Gala',
    startDate: '2026-10-02',
    endDate: '2026-10-03',
    competitionType: 'Competition',
    venue: 'New Pool',
    startTime: '08:00',
    endTime: '18:00',
    isMainEvent: true,
    weekendOnly: true,
    squadIds: ['s2'],
    coachIds: ['c2'],
    substituteCoachIds: ['c3'],
    attendeeIds: ['sw1','sw2'],
    events: [{ id: 'ev1', eventN: '2', attendeeIds: ['sw2'] }],
    notes: 'note',
  });
  assert.equal(result.ok, true);
  assert.equal(result.fixture.name, 'New Gala');
  assert.equal(result.fixture.eventN, undefined);
  assert.equal(result.fixture.events[0].eventN, '2');
  assert.equal(result.fixture.events[0].eventNumber, '2');
  assert.equal(result.fixture.events[0].number, '2');
  assert.deepEqual(result.fixture.substituteCoachIds, ['c3']);
  assert.deepEqual(result.fixture.coverCoachIds, ['c3']);
  assert.equal(result.fixture.coverCoachId, 'c3');
  assert.equal(result.fixture.venue, 'New Pool');
  assert.ok(result.db.venues.some((row) => row.name === 'New Pool'));
  assert.deepEqual(result.db.swimmers, db.swimmers);
});
