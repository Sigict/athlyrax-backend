import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const anchor = `\tif (!usableInvite) {\n\t\tconst tenantHasMembers = getTenantUsersByTenantId(tenantId)\n\t\t\t.some((row) => !isPrimarySoftwareOwnerAccount(row));\n\t\tif (tenantHasMembers) {\n\t\t\tappendAuthAuditEvent({\n\t\t\t\taction: 'register_failed',\n\t\t\t\treq,\n\t\t\t\tstatus: 'blocked',\n\t\t\t\ttarget: username,\n\t\t\t\treason: 'tenant_requires_invite',\n\t\t\t\tdetails: { tenantId },\n\t\t\t});\n\t\t\tres.status(409).json({ error: 'This team already exists. Ask an admin for an invite code.' });\n\t\t\treturn;\n\t\t}\n\t}`;

const hardened = `${anchor.slice(0, -2)}\n\t\t// ATHLYRAX_ORPHAN_TENANT_CLAIM_BLOCKED\n\t\tconst prospectiveTenantStorage = resolveStoragePathsForTenantKey(tenantId);\n\t\tif (!tenantHasMembers && prospectiveTenantStorage.dbPath !== DB_PATH && fs.existsSync(prospectiveTenantStorage.dbPath)) {\n\t\t\tappendAuthAuditEvent({\n\t\t\t\taction: 'register_failed',\n\t\t\t\treq,\n\t\t\t\tstatus: 'blocked',\n\t\t\t\ttarget: username,\n\t\t\t\treason: 'orphan_tenant_storage_requires_recovery',\n\t\t\t\tdetails: { tenantId },\n\t\t\t});\n\t\t\tres.status(409).json({ error: 'Team storage already exists without an active membership. Automatic claiming is blocked; administrator recovery is required.' });\n\t\t\treturn;\n\t\t}\n\t}`;

if (!source.includes('// ATHLYRAX_ORPHAN_TENANT_CLAIM_BLOCKED')) {
  if (!source.includes(anchor)) throw new Error('Registration existing-tenant anchor was not found.');
  source = source.replace(anchor, hardened);
}

if (!source.includes('ATHLYRAX_ORPHAN_TENANT_CLAIM_BLOCKED')) throw new Error('Orphan tenant claim protection was not installed.');
fs.writeFileSync(indexPath, source, 'utf8');
console.log('ORPHAN_TENANT_SAFETY_OK');
