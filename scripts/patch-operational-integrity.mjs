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
  `\t\tif (existingIndex === undefined) {\n\t\t\tnextWeeks.push({\n\t\t\t\tid: String(target?.id || ''),\n\t\t\t\tsquadId,\n\t\t\t\tweekStart,\n\t\t\t\tprimaryTargetCompetitionKey: targetKey,\n\t\t\t\tprimaryTargetCompetitionName: targetName,\n\t\t\t\tprimaryTargetCompetitionFixtureId: targetFixtureId,\n\t\t\t});\n\t\t\tweekIndexByKey.set(key, nextWeeks.length - 1);\n\t\t\trecoveredTargets += 1;\n\t\t\tif (targetFixtureId) recoveredFixtureIds += 1;\n\t\t\tcontinue;\n\t\t}`,
  `\t\t// ATHLYRAX_PLANNER_BACKUP_NON_AUTHORITATIVE\n\t\tif (existingIndex === undefined) continue;`,
  'Planner backup missing-week recovery',
);
replaceRequired(
  `\t\tconst hasExplicitTargetField = Object.prototype.hasOwnProperty.call(existingWeek || {}, 'primaryTargetCompetitionKey');\n\t\tconst existingUpdatedAtMs = Date.parse(String(existingWeek?.updatedAt || existingWeek?.createdAt || ''));\n\t\tconst hasTimestampedIntentionalClear = hasExplicitTargetField\n\t\t\t&& !existingTargetKey\n\t\t\t&& Number.isFinite(existingUpdatedAtMs);\n\t\tconst shouldRecoverTarget = !existingTargetKey && !hasTimestampedIntentionalClear;`,
  `\t\t// A backup may fill metadata only for the exact target key that is still\n\t\t// present in the submitted week. It must never restore a missing target.\n\t\tconst shouldRecoverTarget = false;`,
  'Planner backup target restoration',
);
replaceRequired(
  `\t\tconst shouldRecoverName = Boolean(existingTargetKey) && !existingTargetName && Boolean(targetName);\n\t\tconst shouldRecoverFixtureId = Boolean(existingTargetKey) && !existingFixtureId && Boolean(targetFixtureId);`,
  `\t\tconst backupMatchesCurrentTarget = Boolean(existingTargetKey) && targetKey === existingTargetKey;\n\t\tconst shouldRecoverName = backupMatchesCurrentTarget && !existingTargetName && Boolean(targetName);\n\t\tconst shouldRecoverFixtureId = backupMatchesCurrentTarget && !existingFixtureId && Boolean(targetFixtureId);`,
  'Planner backup cross-target metadata recovery',
);
replaceRequired(
  `\t\twriteAtomicJsonFile(storagePaths.backupPath, nextBackup);\n\n\t\treturn {\n\t\t\trecoveredTargets: merged.recoveredTargets,\n\t\t\trecoveredFixtureIds: merged.recoveredFixtureIds,\n\t\t\tstaleWriteIgnored: false,\n\t\t};`,
  `\t\tlet plannerBackupSaved = true;\n\t\ttry {\n\t\t\twriteAtomicJsonFile(storagePaths.backupPath, nextBackup);\n\t\t} catch (backupError) {\n\t\t\tplannerBackupSaved = false;\n\t\t\tconsole.error('[planner-backup] Database was saved but derived planner backup refresh failed:', backupError instanceof Error ? backupError.message : String(backupError));\n\t\t}\n\n\t\treturn {\n\t\t\trecoveredTargets: merged.recoveredTargets,\n\t\t\trecoveredFixtureIds: merged.recoveredFixtureIds,\n\t\t\tstaleWriteIgnored: false,\n\t\t\tplannerBackupSaved,\n\t\t};`,
  'Planner backup post-commit handling',
);
replaceRequired(
  `\t\t\t\tstaleWriteIgnored: result.staleWriteIgnored === true,\n\t\t\t});`,
  `\t\t\t\tstaleWriteIgnored: result.staleWriteIgnored === true,\n\t\t\t\tplannerBackupSaved: result.plannerBackupSaved !== false,\n\t\t\t});`,
  'Planner backup response status',
);

