// Non-destructive, opt-in demo.coach enrichment. No startup or automatic execution.
import fs from 'node:fs';
import path from 'node:path';
import { buildDemoTenantSeed } from './demo-showcase-dataset.mjs';

const PREFIX = 'demo_showcase_';
const present = v => v !== null && v !== undefined && String(v).trim() !== '';
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const array = v => Array.isArray(v) ? v : [];
const parseSeconds = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const valueText = String(value ?? '').trim();
  if (!valueText) return null;
  const parts = valueText.split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
};
const fill = (target, source, key, audit, kind) => {
  if (!present(target[key]) && present(source?.[key])) {
    target[key] = source[key];
    audit[kind] = (audit[kind] || 0) + 1;
  }
};
function matchingTime(a, b) {
  const x = parseSeconds(a), y = parseSeconds(b);
  return x !== null && y !== null && Math.abs(x - y) < 0.011;
}
function recordedRepTime(rep) { return parseSeconds(rep?.overallTime || rep?.time); }
function enrichRep(existing, sample, audit) {
  const next = { ...existing };
  if (matchingTime(existing?.overallTime, sample?.overallTime)) {
    fill(next, sample, 'overallStrokeCount', audit, 'testStrokeCounts');
  }
  return next;
}

export function enrichDemoCoachRecords(currentDb, seed = buildDemoTenantSeed()) {
  if (String(currentDb?.__meta?.tenantId || currentDb?.__meta?.tenant) !== 'demo-company') {
    throw new Error('Refusing to modify any tenant other than demo-company');
  }
  const result = { ...currentDb };
  const audit = {};
  const seedTests = new Map(array(seed.tests).map(x => [String(x.id), x]));
  result.tests = array(currentDb.tests).map(test => {
    if (!String(test?.id || '').startsWith(PREFIX)) return test;
    const sample = seedTests.get(String(test.id));
    if (!sample || String(test?.swimmerId) !== String(sample.swimmerId)
      || num(test?.distance) !== num(sample.distance)) return test;
    const next = { ...test };
    const reps = array(test.repResults);
    if (reps.length === array(sample.repResults).length) {
      next.repResults = reps.map((rep, index) => enrichRep(rep, sample.repResults[index], audit));
    }
    return next;
  });

  const seedFixtures = new Map(array(seed.fixtures).map(x => [String(x.id), x]));
  result.fixtures = array(currentDb.fixtures).map(fixture => {
    if (!String(fixture?.id || '').startsWith(PREFIX)) return fixture;
    const sampleFixture = seedFixtures.get(String(fixture.id));
    if (!sampleFixture) return fixture;
    const samples = new Map(array(sampleFixture.events).map(x => [String(x.id), x]));
    return { ...fixture, events: array(fixture.events).map(event => {
      const sample = samples.get(String(event.id));
      if (!sample || String(event?.stroke) !== String(sample.stroke)
        || num(event?.distance) !== num(sample.distance)) return event;
      const results = { ...(event.resultsBySwimmer || {}) };
      for (const [swimmerId, performance] of Object.entries(results)) {
        const template = sample.resultsBySwimmer?.[swimmerId];
        if (!template || !matchingTime(performance?.resultTime || performance?.time, template?.resultTime)) continue;
        const next = { ...performance };
        for (const key of ['strokeCount', 'strokeRate', 'breakoutTime', 'breakoutDistance']) {
          fill(next, template, key, audit, 'raceMeasurements');
        }
        results[swimmerId] = next;
      }
      return { ...event, resultsBySwimmer: results };
    }) };
  });

  // Only change Choice demo sets without recorded results. Named freestyle,
  // race and measured sets must retain their established stroke identity.
  // Long aerobic or recovery work should never be relabelled as butterfly.
  const strokeChoices = distance => distance >= 100
    ? ['Back', 'Breast', 'IM']
    : ['Back', 'Breast', 'Fly', 'IM'];
  const seedSets = new Map(array(seed.trainingSessionSets).map(x => [String(x.id), x]));
  result.trainingSessionSets = array(currentDb.trainingSessionSets).map(set => {
    if (!String(set?.id || '').startsWith(PREFIX)) return set;
    const sample = seedSets.get(String(set.id));
    if (!sample || String(set.stroke).toLowerCase() !== 'choice'
      || /kick/i.test(String(set.setName))
      || Object.keys(set.resultsBySwimmer || {}).length) return set;
    const next = { ...set };
    const choices = strokeChoices(Number(set.distance) || 0);
    const variant = choices[Array.from(String(set.id)).reduce((a,c) => a + c.charCodeAt(0),0) % choices.length];
    next.stroke = variant;
    next.demoSyntheticStroke = true;
    audit.trainingStrokeVariety = (audit.trainingStrokeVariety || 0) + 1;
    return next;
  });

  // Inspect measured swimmer reps and retain only defensible rest estimates.
  // Never reinterpret setTimeSeconds as a send-off without field evidence.
  audit.missingSendOffsUnchanged = result.trainingSessionSets.filter(set =>
    String(set?.id || '').startsWith(PREFIX) && !present(set.sendOff)).length;
  return { db: result, audit };
}

export function applyDemoEnrichment({ dbPath, backupDir, apply = false } = {}) {
  if (!dbPath || !backupDir) throw new Error('dbPath and backupDir required');
  const resolved = path.resolve(dbPath);
  if (!resolved.includes('/tenants/demo-company/') && !resolved.includes('\\tenants\\demo-company\\')) {
    throw new Error('Refusing path outside demo-company tenant');
  }
  const current = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const { db, audit } = enrichDemoCoachRecords(current);
  if (apply) {
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, 'demo-before-enrichment-' + Date.now() + '.json');
    fs.copyFileSync(resolved, backup);
    const tmp = resolved + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n');
    fs.renameSync(tmp, resolved);
    return { applied: true, backup, audit };
  }
  return { applied: false, audit };
}

// Explicit opt-in command; dry-run by default.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const dbPath = process.argv[2], backupDir = process.argv[3];
  console.log(JSON.stringify(applyDemoEnrichment({ dbPath, backupDir, apply: process.argv.includes('--apply') }), null, 2));
}
