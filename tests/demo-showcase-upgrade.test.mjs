import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upgradeDemoShowcaseTenant } from '../scripts/upgrade-demo-showcase-tenant.mjs';
import { buildDemoTenantSeed } from '../scripts/demo-showcase-dataset.mjs';

test('demo showcase upgrade repairs evidence without replacing existing data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-demo-showcase-'));
  const storageRoot = path.join(root, 'storage');
  const backupRoot = path.join(root, 'backup');
  const dbPath = path.join(storageRoot, 'tenants', 'demo-company', 'db.json');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });

  fs.writeFileSync(dbPath, JSON.stringify({
    __meta: { tenantId: 'demo-company', storageRevision: 7 },
    swimmers: [{ id: 'real-person-data', name: 'Must Not Survive' }],
    squads: [{ id: 'legacy-squad', swimmerIds: ['real-person-data'] }],
  }, null, 2));

  const first = upgradeDemoShowcaseTenant({ storageRoot, backupRoot, logger: { log() {} } });
  assert.equal(first.changed, true);
  assert.ok(first.backupPath);
  assert.equal(fs.existsSync(first.backupPath), true);

  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.equal(db.__meta.tenantId, 'demo-company');
  assert.equal(db.__meta.demoSeed.version, 8);
  assert.equal(db.__meta.storageRevision, 8);
  assert.equal(db.squads.length, 1);
  assert.equal(db.coaches?.length || 0, 0);
  assert.equal(db.swimmers.length, 1);
  assert.equal(db.swimmers.some((row) => row.id === 'real-person-data'), true);
  assert.equal(db.squads.some((row) => row.id === 'legacy-squad'), true);
  assert.deepEqual(db.squads[0].swimmerIds, ['real-person-data']);
  assert.equal(db.fixtures.length, 6);
  assert.equal(db.tests.length, 144);
  const amelia = buildDemoTenantSeed().swimmers.find((row) => row.name === 'Amelia Foster');
  assert.ok(amelia);
  assert.equal(db.tests.filter((row) => row.swimmerId === amelia.id).length, 18);
  const ameliaCompetitionResults = db.fixtures.flatMap((fixture) => (fixture.events || []).map((event) => event.resultsBySwimmer?.[amelia.id]).filter(Boolean));
  assert.equal(ameliaCompetitionResults.length, 12);
  assert.equal(ameliaCompetitionResults.filter((row) => row.pb === true).length, 8);
  // A slower preparation-meet swim must not be awarded a PB just because it beats the model baseline.\n  const prep = db.fixtures.find((fixture) => fixture.id.endsWith('fixture_prep'));\n  assert.equal(prep.events.every((event) => event.resultsBySwimmer[amelia.id].pb === false), true);\n  const ameliaHundreds = db.fixtures
    .flatMap((fixture) => fixture.events
      .filter((event) => event.distance === 100 && event.stroke === 'Free')
      .map((event) => event.resultsBySwimmer?.[amelia.id])
      .filter(Boolean));
  assert.deepEqual(ameliaHundreds.map((row) => row.resultValue), ['1:04.35','1:04.23','1:03.92','1:04.30','1:03.43','1:02.95']);
  assert.ok(ameliaHundreds.every((row) => row.resultValue === row.resultTime && row.resultTime === row.time && row.time === row.result));
  assert.equal(db.squads.find((row) => row.name === 'Performance B'), undefined);
  assert.equal(db.trainingSessionSets?.length || 0, 0);
  assert.equal(db.tests.filter((row) => row.scheduleId && row.sessionId).length, 144);
  const maxRows = db.tests.filter((row) => row.templateId === 'builtin-test-max');
  assert.equal(maxRows.length, 80);
  assert.deepEqual([...new Set(maxRows.map((row) => row.testName))].sort(), ['M100 · 1x100 Max Effort','M200 · 1x200 Max Effort','M25 · 1x25 Max Effort','M400 · 1x400 Max Effort','M50 · 1x50 Max Effort']);
  assert.equal(db.tests.filter((row) => row.templateId === 'builtin-test-repeatability').length, 48);
  assert.equal(db.tests.filter((row) => row.templateId === 'builtin-test-aerobic-durability').length, 16);

  const second = upgradeDemoShowcaseTenant({ storageRoot, backupRoot, logger: { log() {} } });
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'already-current');

  fs.rmSync(root, { recursive: true, force: true });
});
