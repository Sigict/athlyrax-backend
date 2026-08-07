import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

// Global-owner creation/invite contracts are installed once by the operational
// integrity transform. This transform owns only role-change compatibility.
for (const required of [
  '// ATHLYRAX_GLOBAL_OWNER_ROLE_TENANT_CONTRACT',
  '// ATHLYRAX_INVITE_GLOBAL_OWNER_FORBIDDEN',
]) {
  if (!source.includes(required)) throw new Error(`Required earlier tenant contract is missing: ${required}`);
}

const roleRoute = source.indexOf(`app.put('/auth/users/:username/role', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {`);
const indexAnchor = `\tconst index = authUsers.findIndex((row) => row.username === targetUsername);`;
const indexPosition = source.indexOf(indexAnchor, roleRoute);
if (roleRoute < 0 || indexPosition < 0) throw new Error('Role-update route anchor was not found.');
const notFoundStart = source.indexOf(`\tif (index < 0) {`, indexPosition);
const afterNotFound = source.indexOf(`\t}\n`, notFoundStart) + 3;
if (notFoundStart < 0 || afterNotFound < 3) throw new Error('Role-update not-found block was not found.');
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