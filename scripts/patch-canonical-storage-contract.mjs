import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const storageSafetyImport = `import { resolveStorageConfiguration, runStorageSafetyCheck } from './scripts/storage-safety-lib.mjs';`;
const storageContractImport = `import { finalizeLegacyStorageMigration, migrateLegacyStorageIfNeeded, restoreBundledDemoTenantIfNeeded } from './scripts/storage-path-contract.mjs';`;
const importAnchor = `import Stripe from 'stripe';`;

const obsoleteStorageSafetyImport = `import { runStorageSafetyCheck } from './scripts/storage-safety-lib.mjs';`;
const obsoleteStorageContractImports = [
  `import { restoreBundledDemoTenantIfNeeded } from './scripts/storage-path-contract.mjs';`,
  `import { migrateLegacyStorageIfNeeded, restoreBundledDemoTenantIfNeeded } from './scripts/storage-path-contract.mjs';`,
];
if (source.includes(obsoleteStorageSafetyImport)) source = source.replace(obsoleteStorageSafetyImport, storageSafetyImport);
for (const obsolete of obsoleteStorageContractImports) {
  if (source.includes(obsolete)) source = source.replace(obsolete, storageContractImport);
}
for (const importLine of [storageSafetyImport, storageContractImport]) {
  if (!source.includes(importLine)) {
    if (!source.includes(importAnchor)) throw new Error('Could not find backend import anchor for canonical storage guard.');
    source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
  }
}

const replacements = [
  [`const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants', 'clubs');`, `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants');`],
  [`const SHARED_AUTH_USERS_PATH = path.join(STORAGE_ROOT, 'auth-users.json');`, `const SHARED_AUTH_USERS_PATH = path.join(STORAGE_ROOT, 'auth', 'auth-users.json');`],
];
for (const [legacy, canonical] of replacements) {
  if (source.includes(legacy)) source = source.replace(legacy, canonical);
  if (!source.includes(canonical)) throw new Error(`Canonical storage declaration missing after patch: ${canonical}`);
}

const runtimeGuardMarker = `// ATHLYRAX_CANONICAL_STORAGE_RUNTIME_GUARD`;
const appAnchor = `const app = express();`;
const runtimeGuard = `${runtimeGuardMarker}\nconst athlyraxRuntimeIsProduction = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';\nif (process.env.RENDER_SERVICE_ID && !athlyraxRuntimeIsProduction) {\n\tthrow new Error('Render runtime requires NODE_ENV=production. Refusing unsafe development/default mode.');\n}\nif (athlyraxRuntimeIsProduction) {\n\tconst runtimeStorageConfiguration = resolveStorageConfiguration(process.env, __dirname);\n\tif (runtimeStorageConfiguration.failures.length > 0) {\n\t\tconst error = new Error(runtimeStorageConfiguration.failures.join('\\n'));\n\t\terror.code = 'ATHLYRAX_STORAGE_CONFIGURATION_INVALID';\n\t\tthrow error;\n\t}\n\tconst runtimeLegacyMigration = migrateLegacyStorageIfNeeded({\n\t\tsourceRoot: __dirname,\n\t\tstorageRoot: runtimeStorageConfiguration.storageRoot,\n\t\tbackupRoot: runtimeStorageConfiguration.backupRoot,\n\t});\n\trestoreBundledDemoTenantIfNeeded({\n\t\tsourceRoot: __dirname,\n\t\tstorageRoot: runtimeStorageConfiguration.storageRoot,\n\t\tbackupRoot: runtimeStorageConfiguration.backupRoot,\n\t});\n\trunStorageSafetyCheck({ repoRoot: __dirname, requireFiles: true, createDirectories: true });\n\tfinalizeLegacyStorageMigration({\n\t\tstorageRoot: runtimeStorageConfiguration.storageRoot,\n\t\tmigrationResult: runtimeLegacyMigration,\n\t});\n\tprocess.env.ATHLYRAX_SAFE_START_ENFORCED = 'true';\n}\n\n${appAnchor}`;

