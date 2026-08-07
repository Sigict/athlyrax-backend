import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_LAST_TENANT_ACCOUNT_DELETE_BLOCKED';
if (!source.includes(marker)) {
  const anchor = `\tconst currentUserName = String(req.auth?.username || '').trim();\n\tif (targetUsername === currentUserName) {\n\t\tres.status(400).json({ error: 'You cannot delete your own active account.' });\n\t\treturn;\n\t}\n\n\tconst [removed] = authUsers.splice(index, 1);`;
  const replacement = `\tconst currentUserName = String(req.auth?.username || '').trim();\n\tif (targetUsername === currentUserName) {\n\t\tres.status(400).json({ error: 'You cannot delete your own active account.' });\n\t\treturn;\n\t}\n\n\t${marker}\n\tconst targetTenantId = resolveAuthTenantId(authUsers[index]);\n\tconst tenantIsSharedSnapshot = targetTenantId === 'snapshot-public';\n\tconst tenantIsGlobalOwner = targetTenantId === 'global-owner';\n\tif (targetTenantId && !tenantIsSharedSnapshot && !tenantIsGlobalOwner) {\n\t\tconst remainingTenantUsers = authUsers.filter((row, rowIndex) => rowIndex !== index && resolveAuthTenantId(row) === targetTenantId);\n\t\tconst tenantStorage = resolveStoragePathsForTenantKey(targetTenantId);\n\t\tif (remainingTenantUsers.length === 0 && tenantStorage.dbPath !== DB_PATH && fs.existsSync(tenantStorage.dbPath)) {\n\t\t\tappendAuthAuditEvent({\n\t\t\t\taction: 'user_delete_blocked',\n\t\t\t\treq,\n\t\t\t\tstatus: 'blocked',\n\t\t\t\ttarget: targetUsername,\n\t\t\t\treason: 'last_tenant_account_with_data',\n\t\t\t\tdetails: { tenantId: targetTenantId },\n\t\t\t});\n\t\t\tres.status(409).json({\n\t\t\t\terror: 'Cannot delete the last account for a tenant while its database still exists. Reassign or explicitly archive the tenant data first.',\n\t\t\t\ttenantId: targetTenantId,\n\t\t\t});\n\t\t\treturn;\n\t\t}\n\t}\n\n\tconst [removed] = authUsers.splice(index, 1);`;
  if (!source.includes(anchor)) throw new Error('User deletion lifecycle anchor was not found.');
  source = source.replace(anchor, replacement);
}

for (const token of [
  'ATHLYRAX_LAST_TENANT_ACCOUNT_DELETE_BLOCKED',
  'last_tenant_account_with_data',
  'Cannot delete the last account for a tenant while its database still exists.',
]) if (!source.includes(token)) throw new Error(`Account lifecycle integrity token is missing: ${token}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ACCOUNT_LIFECYCLE_INTEGRITY_OK');
