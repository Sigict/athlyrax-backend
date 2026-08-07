import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const wrongTenantRoot = `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants', 'clubs');`;
const correctTenantRoot = `const DB_TENANTS_DIR = path.join(STORAGE_ROOT, 'tenants');`;
if (source.includes(wrongTenantRoot)) {
  source = source.replace(wrongTenantRoot, correctTenantRoot);
}
if (!source.includes(correctTenantRoot)) {
  throw new Error('Canonical tenant storage root was not found.');
}

const unsafeCreateBlock = `\tensureStorageLayout(storagePaths);\n\tif (!fs.existsSync(storagePaths.dbPath) && storagePaths.dbPath !== DB_PATH) {\n\t\twriteAtomicJsonFile(storagePaths.dbPath, {});\n\t}`;
const failClosedBlock = `\tensureStorageLayout(storagePaths);\n\tif (!fs.existsSync(storagePaths.dbPath) && storagePaths.dbPath !== DB_PATH) {\n\t\tappendAuthAuditEvent({\n\t\t\taction: 'tenant_database_missing',\n\t\t\treq,\n\t\t\tstatus: 'blocked',\n\t\t\treason: 'missing_existing_tenant_database',\n\t\t\tdetails: { tenantKey: storagePaths.tenantKey },\n\t\t});\n\t\tres.status(503).json({\n\t\t\terror: 'Tenant data is temporarily unavailable. The server refused to create an empty replacement database.',\n\t\t\ttenantKey: storagePaths.tenantKey,\n\t\t});\n\t\treturn;\n\t}`;
if (source.includes(unsafeCreateBlock)) {
  source = source.replace(unsafeCreateBlock, failClosedBlock);
}

if (source.includes(`writeAtomicJsonFile(storagePaths.dbPath, {});`)) {
  throw new Error('Unsafe empty tenant database auto-creation is still present.');
}
for (const token of [
  correctTenantRoot,
  `action: 'tenant_database_missing'`,
  `The server refused to create an empty replacement database.`,
]) {
  if (!source.includes(token)) throw new Error(`Tenant storage safety patch verification failed: ${token}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('TENANT_STORAGE_PATH_SAFETY_PATCH_OK');
