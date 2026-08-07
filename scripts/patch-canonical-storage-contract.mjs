import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

function replaceRequired(needle, replacement, label) {
  if (source.includes(needle)) source = source.replace(needle, replacement);
  if (!source.includes(replacement)) throw new Error(`${label} was not installed.`);
}

replaceRequired(
  `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants', 'clubs');`,
  `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants');`,
  'Canonical tenant root',
);
replaceRequired(
  `const SHARED_AUTH_USERS_PATH = path.join(STORAGE_ROOT, 'auth-users.json');`,
  `const SHARED_AUTH_USERS_PATH = path.join(STORAGE_ROOT, 'auth', 'auth-users.json');`,
  'Canonical authentication path',
);

for (const obsoleteImport of [
  `import { resolveStorageConfiguration, runStorageSafetyCheck } from './scripts/storage-safety-lib.mjs';\n`,
  `import { runStorageSafetyCheck } from './scripts/storage-safety-lib.mjs';\n`,
  `import { finalizeLegacyStorageMigration, migrateLegacyStorageIfNeeded, restoreBundledDemoTenantIfNeeded } from './scripts/storage-path-contract.mjs';\n`,
  `import { migrateLegacyStorageIfNeeded, restoreBundledDemoTenantIfNeeded } from './scripts/storage-path-contract.mjs';\n`,
  `import { restoreBundledDemoTenantIfNeeded } from './scripts/storage-path-contract.mjs';\n`,
]) source = source.replaceAll(obsoleteImport, '');

const runtimeGuardMarker = `// ATHLYRAX_CANONICAL_STORAGE_RUNTIME_GUARD`;
const appAnchor = `const app = express();`;
const finalRuntimeGuard = `${runtimeGuardMarker}\nconst athlyraxRuntimeIsProduction = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';\nconst athlyraxSafeStartProof = globalThis[Symbol.for('athlyrax.safeStartEnforced')] === true;\nif (process.env.RENDER_SERVICE_ID && !athlyraxRuntimeIsProduction) {\n\tthrow new Error('Render runtime requires NODE_ENV=production. Refusing unsafe development/default mode.');\n}\nif (athlyraxRuntimeIsProduction && !athlyraxSafeStartProof) {\n\tthrow new Error('Production backend entrypoint must be launched through the guarded production-start/safe-start path. Direct index.js startup is refused.');\n}\n\n${appAnchor}`;
const markerIndex = source.indexOf(runtimeGuardMarker);
if (markerIndex >= 0) {
  const appIndex = source.indexOf(appAnchor, markerIndex);
  if (appIndex < 0) throw new Error('Existing runtime guard has no Express app anchor.');
  source = source.slice(0, markerIndex) + finalRuntimeGuard + source.slice(appIndex + appAnchor.length);
} else {
  if (!source.includes(appAnchor)) throw new Error('Could not find Express app anchor for runtime guard.');
  source = source.replace(appAnchor, finalRuntimeGuard);
}

const authFailClosedMarker = `// ATHLYRAX_PRODUCTION_AUTH_STORE_FAIL_CLOSED`;
if (!source.includes(authFailClosedMarker)) {
  const authAnchor = `\tconst cleanedFromBackup = sanitizeDemoUsers(fromBackup);\n\n\tif (`;
  const authReplacement = `\tconst cleanedFromBackup = sanitizeDemoUsers(fromBackup);\n\n${authFailClosedMarker}\n\tif (IS_PRODUCTION && cleanedFromFile.length < 1) {\n\t\tthrow new Error('Production authentication store is empty. Refusing backup/environment/default account fallback.');\n\t}\n\tif (IS_PRODUCTION && cleanedFromBackup.length < 1) {\n\t\tthrow new Error('Production authentication backup is empty. Refusing startup without a valid backup baseline.');\n\t}\n\n\tif (`;
  if (!source.includes(authAnchor)) throw new Error('Could not find authentication-store fallback anchor.');
  source = source.replace(authAnchor, authReplacement);
}

const authAtomicMarker = `// ATHLYRAX_AUTH_BOOTSTRAP_ATOMIC_WRITES`;
if (!source.includes(authAtomicMarker)) {
  const functionStart = source.indexOf('function loadOrCreateAuthUsers() {');
  const functionEnd = source.indexOf('\nfunction toBase64Url(', functionStart);
  if (functionStart < 0 || functionEnd < 0) throw new Error('Could not locate authentication bootstrap function.');
  let authFunction = source.slice(functionStart, functionEnd)
    .replaceAll('writeJsonFile(AUTH_USERS_PATH,', 'writeAtomicJsonFile(AUTH_USERS_PATH,')
    .replaceAll('writeJsonFile(AUTH_USERS_BACKUP_PATH,', 'writeAtomicJsonFile(AUTH_USERS_BACKUP_PATH,');
  if (authFunction.includes('writeJsonFile(AUTH_USERS_')) throw new Error('Non-atomic authentication bootstrap write remains.');
  authFunction = authFunction.replace('function loadOrCreateAuthUsers() {', `function loadOrCreateAuthUsers() {\n${authAtomicMarker}`);
  source = source.slice(0, functionStart) + authFunction + source.slice(functionEnd);
}

