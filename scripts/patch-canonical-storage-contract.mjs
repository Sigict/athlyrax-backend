import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const replacements = [
  [
    `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants', 'clubs');`,
    `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants');`,
  ],
  [
    `const SHARED_AUTH_USERS_PATH = path.join(STORAGE_ROOT, 'auth-users.json');`,
    `const SHARED_AUTH_USERS_PATH = path.join(STORAGE_ROOT, 'auth', 'auth-users.json');`,
  ],
];

for (const [legacy, canonical] of replacements) {
  if (source.includes(legacy)) source = source.replace(legacy, canonical);
  if (!source.includes(canonical)) throw new Error(`Canonical storage declaration missing after patch: ${canonical}`);
}

const unsafeCreateBlock = `\tensureStorageLayout(storagePaths);\n\tif (!fs.existsSync(storagePaths.dbPath) && storagePaths.dbPath !== DB_PATH) {\n\t\twriteAtomicJsonFile(storagePaths.dbPath, {});\n\t}`;
const failClosedBlock = `\tensureStorageLayout(storagePaths);\n\tif (!fs.existsSync(storagePaths.dbPath) && storagePaths.dbPath !== DB_PATH) {\n\t\tappendAuthAuditEvent({\n\t\t\taction: 'tenant_database_missing',\n\t\t\treq,\n\t\t\tstatus: 'blocked',\n\t\t\treason: 'missing_existing_tenant_database',\n\t\t\tdetails: { tenantKey: storagePaths.tenantKey },\n\t\t});\n\t\tres.status(503).json({\n\t\t\terror: 'Tenant data is temporarily unavailable. The server refused to create an empty replacement database.',\n\t\t\ttenantKey: storagePaths.tenantKey,\n\t\t});\n\t\treturn;\n\t}`;

if (source.includes(unsafeCreateBlock)) source = source.replace(unsafeCreateBlock, failClosedBlock);

const forbidden = [
  `path.join(STORAGE_ROOT, 'tenants', 'clubs')`,
  `path.join(STORAGE_ROOT, 'auth-users.json')`,
  `writeAtomicJsonFile(storagePaths.dbPath, {});`,
];
for (const token of forbidden) {
  if (source.includes(token)) throw new Error(`Forbidden legacy storage behavior remains in index.js: ${token}`);
}

for (const token of [
  `path.join(STORAGE_ROOT, 'tenants')`,
  `path.join(STORAGE_ROOT, 'auth', 'auth-users.json')`,
  `action: 'tenant_database_missing'`,
  `The server refused to create an empty replacement database.`,
]) {
  if (!source.includes(token)) throw new Error(`Canonical storage verification failed: ${token}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('CANONICAL_STORAGE_CONTRACT_PATCH_OK');
