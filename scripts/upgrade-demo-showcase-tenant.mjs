import fs from 'node:fs';
import path from 'node:path';
import { buildDemoTenantSeed } from './demo-showcase-dataset.mjs';

export const DEMO_SHOWCASE_VERSION = 8;
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

  // Repair missing demo evidence only: never replace training, attendance or saved results.
  const seed = buildDemoTenantSeed();
  const merged = { ...current };
  const existingTests = Array.isArray(current.tests) ? current.tests : [];
  const knownTestIds = new Set(existingTests.map((row) => String(row?.id || '')));
  merged.tests = [...existingTests, ...seed.tests.filter((row) => !knownTestIds.has(String(row.id)))];

  const existingFixtures = Array.isArray(current.fixtures) ? current.fixtures : [];
  const fixtureById = new Map(existingFixtures.map((row) => [String(row?.id || ''), row]));
  const repairedFixtures = seed.fixtures.map((fixture) => {
    const previous = fixtureById.get(String(fixture.id));
    if (!previous) return fixture;
    const existingEvents = Array.isArray(previous.events) ? previous.events : [];
    const byEventId = new Map(existingEvents.map((event) => [String(event?.id || ''), event]));
    const supplemented = fixture.events.map((event) => {
      const savedEvent = byEventId.get(String(event.id));
      if (!savedEvent) return event;
      return {
        ...savedEvent,
        resultsBySwimmer: { ...event.resultsBySwimmer, ...(savedEvent.resultsBySwimmer || {}) },
      };
    });
    return {
      ...previous,
      events: [
        ...existingEvents.map((event) => supplemented.find((candidate) => String(candidate.id) === String(event.id)) || event),
        ...supplemented.filter((event) => !byEventId.has(String(event.id))),
      ],
    };
  });
  const seenFixtureIds = new Set(existingFixtures.map((fixture) => String(fixture?.id || '')));
  const repairedFixtureById = new Map(repairedFixtures.map((fixture) => [String(fixture.id), fixture]));
  merged.fixtures = [
    ...existingFixtures.map((fixture) => repairedFixtureById.get(String(fixture.id)) || fixture),
    ...repairedFixtures.filter((fixture) => !seenFixtureIds.has(String(fixture.id))),
  ];
  const previousRevision = Number(current?.__meta?.storageRevision || 0);
  merged.__meta = {
    ...(current.__meta || {}),
    tenantId: TENANT_ID,
    tenant: TENANT_ID,
    storageRevision: previousRevision + 1,
    demoSeed: {
      ...(current.__meta?.demoSeed || {}),
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