if (!source.includes(runtimeGuardMarker)) {
  if (!source.includes(appAnchor)) throw new Error('Could not find Express app anchor for canonical storage guard.');
  source = source.replace(appAnchor, runtimeGuard);
} else {
  for (const required of ['athlyraxRuntimeIsProduction', 'RENDER_SERVICE_ID', 'runtimeStorageConfiguration = resolveStorageConfiguration', 'runtimeLegacyMigration = migrateLegacyStorageIfNeeded({', 'finalizeLegacyStorageMigration({']) {
    if (!source.includes(required)) throw new Error(`Existing canonical runtime guard is stale: missing ${required}`);
  }
}

const authFailClosedMarker = `// ATHLYRAX_PRODUCTION_AUTH_STORE_FAIL_CLOSED`;
if (!source.includes(authFailClosedMarker)) {
  const authAnchor = `\tconst cleanedFromBackup = sanitizeDemoUsers(fromBackup);\n\n\tif (`;
  const authReplacement = `\tconst cleanedFromBackup = sanitizeDemoUsers(fromBackup);\n\n${authFailClosedMarker}\n\tif (IS_PRODUCTION && cleanedFromFile.length < 1) {\n\t\tthrow new Error('Production authentication store is empty. Refusing backup/environment/default account fallback.');\n\t}\n\tif (IS_PRODUCTION && cleanedFromBackup.length < 1) {\n\t\tthrow new Error('Production authentication backup is empty. Refusing startup without a valid backup baseline.');\n\t}\n\n\tif (`;
  if (!source.includes(authAnchor)) throw new Error('Could not find authentication store fallback anchor.');
  source = source.replace(authAnchor, authReplacement);
}

const authAtomicMarker = `// ATHLYRAX_AUTH_BOOTSTRAP_ATOMIC_WRITES`;
if (!source.includes(authAtomicMarker)) {
  const functionStart = source.indexOf('function loadOrCreateAuthUsers() {');
  const functionEnd = source.indexOf('\nfunction toBase64Url(', functionStart);
  if (functionStart < 0 || functionEnd < 0) throw new Error('Could not locate authentication bootstrap function for atomic write guard.');
  let authFunction = source.slice(functionStart, functionEnd);
  authFunction = authFunction
    .replaceAll('writeJsonFile(AUTH_USERS_PATH,', 'writeAtomicJsonFile(AUTH_USERS_PATH,')
    .replaceAll('writeJsonFile(AUTH_USERS_BACKUP_PATH,', 'writeAtomicJsonFile(AUTH_USERS_BACKUP_PATH,');
  if (authFunction.includes('writeJsonFile(AUTH_USERS_')) throw new Error('Non-atomic authentication bootstrap write remains.');
  authFunction = authFunction.replace('function loadOrCreateAuthUsers() {', `function loadOrCreateAuthUsers() {\n${authAtomicMarker}`);
  source = source.slice(0, functionStart) + authFunction + source.slice(functionEnd);
}

const inviteFailClosedMarker = `// ATHLYRAX_AUTH_INVITES_FAIL_CLOSED`;
if (!source.includes(inviteFailClosedMarker)) {
  const legacyInviteLoader = `function loadOrCreateAuthInvites() {\n\tensureStorageLayout();\n\tconst fromFile = normalizeInviteRows(readJsonFile(AUTH_INVITES_PATH));\n\tif (fromFile.length > 0) return fromFile;\n\twriteJsonFile(AUTH_INVITES_PATH, []);\n\treturn [];\n}`;
  const safeInviteLoader = `function loadOrCreateAuthInvites() {\n${inviteFailClosedMarker}\n\tensureStorageLayout();\n\tif (fs.existsSync(AUTH_INVITES_PATH)) {\n\t\tconst raw = readJsonFile(AUTH_INVITES_PATH);\n\t\tif (!Array.isArray(raw)) {\n\t\t\tthrow new Error('Authentication invite store is unreadable or invalid. Refusing to replace it with an empty file.');\n\t\t}\n\t\treturn normalizeInviteRows(raw);\n\t}\n\twriteAtomicJsonFile(AUTH_INVITES_PATH, []);\n\treturn [];\n}`;
  if (!source.includes(legacyInviteLoader)) throw new Error('Could not find authentication invite loader anchor.');
  source = source.replace(legacyInviteLoader, safeInviteLoader);
}

