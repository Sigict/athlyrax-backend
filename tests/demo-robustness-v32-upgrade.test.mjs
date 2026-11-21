import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upgradeDemoRobustnessV32Storage } from '../scripts/upgrade-demo-robustness-v32.mjs';
import { DEMO_PROGRAMME_ENERGY_REPAIR_MANIFEST } from '../capability-engine/src/data/demoProgrammeEnergyRepairManifest.js';

// A small synthetic demo club: one manifest set with its observed conflicting codes and synthetic counts, one set with a
// coach-entered count, and the demo metadata the live club carries.
function demoClub() {
  const [id, energy, energySystem] = DEMO_PROGRAMME_ENERGY_REPAIR_MANIFEST.find((r) => r[0].endsWith('_speed'));
  const reps = (src) => Array.from({ length: 6 }, (_, i) => ({ time: String(15 + i * 0.1), strokeCount: 20 + (i > 3 ? 1 : 0), strokeCountUnit: 'strokes', measurementSource: src, strokeCycleSource: src === 'synthetic-demo' ? 'synthetic-demo-model' : src }));
  return {
    __meta: { tenantId: 'demo-company', storageRevision: 41, demoSeed: { prefix: 'demo_showcase_', energyMixVersion: 1, version: 8 } },
    swimmers: [{ id: 'sw1', gender: 'Female' }, { id: 'sw2', gender: 'Male' }],
    tests: [{ id: 'max1', swimmerId: 'sw1', testName: 'Max 50', distance: 50, stroke: 'Free', repResults: [{ overallTime: '30.0' }] }],
    trainingSessionSets: [
      { id, phase: 'SPECIFIC', setName: '16x25 Speed Expression', energy, energySystem, reps: 6, distance: 25, stroke: 'Free', resultsBySwimmer: { sw1: { reps: reps('synthetic-demo') } } },
      { id: 'demo_showcase_set_coach', phase: 'SPECIFIC', setName: 'Coach set', energy: 'EN2', energySystem: 'EN2', reps: 6, distance: 25, stroke: 'Free', resultsBySwimmer: { sw2: { reps: reps('coach-entered') } } },
    ],
    fixtures: [],
  };
}
function storage(db) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-demo-robustness-'));
  const storageRoot = path.join(root, 'storage'); const backupRoot = path.join(root, 'backup');
  const dbPath = path.join(storageRoot, 'tenants', 'demo-company', 'db.json');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true }); fs.mkdirSync(backupRoot, { recursive: true });
  if (db !== undefined) fs.writeFileSync(dbPath, typeof db === 'string' ? db : JSON.stringify(db));
  return { storageRoot, backupRoot, dbPath };
}
const quiet = { log() {} };

test('applied once at start: verified backup, one atomic write, revision +1, both markers, coach data untouched', () => {
  const s = storage(demoClub()); const before = fs.readFileSync(s.dbPath);
  const r = upgradeDemoRobustnessV32Storage({ ...s, logger: quiet });
  assert.equal(r.changed, true); assert.equal(r.energyRepaired, 1);
  assert.ok(fs.readFileSync(r.backupPath).equals(before), 'backup is the exact original');
  const db = JSON.parse(fs.readFileSync(s.dbPath, 'utf8'));
  assert.equal(db.__meta.storageRevision, 42);
  assert.equal(db.__meta.demoSeed.programmeEnergyRepairVersion, 1); assert.equal(db.__meta.demoSeed.strokeModelV2Version, 1);
  assert.equal(db.trainingSessionSets[0].energy, 'SP');
  assert.deepEqual(db.trainingSessionSets[1], demoClub().trainingSessionSets[1], 'coach-entered effort untouched');
  assert.deepEqual(fs.readdirSync(path.dirname(s.dbPath)), ['db.json'], 'no temporary file left');
  // Second start: nothing written, no new backup.
  const again = upgradeDemoRobustnessV32Storage({ ...s, logger: quiet });
  assert.equal(again.changed, false);
  assert.equal(fs.readdirSync(path.join(s.backupRoot, 'demo-robustness-v32')).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(s.dbPath, 'utf8')).__meta.storageRevision, 42);
});

test('nothing is written when the club is missing, unreadable, not the demo club, or the write fails', () => {
  assert.equal(upgradeDemoRobustnessV32Storage({ ...storage(undefined), logger: quiet }).reason, 'missing-demo-db');
  const broken = storage('{ not json'); assert.equal(upgradeDemoRobustnessV32Storage({ ...broken, logger: quiet }).reason, 'unreadable-demo-db');
  assert.equal(fs.readFileSync(broken.dbPath, 'utf8'), '{ not json');
  const real = storage({ ...demoClub(), __meta: { tenantId: 'demo-company', storageRevision: 3 } });
  const realBefore = fs.readFileSync(real.dbPath);
  assert.equal(upgradeDemoRobustnessV32Storage({ ...real, logger: quiet }).changed, false);
  assert.ok(fs.readFileSync(real.dbPath).equals(realBefore));
  // Failure during the atomic replace: the original stays byte-identical and no temporary file remains.
  const s = storage(demoClub()); const before = fs.readFileSync(s.dbPath);
  const failing = { ...fs, renameSync: () => { throw new Error('disk full'); } };
  assert.throws(() => upgradeDemoRobustnessV32Storage({ ...s, logger: quiet, fsModule: failing }), /disk full/);
  assert.ok(fs.readFileSync(s.dbPath).equals(before), 'original untouched');
  assert.deepEqual(fs.readdirSync(path.dirname(s.dbPath)), ['db.json'], 'temporary file removed');
  // A later start (after the cause is fixed) completes the repair normally.
  assert.equal(upgradeDemoRobustnessV32Storage({ ...s, logger: quiet }).changed, true);
});

