import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeAthleteTenantConnections,
  deactivateAthleteTenantConnection,
  mergeAthleteHomeProjections,
  normalizeAthleteTenantRegistry,
  upsertAthleteTenantConnection,
} from '../athlete-tenant-registry.mjs';

test('registry keeps multiple simultaneous athlete tenant connections without duplicates', () => {
  let rows = [];
  rows = upsertAthleteTenantConnection(rows, { tenantId: 'club-a', clubId: 'a', clubName: 'Club A' });
  rows = upsertAthleteTenantConnection(rows, { tenantId: 'club-b', clubId: 'b', clubName: 'Club B' });
  rows = upsertAthleteTenantConnection(rows, { tenantId: 'club-a', clubId: 'a', clubName: 'Club A Updated' });
  assert.deepEqual(rows.map((row) => row.tenantId), ['club-a', 'club-b']);
  assert.equal(rows[0].clubName, 'Club A Updated');
  assert.equal(rows.every((row) => row.status === 'active'), true);
});

test('registry rejects unsafe/global tenant values and disconnects one club without touching another', () => {
  const normalized = normalizeAthleteTenantRegistry([
    { tenantId: 'Club A', clubName: 'Club A' },
    { tenantId: 'global-owner', clubName: 'Owner' },
    { tenantId: '', clubName: 'Missing' },
  ]);
  assert.deepEqual(normalized.map((row) => row.tenantId), ['club-a']);

  let rows = upsertAthleteTenantConnection([], { tenantId: 'club-a', clubName: 'Club A' });
  rows = upsertAthleteTenantConnection(rows, { tenantId: 'club-b', clubName: 'Club B' });
  rows = deactivateAthleteTenantConnection(rows, 'club-a', '2026-08-28T10:00:00.000Z');
  assert.equal(rows.find((row) => row.tenantId === 'club-a').status, 'disconnected');
  assert.equal(rows.find((row) => row.tenantId === 'club-b').status, 'active');
});

test('active tenant resolution includes primary tenant once plus explicitly active connections only', () => {
  const authUser = {
    tenantId: 'club-b',
    athleteTenantConnections: [
      { tenantId: 'club-a', clubName: 'Club A', status: 'active' },
      { tenantId: 'club-b', clubName: 'Club B', status: 'approved' },
      { tenantId: 'club-c', clubName: 'Club C', status: 'disconnected' },
    ],
  };
  const rows = activeAthleteTenantConnections(authUser);
  assert.deepEqual(rows.map((row) => row.tenantId).sort(), ['club-a', 'club-b']);
});

test('projection merger combines authorised club sessions and preserves one athlete identity', () => {
  const merged = mergeAthleteHomeProjections([
    {
      athlete: { id: 'athlete-1', displayName: 'Athlete One' },
      clubConnections: [{ connectionId: 'a', clubId: 'club-a' }],
      sessions: [{ id: 'a-session', ownerClubId: 'club-a', sets: [{ id: 'a-set' }] }],
      disciplines: [{ id: 'swimming', name: 'Swimming' }],
    },
    {
      athlete: { id: 'athlete-1', displayName: 'Athlete One' },
      clubConnections: [{ connectionId: 'b', clubId: 'club-b' }],
      sessions: [{ id: 'b-session', ownerClubId: 'club-b', sets: [{ id: 'b-set' }] }],
      disciplines: [{ id: 'swimming', name: 'Swimming duplicate' }, { id: 'strength', name: 'Strength' }],
    },
  ]);
  assert.equal(merged.athlete.id, 'athlete-1');
  assert.deepEqual(merged.clubConnections.map((row) => row.clubId), ['club-a', 'club-b']);
  assert.deepEqual(merged.sessions.map((row) => row.id), ['a-session', 'b-session']);
  assert.deepEqual(merged.disciplines.map((row) => row.id), ['swimming', 'strength']);
});

test('projection merger refuses cross-tenant identity mismatch instead of combining athletes', () => {
  assert.throws(() => mergeAthleteHomeProjections([
    { athlete: { id: 'athlete-1' }, sessions: [] },
    { athlete: { id: 'athlete-2' }, sessions: [] },
  ]), /identity mismatch/);
});
