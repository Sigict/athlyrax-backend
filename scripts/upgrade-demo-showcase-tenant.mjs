import fs from 'node:fs';
import path from 'node:path';
import { buildDemoTenantSeed } from './demo-showcase-dataset.mjs';

export const DEMO_SHOWCASE_VERSION = 4;
const TENANT_ID = 'demo-company';

function safeJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

export function upgradeDemoShowcaseTenant({ storageRoot, backupRoot, logger = console, fsModule = fs } = {}) {
  if (!storageRoot) throw new Error('upgradeDemoShowcaseTenant requires storageRoot');
  if (!backupRoot) throw new Error('upgradeDemoShowcaseTenant requires backupRoot');

  const dbPath = path.resolve(storageRoot, 'tenants', TENANT_ID, 'db.json');
  if (!fsModule.existsSync(dbPath)) {
    return { changed: false, reason: 'missing-demo-db', dbPath };
  }

  const current = safeJson(dbPath);
  const currentVersion = Number(current?.__meta?.demoSeed?.version || 0);
  if (currentVersion >= DEMO_SHOWCASE_VERSION) {
    return { changed: false, reason: 'already-current', version: currentVersion, dbPath };
  }

  const backupDir = path.resolve(backupRoot, 'demo-showcase-upgrades');
  fsModule.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `demo-company-before-showcase-v${DEMO_SHOWCASE_VERSION}-${stamp}.json`);
  fsModule.copyFileSync(dbPath, backupPath);

  const merged = buildDemoTenantSeed();
  const previousRevision = Number(current?.__meta?.storageRevision || 0);
  merged.__meta = {
    ...(merged.__meta || {}),
    tenantId: TENANT_ID,
    tenant: TENANT_ID,
    storageRevision: previousRevision + 1,
    demoSeed: {
      ...(merged.__meta?.demoSeed || {}),
      version: DEMO_SHOWCASE_VERSION,
      upgradedAt: new Date().toISOString(),
      source: 'production-start-one-time-upgrade',
    },
  };

  atomicWrite(dbPath, merged);

  const summary = {
    squads: Array.isArray(merged.squads) ? merged.squads.length : 0,
    coaches: Array.isArray(merged.coaches) ? merged.coaches.length : 0,
    swimmers: Array.isArray(merged.swimmers) ? merged.swimmers.length : 0,
    timetableSlots: Array.isArray(merged.timetableSlots) ? merged.timetableSlots.length : 0,
    schedule: Array.isArray(merged.schedule) ? merged.schedule.length : 0,
    trainingSessions: Array.isArray(merged.trainingSessions) ? merged.trainingSessions.length : 0,
    tests: Array.isArray(merged.tests) ? merged.tests.length : 0,
    fixtures: Array.isArray(merged.fixtures) ? merged.fixtures.length : 0,
  };

  logger.log?.(`[demo-showcase] Upgraded ${TENANT_ID} to showcase dataset v${DEMO_SHOWCASE_VERSION}: ${JSON.stringify(summary)}`);
  return { changed: true, reason: 'upgraded', version: DEMO_SHOWCASE_VERSION, dbPath, backupPath, summary };
}
