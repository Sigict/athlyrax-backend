const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();

function fixtureMatchesReference(row, reference) {
  const ref = text(reference);
  if (!ref) return false;
  return [row?.id, row?._id, row?.fixtureId, row?.fixtureReference]
    .map(text)
    .some((value) => value && value === ref);
}

function uniqueIds(values) {
  return Array.from(new Set(list(values).map(text).filter(Boolean)));
}

function canonicalizeEvents(rows) {
  return list(rows).map((row, index) => {
    const eventNumber = text(row?.eventN || row?.eventNumber || row?.number || (index + 1));
    const attendeeIds = uniqueIds(row?.attendeeIds);
    return {
      ...row,
      eventN: eventNumber,
      eventNumber,
      number: eventNumber,
      attendeeIds,
    };
  });
}

function ensureVenue(db, venueName) {
  const name = text(venueName) || 'TBC';
  const venues = list(db?.venues);
  const normalized = name.toLowerCase();
  const existing = venues.find((row) => text(row?.name || row?.venue).toLowerCase() === normalized);
  if (existing) return { venues, venueId: text(existing?.id), venueName: text(existing?.name || existing?.venue) || name };
  const id = `venue:${normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tbc'}`;
  return {
    venues: [...venues, { id, name, venue: name }],
    venueId: id,
    venueName: name,
  };
}

export function applyTargetedFixtureSave(db = {}, input = {}) {
  const fixtureReference = text(input?.fixtureReference);
  if (!fixtureReference) return { ok: false, status: 400, error: 'Fixture reference is required.' };
  const fixtures = list(db?.fixtures);
  const index = fixtures.findIndex((row) => fixtureMatchesReference(row, fixtureReference));
  if (index < 0) return { ok: false, status: 404, error: 'Fixture was not found.' };

  const name = text(input?.name);
  const startDate = text(input?.startDate);
  const endDate = text(input?.endDate);
  if (!name) return { ok: false, status: 400, error: 'Fixture name is required.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate) {
    return { ok: false, status: 400, error: 'Fixture dates are invalid.' };
  }

  const venue = ensureVenue(db, input?.venue);
  const now = text(input?.updatedAt) || new Date().toISOString();
  const current = fixtures[index] || {};
  const nextFixture = {
    ...current,
    name,
    startDate,
    endDate,
    competitionType: text(input?.competitionType) || 'Competition',
    type: text(input?.competitionType) || text(current?.type) || 'Competition',
    venue: venue.venueName,
    venueId: text(input?.venueId) || venue.venueId,
    startTime: text(input?.startTime) || '09:00',
    endTime: text(input?.endTime) || '18:00',
    isMainEvent: Boolean(input?.isMainEvent),
    weekendOnly: Boolean(input?.weekendOnly),
    squadIds: uniqueIds(input?.squadIds),
    coachIds: uniqueIds(input?.coachIds),
    substituteCoachIds: uniqueIds(input?.substituteCoachIds),
    substitutionCoachIds: uniqueIds(input?.substituteCoachIds),
    coverCoachIds: uniqueIds(input?.substituteCoachIds),
    coverCoachId: uniqueIds(input?.substituteCoachIds)[0] || '',
    attendeeIds: uniqueIds(input?.attendeeIds),
    events: canonicalizeEvents(input?.events),
    licenceNumber: text(input?.licenceNumber || input?.licenseNumber || input?.officialReference),
    licenseNumber: text(input?.licenceNumber || input?.licenseNumber || input?.officialReference),
    officialReference: text(input?.officialReference || input?.licenceNumber || input?.licenseNumber),
    officialFixtureUrl: text(input?.officialFixtureUrl),
    officialResultsUrl: text(input?.officialResultsUrl),
    officialSource: text(input?.officialSource || 'Swim England'),
    notes: String(input?.notes ?? ''),
    updatedAt: now,
    updatedBy: text(input?.updatedBy),
  };

  const nextFixtures = fixtures.slice();
  nextFixtures[index] = nextFixture;
  return {
    ok: true,
    db: { ...db, fixtures: nextFixtures, venues: venue.venues, __meta: { ...(db?.__meta || {}), updatedAt: now } },
    fixture: nextFixture,
    venue: venue.venues.find((row) => text(row?.id) === text(nextFixture.venueId)) || null,
  };
}