const writeThenSnapshot = `\t\twriteAtomicJsonFile(storagePaths.dbPath, nextDb);\n\t\twriteDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir);`;
const snapshotThenWrite = `\t\t// ATHLYRAX_PREWRITE_DB_SNAPSHOT_ORDER\n\t\twriteDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir);\n\t\twriteAtomicJsonFile(storagePaths.dbPath, nextDb);`;
if (source.includes(writeThenSnapshot)) source = source.replaceAll(writeThenSnapshot, snapshotThenWrite);

replaceRequired(
  `\tconst baseTenantId = resolveAuthTenantId(req.auth);\n\tconst requestedTenantId = normalizeTenantId(req.headers?.['x-athlyrax-tenant']);\n\tconst reason = String(req.headers?.['x-athlyrax-tenant-reason'] || '').trim();`,
  `\tconst baseTenantId = resolveAuthTenantId(req.auth);\n\tconst requestedTenantRaw = String(req.headers?.['x-athlyrax-tenant'] || '').trim();\n\tconst requestedTenantId = normalizeTenantId(requestedTenantRaw);\n\tconst reason = String(req.headers?.['x-athlyrax-tenant-reason'] || '').trim();\n\tif (requestedTenantRaw && (requestedTenantRaw !== requestedTenantId || !/^[a-z0-9_-]+$/.test(requestedTenantRaw))) {\n\t\treturn { ok: false, status: 400, body: { error: 'x-athlyrax-tenant must already be a canonical lowercase tenant ID.' } };\n\t}`,
  'Tenant override canonical validation',
);
replaceRequired(
  `\tres.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');`,
  `\tres.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, X-AthlyraX-Tenant, X-AthlyraX-Tenant-Reason');`,
  'Tenant override CORS headers',
);

const adminCreateAnchor = `\tif (!username || !password) {`;
const adminRouteStart = source.indexOf(`app.post('/auth/users', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {`);
if (adminRouteStart < 0) throw new Error('Admin user-create route was not found.');
const adminValidationIndex = source.indexOf(adminCreateAnchor, adminRouteStart);
if (adminValidationIndex < 0) throw new Error('Admin user-create validation anchor was not found.');
const adminGuard = `\t// ATHLYRAX_ADMIN_USER_REQUIRES_EXISTING_TENANT\n\tconst rawRequestedAdminTenantId = String(req.body?.tenantId || '').trim();\n\tif (rawRequestedAdminTenantId && (rawRequestedAdminTenantId !== normalizeTenantId(rawRequestedAdminTenantId) || !/^[a-z0-9_-]+$/.test(rawRequestedAdminTenantId))) {\n\t\tres.status(400).json({ error: 'tenantId must already be a canonical lowercase tenant ID.' });\n\t\treturn;\n\t}\n\tif (!AUTH_USERNAME_PATTERN.test(username)) {\n\t\tres.status(400).json({ error: 'Username must be 3-32 chars and only use letters, numbers, dot, underscore, or dash.' });\n\t\treturn;\n\t}\n\tif (String(password).length < 8) {\n\t\tres.status(400).json({ error: 'Password must be at least 8 characters.' });\n\t\treturn;\n\t}\n\tif (!['software-owner', 'head-coach', 'assistant-coach', 'viewer', 'swimmer'].includes(role)) {\n\t\tres.status(400).json({ error: 'Role is not allowed.' });\n\t\treturn;\n\t}\n\t// ATHLYRAX_GLOBAL_OWNER_ROLE_TENANT_CONTRACT\n\tif (tenantId === 'global-owner' && role !== 'software-owner') {\n\t\tres.status(400).json({ error: 'Non-software-owner accounts must be bound to an existing tenant database.' });\n\t\treturn;\n\t}\n\tif (role === 'software-owner' && tenantId !== 'global-owner' && actorIsPrimaryOwner) {\n\t\tres.status(400).json({ error: 'Software-owner accounts created by the primary owner must use the global-owner scope.' });\n\t\treturn;\n\t}\n\tif (tenantId && tenantId !== 'global-owner') {\n\t\tconst adminTenantStorage = resolveStoragePathsForTenantKey(tenantId);\n\t\tif (!fs.existsSync(adminTenantStorage.dbPath)) {\n\t\t\tres.status(409).json({ error: 'Cannot create a user for a tenant whose database does not exist. Provision the tenant through the guarded registration flow first.', tenantId });\n\t\t\treturn;\n\t\t}\n\t}\n\n`;
if (!source.includes('// ATHLYRAX_ADMIN_USER_REQUIRES_EXISTING_TENANT')) source = source.slice(0, adminValidationIndex) + adminGuard + source.slice(adminValidationIndex);