const inviteFailClosedMarker = `// ATHLYRAX_AUTH_INVITES_FAIL_CLOSED`;
if (!source.includes(inviteFailClosedMarker)) {
  const legacyInviteLoader = `function loadOrCreateAuthInvites() {\n\tensureStorageLayout();\n\tconst fromFile = normalizeInviteRows(readJsonFile(AUTH_INVITES_PATH));\n\tif (fromFile.length > 0) return fromFile;\n\twriteJsonFile(AUTH_INVITES_PATH, []);\n\treturn [];\n}`;
  const safeInviteLoader = `function loadOrCreateAuthInvites() {\n${inviteFailClosedMarker}\n\tensureStorageLayout();\n\tif (fs.existsSync(AUTH_INVITES_PATH)) {\n\t\tconst raw = readJsonFile(AUTH_INVITES_PATH);\n\t\tif (!Array.isArray(raw)) throw new Error('Authentication invite store is unreadable or invalid. Refusing to replace it with an empty file.');\n\t\treturn normalizeInviteRows(raw);\n\t}\n\twriteAtomicJsonFile(AUTH_INVITES_PATH, []);\n\treturn [];\n}`;
  if (!source.includes(legacyInviteLoader)) throw new Error('Could not find authentication invite-loader anchor.');
  source = source.replace(legacyInviteLoader, safeInviteLoader);
}

const stripeWebhookMarker = `// ATHLYRAX_STRIPE_WEBHOOK_SIGNATURE_REQUIRED`;
if (!source.includes(stripeWebhookMarker)) {
  const unsafeWebhookBlock = `\ttry {\n\t\tif (BILLING_STRIPE_WEBHOOK_SECRET && signature) {\n\t\t\tevent = stripeClient.webhooks.constructEvent(req.body, signature, BILLING_STRIPE_WEBHOOK_SECRET);\n\t\t} else {\n\t\t\tconst rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '{}');\n\t\t\tevent = JSON.parse(rawBody);\n\t\t}\n\t} catch (error) {`;
  const safeWebhookBlock = `${stripeWebhookMarker}\n\ttry {\n\t\tif (BILLING_STRIPE_WEBHOOK_SECRET) {\n\t\t\tif (!signature) {\n\t\t\t\tres.status(400).json({ error: 'Stripe webhook signature is required.' });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tevent = stripeClient.webhooks.constructEvent(req.body, signature, BILLING_STRIPE_WEBHOOK_SECRET);\n\t\t} else {\n\t\t\tif (IS_PRODUCTION) {\n\t\t\t\tres.status(503).json({ error: 'Stripe webhook verification is not configured.' });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tconst rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '{}');\n\t\t\tevent = JSON.parse(rawBody);\n\t\t}\n\t} catch (error) {`;
  if (!source.includes(unsafeWebhookBlock)) throw new Error('Could not find Stripe webhook anchor.');
  source = source.replace(unsafeWebhookBlock, safeWebhookBlock);
}

const missingTenantResponse = `\t\tappendAuthAuditEvent({\n\t\t\taction: 'tenant_database_missing',\n\t\t\treq,\n\t\t\tstatus: 'blocked',\n\t\t\treason: 'missing_existing_tenant_database',\n\t\t\tdetails: { tenantKey: storagePaths.tenantKey },\n\t\t});\n\t\tres.status(503).json({\n\t\t\terror: 'Tenant data is temporarily unavailable. The server refused to create an empty replacement database.',\n\t\t\ttenantKey: storagePaths.tenantKey,\n\t\t});\n\t\treturn;`;
const unsafeGetBlock = `\tensureStorageLayout(storagePaths);\n\tif (!fs.existsSync(storagePaths.dbPath) && storagePaths.dbPath !== DB_PATH) {\n\t\twriteAtomicJsonFile(storagePaths.dbPath, {});\n\t}`;
const safeGetBlock = `\tensureStorageLayout(storagePaths);\n\tif (!fs.existsSync(storagePaths.dbPath) && storagePaths.dbPath !== DB_PATH) {\n${missingTenantResponse}\n\t}`;
if (source.includes(unsafeGetBlock)) source = source.replace(unsafeGetBlock, safeGetBlock);

const putMarker = `// ATHLYRAX_FAIL_CLOSED_MISSING_TENANT_WRITE`;
if (!source.includes(putMarker)) {
  const putAnchor = `app.put('/db', requireAuth, requireWriteRole, requireBillingWriteAccess, (req, res) => {`;
  const putStart = source.indexOf(putAnchor);
  const existingAnchor = `\tconst existingDb = readJsonFile(storagePaths.dbPath);`;
  const existingIndex = source.indexOf(existingAnchor, putStart);
  if (putStart < 0 || existingIndex < 0) throw new Error('Could not find PUT /db missing-tenant guard anchors.');
  const writeGuard = `${putMarker}\n\tif (!fs.existsSync(storagePaths.dbPath) && storagePaths.dbPath !== DB_PATH) {\n${missingTenantResponse}\n\t}\n\n`;
  source = source.slice(0, existingIndex) + writeGuard + source.slice(existingIndex);
}