test('production start runs the repair after the showcase upgrade and records the state the server reports', () => {
  const src = fs.readFileSync(new URL('../scripts/production-start.mjs', import.meta.url), 'utf8');
  const showcase = src.indexOf('upgradeDemoShowcaseTenant({'); const robustness = src.indexOf('runDemoRobustnessV32AtStart({');
  assert.ok(showcase > 0 && robustness > showcase);
  const preload = fs.readFileSync(new URL('../scripts/db-delete-persistence-preload.mjs', import.meta.url), 'utf8');
  assert.equal((preload.match(/X-AthlyraX-Demo-Robustness-V32/g) || []).length, 2, 'reported on /db reads and writes');
});

test('start status: complete after the repair, failed (club unchanged) when it throws, not-present without a demo club; header reports it', async () => {
  const { runDemoRobustnessV32AtStart, demoRobustnessV32HeaderValue, DEMO_ROBUSTNESS_V32_STATUS_KEY } = await import('../scripts/upgrade-demo-robustness-v32.mjs');
  const { installDbDeletePersistenceGuard } = await import('../scripts/db-delete-persistence-preload.mjs');
  const ok = storage(demoClub());
  assert.equal(runDemoRobustnessV32AtStart({ ...ok, logger: { log() {}, error() {} } }).state, 'complete');
  assert.equal(demoRobustnessV32HeaderValue(), 'complete');
  assert.equal(runDemoRobustnessV32AtStart({ ...ok, logger: { log() {}, error() {} } }).state, 'complete', 'second start: still complete, nothing written');
  // A failing repair: never throws, records "failed", leaves the club unchanged.
  const bad = storage(demoClub()); const before = fs.readFileSync(bad.dbPath);
  fs.mkdirSync(path.join(bad.backupRoot, 'demo-robustness-v32')); fs.chmodSync(path.join(bad.backupRoot, 'demo-robustness-v32'), 0o500);
  const failed = runDemoRobustnessV32AtStart({ ...bad, logger: { log() {}, error() {} } });
  fs.chmodSync(path.join(bad.backupRoot, 'demo-robustness-v32'), 0o700);
  if (process.getuid?.() !== 0) { assert.equal(failed.state, 'failed'); assert.ok(fs.readFileSync(bad.dbPath).equals(before)); }
  assert.equal(runDemoRobustnessV32AtStart({ ...storage(undefined), logger: { log() {}, error() {} } }).state, 'not-present');
  // Header on /db responses through the existing persistence guard.
  globalThis[DEMO_ROBUSTNESS_V32_STATUS_KEY] = { state: 'failed' };
  const routes = {}; const app = { get(p, ...h) { routes[`GET ${p}`] = h; }, put(p, ...h) { routes[`PUT ${p}`] = h; } };
  installDbDeletePersistenceGuard({ application: app });
  app.get('/db', () => {});
  const headers = {}; routes['GET /db'][0]({}, { setHeader: (k, v) => { headers[k] = v; } }, () => {});
  assert.equal(headers['X-AthlyraX-Demo-Robustness-V32'], 'failed');
});

test('a forced failure inside the atomic write is recorded as failed', async () => {
  const { runDemoRobustnessV32AtStart } = await import('../scripts/upgrade-demo-robustness-v32.mjs');
  const s = storage(demoClub()); const before = fs.readFileSync(s.dbPath);
  const orig = fs.renameSync; fs.renameSync = () => { throw new Error('disk full'); };
  let status; try { status = runDemoRobustnessV32AtStart({ ...s, logger: { log() {}, error() {} } }); } finally { fs.renameSync = orig; }
  assert.equal(status.state, 'failed'); assert.match(status.error, /disk full/);
  assert.ok(fs.readFileSync(s.dbPath).equals(before), 'club unchanged');
});

test('Athlete App: the synthetic demo club profile is labelled a synthetic demonstration, a real club stays validated', async () => {
  const { buildClubCapabilityProfile, SYNTHETIC_DEMO_PROFILE_LABEL } = await import('../athlete-club-capability.mjs');
  const season = { key: '2026-2027', label: '2026/27', start: '2026-09-01', end: '2027-08-31' };
  const demo = demoClub();
  const swimmer = demo.swimmers[0];
  const demoProfile = buildClubCapabilityProfile(demo, swimmer, { season, today: '2026-11-21', tenantId: 'demo-company' });
  assert.equal(demoProfile.evidenceType, 'synthetic-demonstration-update-pending', 'before the one-time update: said explicitly');
  const s2 = storage(demo); upgradeDemoRobustnessV32Storage({ ...s2, logger: quiet });
  const repaired = JSON.parse(fs.readFileSync(s2.dbPath, 'utf8'));
  const repairedProfile = buildClubCapabilityProfile(repaired, swimmer, { season, today: '2026-11-21', tenantId: 'demo-company' });
  assert.equal(repairedProfile.evidenceType, 'synthetic-demonstration');
  assert.equal(repairedProfile.sourceLabel, SYNTHETIC_DEMO_PROFILE_LABEL);
  assert.deepEqual(repairedProfile.axes.map((a) => a.value), buildClubCapabilityProfile(repaired, swimmer, { season, today: '2026-11-21', tenantId: 'demo-company' }).axes.map((a) => a.value));
  const real = { ...demo, __meta: { tenantId: 'real-club' } };
  const realProfile = buildClubCapabilityProfile(real, swimmer, { season, today: '2026-11-21', tenantId: 'real-club' });
  assert.equal(realProfile.evidenceType, 'validated');
});