const inviteRouteStart = source.indexOf(`app.post('/auth/invites', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {`);
const inviteRoleAnchor = `\tif (role === 'head-coach') {`;
const inviteRoleIndex = source.indexOf(inviteRoleAnchor, inviteRouteStart);
if (inviteRouteStart < 0 || inviteRoleIndex < 0) throw new Error('Invite route guard anchors were not found.');
const inviteGuard = `\t// ATHLYRAX_INVITE_REQUIRES_EXISTING_TENANT\n\tconst rawInviteTenantId = String(req.body?.tenantId || '').trim();\n\tif (actorIsPrimaryOwner && rawInviteTenantId && (rawInviteTenantId !== normalizeTenantId(rawInviteTenantId) || !/^[a-z0-9_-]+$/.test(rawInviteTenantId))) {\n\t\tres.status(400).json({ error: 'tenantId must already be a canonical lowercase tenant ID.' });\n\t\treturn;\n\t}\n\t// ATHLYRAX_INVITE_GLOBAL_OWNER_FORBIDDEN\n\tif (inviteTenantId === 'global-owner') {\n\t\tres.status(400).json({ error: 'Coach/viewer invites must be bound to an existing club tenant, not global-owner.' });\n\t\treturn;\n\t}\n\tif (inviteTenantId) {\n\t\tconst inviteTenantStorage = resolveStoragePathsForTenantKey(inviteTenantId);\n\t\tif (!fs.existsSync(inviteTenantStorage.dbPath)) {\n\t\t\tres.status(409).json({ error: 'Cannot create an invite for a tenant whose database does not exist.', tenantId: inviteTenantId });\n\t\t\treturn;\n\t\t}\n\t}\n`;
if (!source.includes('// ATHLYRAX_INVITE_REQUIRES_EXISTING_TENANT')) source = source.slice(0, inviteRoleIndex) + inviteGuard + source.slice(inviteRoleIndex);

const roleRouteStart = source.indexOf(`app.put('/auth/users/:username/role', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {`);
const roleMissingAnchor = `\tif (!targetUsername || !nextRole) {`;
const roleMissingIndex = source.indexOf(roleMissingAnchor, roleRouteStart);
if (roleRouteStart < 0 || roleMissingIndex < 0) throw new Error('Role-update validation anchors were not found.');
if (!source.includes('// ATHLYRAX_ROLE_VALUE_ALLOWLIST')) {
  const roleGuard = `\t// ATHLYRAX_ROLE_VALUE_ALLOWLIST\n\tif (!['software-owner', 'head-coach', 'assistant-coach', 'viewer', 'swimmer'].includes(nextRole)) {\n\t\tres.status(400).json({ error: 'Role is not allowed.' });\n\t\treturn;\n\t}\n\n`;
  const insertAfter = source.indexOf(`\t}\n`, roleMissingIndex) + 3;
  source = source.slice(0, insertAfter) + roleGuard + source.slice(insertAfter);
}