const missingTenantResponse = `\t\tappendAuthAuditEvent({\n\t\t\taction: 'tenant_database_missing',\n\t\t\treq,\n\t\t\tstatus: 'blocked',\n\t\t\treason: 'missing_existing_tenant_database',\n\t\t\tdetails: { tenantKey: storagePaths.tenantKey },\n\t\t});\n\t\tres.status(503).json({\n\t\t\terror: 'Tenant data is temporarily unavailable. The server refused to create an empty replacement database.',\n\t\t\ttenantKey: storagePaths.tenantKey,\n\t\t});\n\t\treturn;`;

const unsafeGetBlock = `\tensureStorageLayout(storagePaths);\n\tif (!fs.existsSync(storagePaths.dbPath) && storagePaths.dbPath !== DB_PATH) {\n\t\twriteAtomicJsonFile(storagePaths.dbPath, {});\n\t}`;
const safeGetBlock = `\tensureStorageLayout(storagePaths);\n\tif (!fs.existsSync(storagePaths.dbPath) && storagePaths.dbPath !== DB_PATH) {\n${missingTenantResponse}\n\t}`;
if (source.includes(unsafeGetBlock)) source = source.replace(unsafeGetBlock, safeGetBlock);

const putMarker = `// ATHLYRAX_FAIL_CLOSED_MISSING_TENANT_WRITE`;
if (!source.includes(putMarker)) {
  const putAnchor = `app.put('/db', requireAuth, requireWriteRole, requireBillingWriteAccess, (req, res) => {`;
  const putStart = source.indexOf(putAnchor);
  if (putStart < 0) throw new Error('Could not find PUT /db route for missing-tenant guard.');
  const existingAnchor = `\tconst existingDb = readJsonFile(storagePaths.dbPath);`;
  const existingIndex = source.indexOf(existingAnchor, putStart);
  if (existingIndex < 0) throw new Error('Could not find PUT /db existing database read anchor.');
  const writeGuard = `${putMarker}\n\tif (!fs.existsSync(storagePaths.dbPath) && storagePaths.dbPath !== DB_PATH) {\n${missingTenantResponse}\n\t}\n\n`;
  source = source.slice(0, existingIndex) + writeGuard + source.slice(existingIndex);
}

