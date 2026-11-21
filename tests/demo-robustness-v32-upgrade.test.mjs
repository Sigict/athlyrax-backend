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

test('production start calls the repair after the showcase upgrade and never stops the server on failure', () => {
  const src = fs.readFileSync(new URL('../scripts/production-start.mjs', import.meta.url), 'utf8');
  const showcase = src.indexOf('upgradeDemoShowcaseTenant({'); const robustness = src.indexOf('upgradeDemoRobustnessV32Storage({');
  assert.ok(showcase > 0 && robustness > showcase);
  assert.match(src.slice(robustness - 200, robustness + 600), /try \{[\s\S]*catch \(error\)/);
});
