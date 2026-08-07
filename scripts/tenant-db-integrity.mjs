import fs from 'node:fs';
import path from 'node:path';

const RECOGNIZED_COLLECTIONS = Object.freeze([
  'coaches', 'squads', 'swimmers', 'venues', 'sessionTypes', 'timetables', 'timetableSlots', 'schedule',
  'trainingSessions', 'trainingSessionSets', 'templateSets', 'templateTests', 'trainingSetBlocks',
  'seasonPlans', 'mesoCycles', 'microCycles', 'attendance', 'tests', 'competitions', 'fixtures', 'groups',
  'seasons', 'trainingPlannerWeeks', 'conflictResolutions', 'changeLog', 'auditLog', 'notifications', 'documents',
]);

function clean(value) { return String(value ?? '').trim(); }
function canonicalTenant(value) { const raw = clean(value); return Boolean(raw) && /^[a-z0-9_-]+$/.test(raw) && raw === raw.toLowerCase(); }
function slug(value, fallback) { const result = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); return result || fallback; }
function usersFrom(value) { return Array.isArray(value) ? value : (value && Array.isArray(value.users) ? value.users : null); }
function readJson(filePath, fsModule = fs) {
  try { return JSON.parse(fsModule.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}
function tenantForUser(user, env) {
  const username = clean(user?.username).toLowerCase();
  const role = clean(user?.role).toLowerCase();
  const createdVia = clean(user?.createdVia).toLowerCase();
  const explicit = clean(user?.tenantId);
  const primaryOwner = clean(env.AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME || 'softwareowner').toLowerCase();
  if (username === 'demo.coach') return 'demo-company';
  if (role === 'software-owner' && username === primaryOwner) return '';
  if (role === 'swimmer' && explicit === 'snapshot-public' && createdVia === 'snapshot-self-signup') return '';
  if (canonicalTenant(explicit)) return explicit;
  const club = clean(user?.swimClub);
  const team = clean(user?.teamName);
  if (club && team) return `${slug(club, 'club')}__${slug(team, 'team')}`;
  return username ? `user-${slug(username, 'unknown-user')}` : '';
}
function hasRecognizedShape(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && RECOGNIZED_COLLECTIONS.some((key) => Array.isArray(value[key]));
}

export function validateTenantDatabaseSemanticIntegrity(configuration, env = process.env, fsModule = fs) {
  if (!configuration || typeof configuration !== 'object') throw new Error('Storage configuration is required.');
  const authValue = readJson(configuration.authUsersPath, fsModule);
  const users = usersFrom(authValue);
  if (!users) return ['Authentication store cannot be read while validating tenant database shapes.'];
  const tenantIds = new Set(users.map((user) => tenantForUser(user, env)).filter(Boolean));
  const failures = [];
  for (const tenantId of tenantIds) {
    if (!canonicalTenant(tenantId)) { failures.push(`Auth-bound tenant ID is noncanonical: ${tenantId}.`); continue; }
    const dbPath = path.join(configuration.tenantRootPath, tenantId, 'db.json');
    if (!fsModule.existsSync(dbPath)) continue; // missing-file validation is handled by the main storage gate
    const value = readJson(dbPath, fsModule);
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue; // JSON/object validation is handled by the main storage gate
    if (!hasRecognizedShape(value)) failures.push(`Tenant database ${tenantId} has no recognized AthlyraX data collections: ${dbPath}`);
    const declared = clean(value?.__meta?.tenantId);
    if (declared && declared !== tenantId) failures.push(`Tenant database ${tenantId} declares a different tenant identity: ${declared}.`);
  }
  return failures;
}

export const tenantDbIntegrityInternals = Object.freeze({ RECOGNIZED_COLLECTIONS, hasRecognizedShape });
