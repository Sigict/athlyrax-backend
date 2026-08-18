import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const allowedBundledDemoSeed = 'storage/tenants/demo-company/db.json';
const result = spawnSync('git', ['ls-files', '--', 'storage', 'storage/**'], { encoding: 'utf8' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Could not inspect tracked backend storage.');

const tracked = String(result.stdout || '')
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean);
const forbidden = tracked.filter((file) => file !== allowedBundledDemoSeed);

if (forbidden.length > 0) {
  console.error('ATHLYRAX_BACKEND_TRACKED_RUNTIME_STORAGE_FAIL');
  console.error('Runtime/auth/billing/customer storage must not be source-controlled:');
  for (const file of forbidden) console.error(`- ${file}`);
  process.exit(1);
}

if (!tracked.includes(allowedBundledDemoSeed)) {
  console.error('ATHLYRAX_BACKEND_DEMO_SEED_MISSING');
  process.exit(1);
}

let seed;
try {
  seed = JSON.parse(fs.readFileSync(allowedBundledDemoSeed, 'utf8'));
} catch {
  console.error('ATHLYRAX_BACKEND_DEMO_SEED_INVALID');
  process.exit(1);
}

// Existing verified demo seeds may predate explicit tenant metadata. Match the
// production recovery contract: absence is allowed, but a conflicting declared
// tenant is rejected.
const declaredTenantId = String(seed?.__meta?.tenantId || '').trim();
if (declaredTenantId && declaredTenantId !== 'demo-company') {
  console.error('ATHLYRAX_BACKEND_DEMO_SEED_WRONG_TENANT');
  process.exit(1);
}

const evidenceKeys = ['swimmers', 'squads', 'trainingSessions', 'trainingSessionSets', 'tests', 'attendance', 'competitions', 'fixtures', 'groups'];
if (!evidenceKeys.some((key) => Array.isArray(seed?.[key]) && seed[key].length > 0)) {
  console.error('ATHLYRAX_BACKEND_DEMO_SEED_EMPTY');
  process.exit(1);
}

console.log('ATHLYRAX_BACKEND_RUNTIME_STORAGE_GATE_OK');