const registrationMarker = `// ATHLYRAX_NEW_TENANT_DB_PROVISION`;
if (!source.includes(registrationMarker)) {
  const registerStart = source.indexOf(`app.post('/auth/register', requireLoginRateLimit, (req, res) => {`);
  const roleIndex = source.indexOf(`\tif (role === 'head-coach') {`, registerStart);
  if (registerStart < 0 || roleIndex < 0) throw new Error('Could not find registration provisioning anchors.');
  const provisionBlock = `${registrationMarker}\n\tconst registrationTenantStorage = resolveStoragePathsForTenantKey(tenantId);\n\tconst registrationTenantProvisioningToken = crypto.createHmac('sha256', AUTH_SECRET).update(path.resolve(registrationTenantStorage.dbPath)).digest('hex');\n\tlet registrationTenantDbCreated = false;\n\tif (registrationTenantStorage.dbPath !== DB_PATH && !fs.existsSync(registrationTenantStorage.dbPath)) {\n\t\tif (usableInvite) {\n\t\t\tappendAuthAuditEvent({ action: 'register_blocked', req, status: 'blocked', target: username, reason: 'invited_tenant_database_missing', details: { tenantId } });\n\t\t\tres.status(503).json({ error: 'Team data is temporarily unavailable. Registration was not completed.' });\n\t\t\treturn;\n\t\t}\n\t\tensureStorageLayout(registrationTenantStorage);\n\t\tconst now = new Date().toISOString();\n\t\twriteAtomicJsonFile(registrationTenantStorage.dbPath, {\n\t\t\t__meta: { tenantId, createdAt: now, updatedAt: now, provisionedBy: 'auth-register', provisioningToken: registrationTenantProvisioningToken },\n\t\t\tswimmers: [], squads: [], trainingSessions: [], trainingSessionSets: [], tests: [], attendance: [], fixtures: [], trainingPlannerWeeks: [],\n\t\t});\n\t\tregistrationTenantDbCreated = true;\n\t}\n\n`;
  source = source.slice(0, roleIndex) + provisionBlock + source.slice(roleIndex);

  const catchAnchor = `\t} catch (error) {\n\t\tauthUsers.pop();\n\t\tif (usableInvite) {\n\t\t\tusableInvite.usedCount = Math.max(0, Number(usableInvite.usedCount || 0) - 1);\n\t\t}\n\t\tres.status(500).json({\n\t\t\terror: 'Could not create account.',`;
  const safeCatch = `\t} catch (error) {\n\t\tauthUsers.pop();\n\t\tif (usableInvite) usableInvite.usedCount = Math.max(0, Number(usableInvite.usedCount || 0) - 1);\n\t\ttry { persistAuthUsers(); } catch {}\n\t\tif (usableInvite) { try { persistAuthInvites(); } catch {} }\n\t\tif (registrationTenantDbCreated && registrationTenantStorage.dbPath !== DB_PATH && fs.existsSync(registrationTenantStorage.dbPath)) {\n\t\t\ttry { fs.unlinkSync(registrationTenantStorage.dbPath); } catch {}\n\t\t}\n\t\tres.status(500).json({\n\t\t\terror: 'Could not create account.',`;
  if (!source.includes(catchAnchor)) throw new Error('Could not find registration rollback anchor.');
  source = source.replace(catchAnchor, safeCatch);
}

for (const required of [
  `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants');`,
  `const SHARED_AUTH_USERS_PATH = path.join(STORAGE_ROOT, 'auth', 'auth-users.json');`,
  runtimeGuardMarker,
  `globalThis[Symbol.for('athlyrax.safeStartEnforced')] === true`,
  `Direct index.js startup is refused.`,
  authFailClosedMarker,
  authAtomicMarker,
  inviteFailClosedMarker,
  stripeWebhookMarker,
  putMarker,
  registrationMarker,
  `crypto.createHmac('sha256', AUTH_SECRET).update(path.resolve(registrationTenantStorage.dbPath)).digest('hex')`,
]) if (!source.includes(required)) throw new Error(`Canonical production hardening token is missing: ${required}`);

for (const forbidden of [
  `path.join(STORAGE_ROOT, 'tenants', 'clubs')`,
  `path.join(STORAGE_ROOT, 'auth-users.json')`,
  `writeAtomicJsonFile(storagePaths.dbPath, {});`,
  `writeJsonFile(AUTH_USERS_PATH,`,
  `writeJsonFile(AUTH_USERS_BACKUP_PATH,`,
  `runtimeLegacyMigration = migrateLegacyStorageIfNeeded({`,
  `restoreBundledDemoTenantIfNeeded({`,
  `finalizeLegacyStorageMigration({`,
  `process.env.ATHLYRAX_SAFE_START_ENFORCED`,
  `const registrationTenantProvisioningToken = crypto.randomUUID();`,
]) if (source.includes(forbidden)) throw new Error(`Forbidden legacy/unsafe backend token remains: ${forbidden}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('CANONICAL_STORAGE_CONTRACT_OK');
