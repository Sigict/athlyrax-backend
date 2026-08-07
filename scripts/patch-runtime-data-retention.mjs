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
  `\t\t.filter(Boolean)\n\t\t.slice(0, 240);\n}\n\nfunction normalizeSwimmerPathway`,
  `\t\t.filter(Boolean);\n}\n\nfunction normalizeSwimmerPathway`,
  'Target-history silent truncation',
);
replaceRequired(
  `\t\t...existingHistory,\n\t].slice(0, 240);`,
  `\t\t...existingHistory,\n\t];`,
  'Disconnect-history silent truncation',
);

replaceRequired(
  `\tconst snapshots = Array.isArray(body?.snapshots) ? body.snapshots.slice(0, SWIMMER_SYNC_MAX_SNAPSHOTS) : [];\n\tconst history = Array.isArray(body?.history) ? body.history.slice(0, SWIMMER_SYNC_MAX_HISTORY_DAYS) : [];\n\tconst pbRows = Array.isArray(body?.pbRows) ? body.pbRows.slice(0, SWIMMER_SYNC_MAX_PB_ROWS) : [];`,
  `\tconst snapshots = Array.isArray(body?.snapshots) ? body.snapshots : [];\n\tconst history = Array.isArray(body?.history) ? body.history : [];\n\tconst pbRows = Array.isArray(body?.pbRows) ? body.pbRows : [];`,
  'Swimmer sync core-array truncation',
);
replaceRequired(
  `\tconst customTestSets = Array.isArray(body?.customTestSets) ? body.customTestSets.slice(0, SWIMMER_SYNC_MAX_TEST_SETS) : [];\n\tconst ispProfile = body?.ispProfile && typeof body.ispProfile === 'object' ? body.ispProfile : null;\n\tconst sanitizedSync = sanitizeSwimmerSyncPayload(swimmerPayload);`,
  `\tconst customTestSets = Array.isArray(body?.customTestSets) ? body.customTestSets : [];\n\tconst ispProfile = body?.ispProfile && typeof body.ispProfile === 'object' ? body.ispProfile : null;\n\tconst oversizedSyncFields = [\n\t\t['snapshots', snapshots.length, SWIMMER_SYNC_MAX_SNAPSHOTS],\n\t\t['history', history.length, SWIMMER_SYNC_MAX_HISTORY_DAYS],\n\t\t['pbRows', pbRows.length, SWIMMER_SYNC_MAX_PB_ROWS],\n\t\t['customTestSets', customTestSets.length, SWIMMER_SYNC_MAX_TEST_SETS],\n\t].filter(([, count, max]) => count > max);\n\tif (oversizedSyncFields.length > 0) {\n\t\tres.status(413).json({ error: 'Swimmer profile payload exceeds a storage safety limit. No data was changed.', fields: oversizedSyncFields.map(([field, count, max]) => ({ field, count, max })) });\n\t\treturn;\n\t}\n\tconst sanitizedSync = sanitizeSwimmerSyncPayload(swimmerPayload);`,
  'Swimmer sync custom-set truncation',
);

const adminPasswordRoute = source.indexOf(`app.put('/auth/users/:username/password', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {`);
const passwordMissing = source.indexOf(`\tif (!targetUsername || !nextPassword) {`, adminPasswordRoute);
if (adminPasswordRoute < 0 || passwordMissing < 0) throw new Error('Admin password route was not found.');
if (!source.includes('// ATHLYRAX_ADMIN_PASSWORD_MINIMUM')) {
  const close = source.indexOf(`\t}\n`, passwordMissing) + 3;
  const guard = `\t// ATHLYRAX_ADMIN_PASSWORD_MINIMUM\n\tif (nextPassword.length < 8) {\n\t\tres.status(400).json({ error: 'Password must be at least 8 characters.' });\n\t\treturn;\n\t}\n\n`;
  source = source.slice(0, close) + guard + source.slice(close);
}

const onboardingRoute = source.indexOf(`app.post('/auth/onboarding/complete', requireStrictAuth, (req, res) => {`);
const onboardingEmailValidation = source.indexOf(`\tif (!AUTH_EMAIL_PATTERN.test(email)) {`, onboardingRoute);
if (onboardingRoute < 0 || onboardingEmailValidation < 0) throw new Error('Onboarding route was not found.');
if (!source.includes('// ATHLYRAX_ONBOARDING_EMAIL_UNIQUE')) {
  const close = source.indexOf(`\t}\n`, onboardingEmailValidation) + 3;
  const guard = `\t// ATHLYRAX_ONBOARDING_EMAIL_UNIQUE\n\tconst duplicateOnboardingEmail = authUsers.some((row) => String(row?.username || '').trim() !== username && String(row?.email || '').trim().toLowerCase() === email.toLowerCase());\n\tif (duplicateOnboardingEmail) {\n\t\tres.status(409).json({ error: 'Email is already registered.' });\n\t\treturn;\n\t}\n\n`;
  source = source.slice(0, close) + guard + source.slice(close);
}

