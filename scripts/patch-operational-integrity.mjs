import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

function replaceRequired(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`${label} anchor was not found.`);
  source = source.replace(needle, replacement);
}

// Planner-target backup is derived recovery metadata, not an authoritative
// source of user intent. It must never recreate a deleted week or restore a
// deliberately cleared target during an ordinary PUT /db.
replaceRequired(
  `\t\tif (existingIndex === undefined) {\n\t\t\tnextWeeks.push({\n\t\t\t\tid: String(target?.id || ''),\n\t\t\t\tsquadId,\n\t\t\t\tweekStart,\n\t\t\t\tprimaryTargetCompetitionKey: targetKey,\n\t\t\t\tprimaryTargetCompetitionName: targetName,\n\t\t\t\tprimaryTargetCompetitionFixtureId: targetFixtureId,\n\t\t\t});\n\t\t\tweekIndexByKey.set(key, nextWeeks.length - 1);\n\t\t\trecoveredTargets += 1;\n\t\t\tif (targetFixtureId) recoveredFixtureIds += 1;\n\t\t\tcontinue;\n\t\t}`,
  `\t\t// ATHLYRAX_PLANNER_BACKUP_NON_AUTHORITATIVE\n\t\tif (existingIndex === undefined) continue;`,
  'Planner backup missing-week recovery',
);
replaceRequired(
  `\t\tconst hasExplicitTargetField = Object.prototype.hasOwnProperty.call(existingWeek || {}, 'primaryTargetCompetitionKey');\n\t\tconst existingUpdatedAtMs = Date.parse(String(existingWeek?.updatedAt || existingWeek?.createdAt || ''));\n\t\tconst hasTimestampedIntentionalClear = hasExplicitTargetField\n\t\t\t&& !existingTargetKey\n\t\t\t&& Number.isFinite(existingUpdatedAtMs);\n\t\tconst shouldRecoverTarget = !existingTargetKey && !hasTimestampedIntentionalClear;`,
  `\t\t// A backup may fill metadata only for a target that still exists in the\n\t\t// submitted week. It must never restore a missing target key.\n\t\tconst shouldRecoverTarget = false;`,
  'Planner backup target restoration',
);

// A successful database commit must not be reported as a failed write merely
// because the derived planner backup could not be refreshed. The backup is no
// longer authoritative and its failure is surfaced separately.
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

// Administrative user creation may bind only to an already-existing tenant.
// New tenant provisioning must go through the guarded registration path rather
// than creating an auth identity that points at missing storage.
const adminCreateAnchor = `\tif (!username || !password) {`;
const adminRouteStart = source.indexOf(`app.post('/auth/users', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {`);
if (adminRouteStart < 0) throw new Error('Admin user-create route was not found.');
const adminValidationIndex = source.indexOf(adminCreateAnchor, adminRouteStart);
if (adminValidationIndex < 0) throw new Error('Admin user-create validation anchor was not found.');
const adminGuard = `\t// ATHLYRAX_ADMIN_USER_REQUIRES_EXISTING_TENANT\n\tif (tenantId && tenantId !== 'global-owner') {\n\t\tconst adminTenantStorage = resolveStoragePathsForTenantKey(tenantId);\n\t\tif (!fs.existsSync(adminTenantStorage.dbPath)) {\n\t\t\tres.status(409).json({ error: 'Cannot create a user for a tenant whose database does not exist. Provision the tenant through the guarded registration flow first.', tenantId });\n\t\t\treturn;\n\t\t}\n\t}\n\n`;
if (!source.includes('// ATHLYRAX_ADMIN_USER_REQUIRES_EXISTING_TENANT')) {
  source = source.slice(0, adminValidationIndex) + adminGuard + source.slice(adminValidationIndex);
}

