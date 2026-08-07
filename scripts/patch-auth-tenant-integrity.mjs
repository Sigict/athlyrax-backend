import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

function replaceRequired(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`${label} anchor was not found.`);
  source = source.replace(needle, replacement);
}

replaceRequired(
  `\tif (tenantId && tenantId !== 'global-owner') {\n\t\tconst adminTenantStorage = resolveStoragePathsForTenantKey(tenantId);`,
  `\t// ATHLYRAX_GLOBAL_OWNER_ROLE_TENANT_CONTRACT\n\tif (tenantId === 'global-owner' && role !== 'software-owner') {\n\t\tres.status(400).json({ error: 'Non-software-owner accounts must be bound to an existing tenant database.' });\n\t\treturn;\n\t}\n\tif (role === 'software-owner' && tenantId !== 'global-owner' && actorIsPrimaryOwner) {\n\t\tres.status(400).json({ error: 'Software-owner accounts created by the primary owner must use the global-owner scope.' });\n\t\treturn;\n\t}\n\tif (tenantId && tenantId !== 'global-owner') {\n\t\tconst adminTenantStorage = resolveStoragePathsForTenantKey(tenantId);`,
  'Admin global-owner tenant contract',
);

replaceRequired(
  `\tif (inviteTenantId && inviteTenantId !== 'global-owner') {\n\t\tconst inviteTenantStorage = resolveStoragePathsForTenantKey(inviteTenantId);`,
  `\t// ATHLYRAX_INVITE_GLOBAL_OWNER_FORBIDDEN\n\tif (inviteTenantId === 'global-owner') {\n\t\tres.status(400).json({ error: 'Coach/viewer invites must be bound to an existing club tenant, not global-owner.' });\n\t\treturn;\n\t}\n\tif (inviteTenantId) {\n\t\tconst inviteTenantStorage = resolveStoragePathsForTenantKey(inviteTenantId);`,
  'Invite global-owner tenant contract',
);

const roleRoute = source.indexOf(`app.put('/auth/users/:username/role', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {`);
const indexAnchor = `\tconst index = authUsers.findIndex((row) => row.username === targetUsername);`;
const indexPosition = source.indexOf(indexAnchor, roleRoute);
if (roleRoute < 0 || indexPosition < 0) throw new Error('Role-update route anchor was not found.');
const afterNotFound = source.indexOf(`\t}\n`, source.indexOf(`\tif (index < 0) {`, indexPosition)) + 3;
if (afterNotFound < 3) throw new Error('Role-update not-found block was not found.');
if (!source.includes('// ATHLYRAX_ROLE_TENANT_COMPATIBILITY')) {
  const guard = `\t// ATHLYRAX_ROLE_TENANT_COMPATIBILITY\n\tconst roleTargetTenant = resolveAuthTenantId(authUsers[index]);\n\tif (roleTargetTenant === 'global-owner' && nextRole !== 'software-owner') {\n\t\tres.status(409).json({ error: 'A global-owner account cannot be changed to a tenant-bound role without an explicit tenant reassignment workflow.' });\n\t\treturn;\n\t}\n\n`;
  source = source.slice(0, afterNotFound) + guard + source.slice(afterNotFound);
}

for (const token of [
  'ATHLYRAX_GLOBAL_OWNER_ROLE_TENANT_CONTRACT',
  'ATHLYRAX_INVITE_GLOBAL_OWNER_FORBIDDEN',
  'ATHLYRAX_ROLE_TENANT_COMPATIBILITY',
]) if (!source.includes(token)) throw new Error(`Auth tenant integrity verification failed: ${token}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('AUTH_TENANT_INTEGRITY_PATCH_OK');