const registrationMarker = `// ATHLYRAX_NEW_TENANT_DB_PROVISION`;
if (!source.includes(registrationMarker)) {
  const roleAnchor = `\tif (role === 'head-coach') {`;
  const registerStart = source.indexOf(`app.post('/auth/register', requireLoginRateLimit, (req, res) => {`);
  if (registerStart < 0) throw new Error('Could not find registration route for tenant provisioning guard.');
  const roleIndex = source.indexOf(roleAnchor, registerStart);
  if (roleIndex < 0) throw new Error('Could not find registration role anchor for tenant provisioning guard.');

  const provisionBlock = `${registrationMarker}\n\tconst registrationTenantStorage = resolveStoragePathsForTenantKey(tenantId);\n\tconst registrationTenantProvisioningToken = crypto.randomUUID();\n\tlet registrationTenantDbCreated = false;\n\tif (registrationTenantStorage.dbPath !== DB_PATH && !fs.existsSync(registrationTenantStorage.dbPath)) {\n\t\tif (usableInvite) {\n\t\t\tappendAuthAuditEvent({\n\t\t\t\taction: 'register_blocked',\n\t\t\t\treq,\n\t\t\t\tstatus: 'blocked',\n\t\t\t\ttarget: username,\n\t\t\t\treason: 'invited_tenant_database_missing',\n\t\t\t\tdetails: { tenantId },\n\t\t\t});\n\t\t\tres.status(503).json({ error: 'Team data is temporarily unavailable. Registration was not completed.' });\n\t\t\treturn;\n\t\t}\n\t\tensureStorageLayout(registrationTenantStorage);\n\t\tconst now = new Date().toISOString();\n\t\twriteAtomicJsonFile(registrationTenantStorage.dbPath, {\n\t\t\t__meta: { tenantId, createdAt: now, updatedAt: now, provisionedBy: 'auth-register', provisioningToken: registrationTenantProvisioningToken },\n\t\t\tswimmers: [], squads: [], trainingSessions: [], trainingSessionSets: [], tests: [], attendance: [], fixtures: [], trainingPlannerWeeks: [],\n\t\t});\n\t\tregistrationTenantDbCreated = true;\n\t}\n\n`;
  source = source.slice(0, roleIndex) + provisionBlock + source.slice(roleIndex);

  const catchAnchor = `\t} catch (error) {\n\t\tauthUsers.pop();\n\t\tif (usableInvite) {\n\t\t\tusableInvite.usedCount = Math.max(0, Number(usableInvite.usedCount || 0) - 1);\n\t\t}\n\t\tres.status(500).json({\n\t\t\terror: 'Could not create account.',`;
  const safeCatch = `\t} catch (error) {\n\t\tauthUsers.pop();\n\t\tif (usableInvite) {\n\t\t\tusableInvite.usedCount = Math.max(0, Number(usableInvite.usedCount || 0) - 1);\n\t\t}\n\t\ttry { persistAuthUsers(); } catch {}\n\t\tif (usableInvite) { try { persistAuthInvites(); } catch {} }\n\t\tif (registrationTenantDbCreated && registrationTenantStorage.dbPath !== DB_PATH && fs.existsSync(registrationTenantStorage.dbPath)) {\n\t\t\ttry {\n\t\t\t\tconst provisioned = readJsonFile(registrationTenantStorage.dbPath);\n\t\t\t\tif (String(provisioned?.__meta?.provisioningToken || '') === registrationTenantProvisioningToken) {\n\t\t\t\t\tfs.unlinkSync(registrationTenantStorage.dbPath);\n\t\t\t\t}\n\t\t\t} catch {}\n\t\t}\n\t\tres.status(500).json({\n\t\t\terror: 'Could not create account.',`;
  if (!source.includes(catchAnchor)) throw new Error('Could not find registration rollback anchor.');
  source = source.replace(catchAnchor, safeCatch);
}

const forbidden = [
  `path.join(STORAGE_ROOT, 'tenants', 'clubs')`,
  `path.join(STORAGE_ROOT, 'auth-users.json')`,
  `writeAtomicJsonFile(storagePaths.dbPath, {});`,
  obsoleteStorageSafetyImport,
  `writeJsonFile(AUTH_USERS_PATH,`,
  `writeJsonFile(AUTH_USERS_BACKUP_PATH,`,
];
for (const token of forbidden) {
  if (source.includes(token)) throw new Error(`Forbidden legacy storage behavior remains in index.js: ${token}`);
}

for (const token of [
  storageSafetyImport,
  storageContractImport,
  runtimeGuardMarker,
  authFailClosedMarker,
  authAtomicMarker,
  inviteFailClosedMarker,
  putMarker,
  registrationMarker,
  `Render runtime requires NODE_ENV=production`,
  `Production authentication store is empty. Refusing backup/environment/default account fallback.`,
  `Authentication invite store is unreadable or invalid. Refusing to replace it with an empty file.`,
  `resolveStorageConfiguration(process.env, __dirname)`,
  `runtimeLegacyMigration = migrateLegacyStorageIfNeeded({`,
  `restoreBundledDemoTenantIfNeeded({`,
  `runStorageSafetyCheck({`,
  `finalizeLegacyStorageMigration({`,
  `path.join(STORAGE_ROOT, 'tenants')`,
  `path.join(STORAGE_ROOT, 'auth', 'auth-users.json')`,
  `action: 'tenant_database_missing'`,
  `The server refused to create an empty replacement database.`,
  `registrationTenantStorage = resolveStoragePathsForTenantKey(tenantId)`,
  `invited_tenant_database_missing`,
  `provisioningToken: registrationTenantProvisioningToken`,
  `try { persistAuthUsers(); } catch {}`,
]) {
  if (!source.includes(token)) throw new Error(`Canonical storage verification failed: ${token}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('CANONICAL_STORAGE_CONTRACT_PATCH_OK');