const roleRoute = source.indexOf(`app.put('/auth/users/:username/role', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {`);
const roleIndexLookup = source.indexOf(`\tconst index = authUsers.findIndex((row) => row.username === targetUsername);`, roleRoute);
if (roleRoute < 0 || roleIndexLookup < 0) throw new Error('Role update route was not found.');
if (!source.includes('// ATHLYRAX_PRIMARY_OWNER_ROLE_IMMUTABLE')) {
  const guard = `\t// ATHLYRAX_PRIMARY_OWNER_ROLE_IMMUTABLE\n\tif (targetUsername.toLowerCase() === AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME && nextRole !== 'software-owner') {\n\t\tres.status(409).json({ error: 'The configured primary software-owner role cannot be changed.' });\n\t\treturn;\n\t}\n`;
  source = source.slice(0, roleIndexLookup) + guard + source.slice(roleIndexLookup);
}
const approvalRoute = source.indexOf(`app.put('/auth/users/:username/approval', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {`);
const approvalIndexLookup = source.indexOf(`\tconst index = authUsers.findIndex((row) => row.username === targetUsername);`, approvalRoute);
if (approvalRoute < 0 || approvalIndexLookup < 0) throw new Error('Approval update route was not found.');
if (!source.includes('// ATHLYRAX_PRIMARY_OWNER_APPROVAL_IMMUTABLE')) {
  const guard = `\t// ATHLYRAX_PRIMARY_OWNER_APPROVAL_IMMUTABLE\n\tif (targetUsername.toLowerCase() === AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME && !approved) {\n\t\tres.status(409).json({ error: 'The configured primary software-owner account cannot be unapproved.' });\n\t\treturn;\n\t}\n`;
  source = source.slice(0, approvalIndexLookup) + guard + source.slice(approvalIndexLookup);
}

const oldAuditPrune = `function pruneAuthAuditFiles(paths, keepCount) {\n\tfor (const stalePath of (Array.isArray(paths) ? paths : []).slice(keepCount)) {\n\t\ttry {\n\t\t\tfs.unlinkSync(stalePath);\n\t\t} catch {\n\t\t\t// Ignore cleanup failures for best-effort retention.\n\t\t}\n\t}\n}`;
const safeAuditPrune = `function pruneAuthAuditFiles(paths, keepCount) {\n\t// ATHLYRAX_PRODUCTION_AUDIT_ARCHIVE_BEFORE_DELETE\n\tfor (const stalePath of (Array.isArray(paths) ? paths : []).slice(keepCount)) {\n\t\ttry {\n\t\t\tif (IS_PRODUCTION) {\n\t\t\t\tconst safetyRoot = String(process.env.ATHLYRAX_SAFETY_BACKUP_ROOT || '').trim();\n\t\t\t\tif (!safetyRoot) continue;\n\t\t\t\tconst archiveDir = path.join(path.resolve(safetyRoot), 'auth-audit-retention');\n\t\t\t\tfs.mkdirSync(archiveDir, { recursive: true });\n\t\t\t\tconst sourceBytes = fs.readFileSync(stalePath);\n\t\t\t\tconst archivePath = path.join(archiveDir, \`${'${Date.now()}'}-${'${crypto.randomBytes(4).toString(\'hex\')}'}-${'${path.basename(stalePath)}'}\`);\n\t\t\t\tfs.writeFileSync(archivePath, sourceBytes, { mode: 0o600 });\n\t\t\t\tif (!sourceBytes.equals(fs.readFileSync(archivePath))) { try { fs.unlinkSync(archivePath); } catch {} continue; }\n\t\t\t}\n\t\t\tfs.unlinkSync(stalePath);\n\t\t} catch {\n\t\t\t// Retain the primary file when archival/deletion cannot be verified.\n\t\t}\n\t}\n}`;
replaceRequired(oldAuditPrune, safeAuditPrune, 'Auth audit verified retention');

replaceRequired(
  `function rotateSnapshotFiles(snapshotDir = DB_SNAPSHOT_DIR) {\n\tif (!fs.existsSync(snapshotDir)) return;`,
  `function rotateSnapshotFiles(snapshotDir = DB_SNAPSHOT_DIR) {\n\t// ATHLYRAX_BOUNDED_PRIMARY_DB_SNAPSHOT_RETENTION\n\tif (!fs.existsSync(snapshotDir)) return;`,
  'DB snapshot bounded retention',
);

for (const token of [
  'ATHLYRAX_ADMIN_PASSWORD_MINIMUM',
  'ATHLYRAX_ONBOARDING_EMAIL_UNIQUE',
  'ATHLYRAX_PRIMARY_OWNER_ROLE_IMMUTABLE',
  'ATHLYRAX_PRIMARY_OWNER_APPROVAL_IMMUTABLE',
  'Swimmer profile payload exceeds a storage safety limit. No data was changed.',
  'ATHLYRAX_PRODUCTION_AUDIT_ARCHIVE_BEFORE_DELETE',
  'ATHLYRAX_BOUNDED_PRIMARY_DB_SNAPSHOT_RETENTION',
]) if (!source.includes(token)) throw new Error(`Runtime retention verification failed: ${token}`);

for (const forbidden of [
  'ATHLYRAX_PRODUCTION_AUDIT_RETENTION_NO_SILENT_DELETE',
  'ATHLYRAX_PRODUCTION_DB_SNAPSHOT_RETENTION_NO_SILENT_DELETE',
]) if (source.includes(forbidden)) throw new Error(`Temporary retention marker remains: ${forbidden}`);
if (source.includes(`.slice(0, SWIMMER_SYNC_MAX_`)) throw new Error('Silent swimmer sync truncation remains.');
if (source.includes(`.slice(0, 240);`)) throw new Error('Silent target-history truncation remains.');

fs.writeFileSync(indexPath, source, 'utf8');
console.log('RUNTIME_DATA_RETENTION_PATCH_OK');