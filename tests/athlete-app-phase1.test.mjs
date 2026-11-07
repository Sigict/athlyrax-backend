import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildScopedAthlyraxCapabilitySnapshot } from '../capability-engine/src/utils/scopedCapabilitySnapshot.js';
import { officialCapabilityRadar } from '../capability-engine/src/utils/officialCapabilityRadar.js';
import { buildClubCapabilityProfile, currentCapabilitySeason } from '../athlete-club-capability.mjs';
import { buildAthleteHomeProjection } from '../athlete-home-projection.mjs';
import { buildCoachPoolsideProjection } from '../coach-poolside-projection.mjs';
import { engineFixtureDb } from './fixtures/capability-engine-fixture.mjs';

const SEASON = { key: '2025-2026', label: '2025/26', start: '2025-09-01', end: '2026-08-31' };

test('the server copy of the capability engine is byte-identical to its manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../capability-engine/manifest.json', import.meta.url), 'utf8'));
  const root = new URL('../capability-engine/', import.meta.url).pathname;
  const onDisk = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) onDisk.push(path.relative(root, p)); } };
  walk(path.join(root, 'src'));
  assert.deepEqual(onDisk.sort(), Object.keys(manifest.files).sort(), 'no file added or missing');
  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), hash, `${file} unchanged`);
  }
  assert.match(manifest.sourceCommit, /^[0-9a-f]{40}$/);
});

test('club profile = the ISP engine result for the linked swimmer (same call, nothing estimated)', () => {
  const swimmer = engineFixtureDb.swimmers[0];
  const profile = buildClubCapabilityProfile(engineFixtureDb, swimmer, { season: SEASON, today: '2026-11-07' });
  const isp = buildScopedAthlyraxCapabilitySnapshot({
    db: engineFixtureDb,
    scope: { swimmerId: swimmer.id, squadId: swimmer.currentSquadId, seasonStartDate: SEASON.start, startDate: SEASON.start, endDate: SEASON.end },
    activeWindow: { start: SEASON.start, end: SEASON.end },
    activeAccountId: '', activeTenantId: '', calculationDate: SEASON.end,
  });
  assert.equal(profile.source, 'club_evidence');
  assert.equal(profile.evidenceType, 'validated');
  assert.equal(profile.axes.length, 8, 'the eight AthlyraX capability axes');
  assert.equal(profile.calculationDate, '2026-08-31', 'season ended: calculated at season end, as the ISP does');
  assert.equal(profile.score, Math.round(isp.integratedScore));
  // Same display rule as the ISP (swimmersIspEvidence axisValueRows): official radar score, only with evidence.
  const official = officialCapabilityRadar(isp, isp.axes.map((axis) => axis.key));
  for (const axis of profile.axes) {
    const ref = isp.axes.find((row) => row.key === axis.id);
    const shown = Number(ref.evidenceCount) > 0 && Number.isFinite(official.scores[ref.key]) ? Math.round(official.scores[ref.key]) : null;
    assert.equal(axis.value, shown, axis.id);
    assert.equal(axis.validation, shown === null ? 'Not Scored' : String(ref.validation || 'Not Scored'), `${axis.id} validation`);
    if (!axis.scored) assert.ok(axis.reasons.length, `${axis.id}: an unscored axis says why`);
  }
  assert.ok(profile.measuredAxes >= 1 && profile.measuredAxes < 8, 'partial evidence: some axes measured, none invented');
  assert.equal(profile.fullRadarAvailable, false);
});

test('a swimmer without club evidence gets an honest empty profile, not invented values', () => {
  const db = { ...engineFixtureDb, swimmers: [...engineFixtureDb.swimmers, { id: 'new-swimmer', firstName: 'New', currentSquadId: 'squad-2' }] };
  const profile = buildClubCapabilityProfile(db, db.swimmers.at(-1), { season: SEASON, today: '2026-11-07' });
  assert.equal(profile.measuredAxes, 0);
  assert.equal(profile.score, null);
  assert.ok(profile.axes.every((axis) => axis.value === null && axis.reasons.length));
});

test('current season comes from the shared sport configuration (same as the ISP)', () => {
  assert.deepEqual(currentCapabilitySeason(), SEASON);
});

const plannerDb = (extra = {}) => ({
  squads: [{ id: 'sq', name: 'Performance A' }],
  swimmers: [{ id: 'sw-1', firstName: 'Lucas', lastName: 'Price', squadId: 'sq', swimmerAccountUsername: 'lucas.app' }],
  schedule: [{ id: 'sch-1', scheduleDate: '2026-11-11', squadIds: ['sq'], mainFocus: 'Tuesday threshold - coach name', startTime: '06:00', endTime: '07:00' }],
  trainingSessions: [{ id: 'ts-1', scheduleId: 'sch-1', mainFocus: 'Power & Speed Expression', title: 'Power & Speed Expression' }],
  trainingSessionSets: [{ id: 'set-1', trainingSessionId: 'ts-1', reps: 3, distance: 100, sendOff: '1:40' }],
  ...extra,
});

test('Athlete App shows the coach\'s session name; the capability focus stays the focus', () => {
  const home = buildAthleteHomeProjection(plannerDb(), { username: 'lucas.app', athleteInviteManaged: true });
  const session = home.sessions.find((row) => row.id === 'ts-1');
  assert.equal(session.title, 'Tuesday threshold - coach name');
  assert.equal(session.mainFocus, 'Power & Speed Expression');
  assert.equal(session.sets[0].sendoff, '1:40');
});

test('Coach Console shows the coach\'s session name for Planner sessions on cycle dates', () => {
  const projection = buildCoachPoolsideProjection(plannerDb(), { date: '2026-11-11' });
  assert.equal(projection.sessions[0].title, 'Tuesday threshold - coach name');
});

test('Athlete App profile comes from the club evidence of the linked swimmer only', () => {
  const db = { ...engineFixtureDb, swimmers: engineFixtureDb.swimmers.map((row) => ({ ...row, swimmerAccountUsername: 'swimmer.app' })) };
  const home = buildAthleteHomeProjection(db, { username: 'swimmer.app', athleteInviteManaged: true });
  assert.equal(home.integratedProfile.source, 'club_evidence');
  assert.equal(home.disciplines[0].id, 'swimming');
  assert.equal(home.disciplines[0].metrics.length, 8);
  const other = buildAthleteHomeProjection(db, { username: 'someone.else', athleteInviteManaged: true });
  assert.equal(other, null, 'no profile for an account without the explicit link');
});

test('an axis with a score but no evidence is Not Scored, exactly as the ISP shows it', async () => {
  const engine = await import('../capability-engine/src/utils/scopedCapabilitySnapshot.js');
  const swimmer = engineFixtureDb.swimmers[0];
  const profile = buildClubCapabilityProfile(engineFixtureDb, swimmer, { season: SEASON, today: '2026-11-07' });
  for (const axis of profile.axes) {
    if (axis.scored) assert.ok(axis.evidenceCount > 0, `${axis.id}: scored only with evidence`);
    else assert.equal(axis.value, null);
  }
  assert.ok(engine);
});
