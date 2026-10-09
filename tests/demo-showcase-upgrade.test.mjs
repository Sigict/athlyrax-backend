import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upgradeDemoShowcaseTenant } from '../scripts/upgrade-demo-showcase-tenant.mjs';

test('demo showcase upgrade replaces legacy demo data once and backs it up', () => {
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
  assert.equal(db.__meta.demoSeed.version, 5);
  assert.equal(db.__meta.storageRevision, 8);
  assert.equal(db.squads.length, 3);
  assert.equal(db.coaches.length, 3);
  assert.equal(db.swimmers.length, 20);
  assert.equal(db.swimmers.some((row) => row.id === 'real-person-data'), false);
  assert.equal(db.squads.some((row) => row.id === 'legacy-squad'), false);
  assert.equal(db.squads.find((row) => row.name === 'Performance A').swimmerIds.length, 8);
  assert.equal(db.fixtures.length, 3);
  assert.equal(db.tests.length, 144);
  const amelia = db.swimmers.find((row) => row.name === 'Amelia Foster');
  assert.ok(amelia);
  assert.equal(db.tests.filter((row) => row.swimmerId === amelia.id).length, 18);
  const ameliaCompetitionResults = db.fixtures.flatMap((fixture) => (fixture.events || []).map((event) => event.resultsBySwimmer?.[amelia.id]).filter(Boolean));
  assert.equal(ameliaCompetitionResults.length, 6);
  assert.equal(ameliaCompetitionResults.filter((row) => row.pb === true).length, 3);
  assert.equal(db.trainingSessionSets.filter((row) => row.isTestSet === true).length, 2);
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