// Invites must never point at a missing tenant database, otherwise an invited
// user can be created into an unusable account or trigger recovery ambiguity.
const inviteRouteStart = source.indexOf(`app.post('/auth/invites', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {`);
const inviteRoleAnchor = `\tif (role === 'head-coach') {`;
const inviteRoleIndex = source.indexOf(inviteRoleAnchor, inviteRouteStart);
if (inviteRouteStart < 0 || inviteRoleIndex < 0) throw new Error('Invite route guard anchors were not found.');
const inviteGuard = `\t// ATHLYRAX_INVITE_REQUIRES_EXISTING_TENANT\n\tif (inviteTenantId && inviteTenantId !== 'global-owner') {\n\t\tconst inviteTenantStorage = resolveStoragePathsForTenantKey(inviteTenantId);\n\t\tif (!fs.existsSync(inviteTenantStorage.dbPath)) {\n\t\t\tres.status(409).json({ error: 'Cannot create an invite for a tenant whose database does not exist.', tenantId: inviteTenantId });\n\t\t\treturn;\n\t\t}\n\t}\n`;
if (!source.includes('// ATHLYRAX_INVITE_REQUIRES_EXISTING_TENANT')) {
  source = source.slice(0, inviteRoleIndex) + inviteGuard + source.slice(inviteRoleIndex);
}

// Keep invite history. Expiry/usage checks already determine usability; deleting
// historical invite rows during unrelated operations destroys audit evidence.
const cleanStart = source.indexOf('function cleanExpiredInvites() {');
const cleanEnd = source.indexOf('\nfunction findUsableInvite(', cleanStart);
if (cleanStart < 0 || cleanEnd < 0) throw new Error('Invite cleanup function was not found.');
const safeClean = `function cleanExpiredInvites() {\n\t// ATHLYRAX_INVITE_HISTORY_PRESERVED\n\t// Historical invite rows are retained. findUsableInvite/count helpers apply\n\t// expiry, disabled and usage rules without destructive cleanup.\n\treturn;\n}\n`;
if (!source.includes('// ATHLYRAX_INVITE_HISTORY_PRESERVED')) {
  source = source.slice(0, cleanStart) + safeClean + source.slice(cleanEnd);
}

// Snapshot-account authentication must use the same production cookie + CSRF
// session mechanism as normal authentication. Production bearer compatibility
// is disabled, so returning a token only creates a session that cannot write.
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

// Reset-code comparisons use constant-time comparison just like session tokens.
source = source.replaceAll(
  `hashPasswordResetCode(resetCode) !== String(resetEntry.codeHash || '')`,
  `!safeEqualText(hashPasswordResetCode(resetCode), String(resetEntry.codeHash || ''))`,
);

// Production recovery/audit snapshots are evidence. Do not silently prune them
// just because a count threshold is reached; retention/deletion must be an
// explicit maintenance operation.
replaceRequired(
  `function pruneAuthAuditFiles(paths, keepCount) {\n\tfor (const stalePath of (Array.isArray(paths) ? paths : []).slice(keepCount)) {`,
  `function pruneAuthAuditFiles(paths, keepCount) {\n\t// ATHLYRAX_PRODUCTION_AUDIT_RETENTION_NO_SILENT_DELETE\n\tif (IS_PRODUCTION) return;\n\tfor (const stalePath of (Array.isArray(paths) ? paths : []).slice(keepCount)) {`,
  'Production auth-audit retention',
);
replaceRequired(
  `function rotateSnapshotFiles(snapshotDir = DB_SNAPSHOT_DIR) {\n\tif (!fs.existsSync(snapshotDir)) return;`,
  `function rotateSnapshotFiles(snapshotDir = DB_SNAPSHOT_DIR) {\n\t// ATHLYRAX_PRODUCTION_DB_SNAPSHOT_RETENTION_NO_SILENT_DELETE\n\tif (IS_PRODUCTION) return;\n\tif (!fs.existsSync(snapshotDir)) return;`,
  'Production database snapshot retention',
);

for (const token of [
  'ATHLYRAX_PLANNER_BACKUP_NON_AUTHORITATIVE',
  'ATHLYRAX_ADMIN_USER_REQUIRES_EXISTING_TENANT',
  'ATHLYRAX_INVITE_REQUIRES_EXISTING_TENANT',
  'ATHLYRAX_INVITE_HISTORY_PRESERVED',
  'plannerBackupSaved',
  'csrfHeaderName: AUTH_CSRF_HEADER_NAME',
  '!safeEqualText(hashPasswordResetCode(resetCode)',
  'ATHLYRAX_PRODUCTION_AUDIT_RETENTION_NO_SILENT_DELETE',
  'ATHLYRAX_PRODUCTION_DB_SNAPSHOT_RETENTION_NO_SILENT_DELETE',
]) {
  if (!source.includes(token)) throw new Error(`Operational integrity verification failed: ${token}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('OPERATIONAL_INTEGRITY_PATCH_OK');
