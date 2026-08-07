import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const storageSafetyImport = `import { resolveStorageConfiguration, runStorageSafetyCheck } from './scripts/storage-safety-lib.mjs';`;
const storageContractImport = `import { migrateLegacyStorageIfNeeded, restoreBundledDemoTenantIfNeeded } from './scripts/storage-path-contract.mjs';`;
const importAnchor = `import Stripe from 'stripe';`;

const obsoleteStorageSafetyImport = `import { runStorageSafetyCheck } from './scripts/storage-safety-lib.mjs';`;
const obsoleteStorageContractImports = [
  `import { restoreBundledDemoTenantIfNeeded } from './scripts/storage-path-contract.mjs';`,
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
const runtimeGuard = `${runtimeGuardMarker}\nif (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {\n\tconst runtimeStorageConfiguration = resolveStorageConfiguration(process.env, __dirname);\n\tif (runtimeStorageConfiguration.failures.length > 0) {\n\t\tconst error = new Error(runtimeStorageConfiguration.failures.join('\\n'));\n\t\terror.code = 'ATHLYRAX_STORAGE_CONFIGURATION_INVALID';\n\t\tthrow error;\n\t}\n\tmigrateLegacyStorageIfNeeded({\n\t\tsourceRoot: __dirname,\n\t\tstorageRoot: runtimeStorageConfiguration.storageRoot,\n\t\tbackupRoot: runtimeStorageConfiguration.backupRoot,\n\t});\n\trestoreBundledDemoTenantIfNeeded({\n\t\tsourceRoot: __dirname,\n\t\tstorageRoot: runtimeStorageConfiguration.storageRoot,\n\t\tbackupRoot: runtimeStorageConfiguration.backupRoot,\n\t});\n\trunStorageSafetyCheck({ repoRoot: __dirname, requireFiles: true, createDirectories: true });\n\tprocess.env.ATHLYRAX_SAFE_START_ENFORCED = 'true';\n}\n\n${appAnchor}`;

if (!source.includes(runtimeGuardMarker)) {
  if (!source.includes(appAnchor)) throw new Error('Could not find Express app anchor for canonical storage guard.');
  source = source.replace(appAnchor, runtimeGuard);
} else {
  for (const required of ['runtimeStorageConfiguration = resolveStorageConfiguration', 'migrateLegacyStorageIfNeeded({']) {
    if (!source.includes(required)) throw new Error(`Existing canonical runtime guard is stale: missing ${required}`);
  }
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

const forbidden = [
  `path.join(STORAGE_ROOT, 'tenants', 'clubs')`,
  `path.join(STORAGE_ROOT, 'auth-users.json')`,
  `writeAtomicJsonFile(storagePaths.dbPath, {});`,
  obsoleteStorageSafetyImport,
];
for (const token of forbidden) {
  if (source.includes(token)) throw new Error(`Forbidden legacy storage behavior remains in index.js: ${token}`);
}

for (const token of [
  storageSafetyImport,
  storageContractImport,
  runtimeGuardMarker,
  putMarker,
  `resolveStorageConfiguration(process.env, __dirname)`,
  `migrateLegacyStorageIfNeeded({`,
  `runStorageSafetyCheck({`,
  `restoreBundledDemoTenantIfNeeded({`,
  `path.join(STORAGE_ROOT, 'tenants')`,
  `path.join(STORAGE_ROOT, 'auth', 'auth-users.json')`,
  `action: 'tenant_database_missing'`,
  `The server refused to create an empty replacement database.`,
]) {
  if (!source.includes(token)) throw new Error(`Canonical storage verification failed: ${token}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('CANONICAL_STORAGE_CONTRACT_PATCH_OK');