const cleanStart = source.indexOf('function cleanExpiredInvites() {');
const cleanEnd = source.indexOf('\nfunction findUsableInvite(', cleanStart);
if (cleanStart < 0 || cleanEnd < 0) throw new Error('Invite cleanup function was not found.');
const safeClean = `function cleanExpiredInvites() {\n\t// ATHLYRAX_INVITE_HISTORY_PRESERVED\n\t// Historical invite rows are retained. findUsableInvite/count helpers apply\n\t// expiry, disabled and usage rules without destructive cleanup.\n\treturn;\n}\n`;
if (!source.includes('// ATHLYRAX_INVITE_HISTORY_PRESERVED')) source = source.slice(0, cleanStart) + safeClean + source.slice(cleanEnd);

replaceRequired(
  `\t\t\tconst session = issueAuthToken({ username, role: 'swimmer' });\n\t\t\tres.status(201).json({\n\t\t\t\tok: true,\n\t\t\t\ttoken: session.token,\n\t\t\t\tuser: buildAuthUserPayload(findAuthUser(username)),\n\t\t\t});`,
  `\t\t\tconst session = issueAuthToken({ username, role: 'swimmer' });\n\t\t\tsetAuthCookies(res, { token: session.token, csrfToken: session.csrf });\n\t\t\tres.status(201).json({\n\t\t\t\tok: true,\n\t\t\t\ttoken: session.token,\n\t\t\t\tcsrfToken: session.csrf,\n\t\t\t\tcsrfHeaderName: AUTH_CSRF_HEADER_NAME,\n\t\t\t\tuser: buildAuthUserPayload(findAuthUser(username)),\n\t\t\t});`,
  'Snapshot account creation session',
);
replaceRequired(
  `\tconst session = issueAuthToken(user);\n\tres.status(200).json({ token: session.token, user: buildAuthUserPayload(user) });`,
  `\tconst session = issueAuthToken(user);\n\tsetAuthCookies(res, { token: session.token, csrfToken: session.csrf });\n\tres.status(200).json({ token: session.token, csrfToken: session.csrf, csrfHeaderName: AUTH_CSRF_HEADER_NAME, user: buildAuthUserPayload(user) });`,
  'Snapshot account login session',
);

source = source.replaceAll(`hashPasswordResetCode(resetCode) !== String(resetEntry.codeHash || '')`, `!safeEqualText(hashPasswordResetCode(resetCode), String(resetEntry.codeHash || ''))`);

for (const token of [
  'ATHLYRAX_PLANNER_BACKUP_NON_AUTHORITATIVE', 'backupMatchesCurrentTarget', 'ATHLYRAX_PREWRITE_DB_SNAPSHOT_ORDER',
  'x-athlyrax-tenant must already be a canonical lowercase tenant ID', 'X-AthlyraX-Tenant-Reason',
  'ATHLYRAX_ADMIN_USER_REQUIRES_EXISTING_TENANT', 'ATHLYRAX_GLOBAL_OWNER_ROLE_TENANT_CONTRACT',
  'ATHLYRAX_INVITE_REQUIRES_EXISTING_TENANT', 'ATHLYRAX_INVITE_GLOBAL_OWNER_FORBIDDEN',
  'ATHLYRAX_ROLE_VALUE_ALLOWLIST', 'ATHLYRAX_INVITE_HISTORY_PRESERVED', 'plannerBackupSaved',
  'csrfHeaderName: AUTH_CSRF_HEADER_NAME', '!safeEqualText(hashPasswordResetCode(resetCode)',
]) if (!source.includes(token)) throw new Error(`Operational integrity verification failed: ${token}`);
for (const forbidden of ['ATHLYRAX_PRODUCTION_AUDIT_RETENTION_NO_SILENT_DELETE', 'ATHLYRAX_PRODUCTION_DB_SNAPSHOT_RETENTION_NO_SILENT_DELETE']) {
  if (source.includes(forbidden)) throw new Error(`Operational patch must not own retention behavior: ${forbidden}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('OPERATIONAL_INTEGRITY_PATCH_OK');