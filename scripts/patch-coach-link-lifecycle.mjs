import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_COACH_LINK_LIFECYCLE_V1';
if (!source.includes('ATHLYRAX_COACH_LINK_WORKFLOW_V1')) {
  throw new Error('Coach-link workflow must be applied before lifecycle hardening.');
}

if (!source.includes(marker)) {
  const managerFunction = `function requireCoachLinkManagerRole(req, res, next) {\n\tconst role = String(req.auth?.role || '').trim().toLowerCase();\n\tif (role === 'head-coach' || role === 'assistant-coach') {\n\t\tnext();\n\t\treturn;\n\t}\n\tres.status(403).json({ error: 'Coach account required for swimmer connection decisions.' });\n}`;
  const hardenedFunctions = `${managerFunction}\n\n${marker}\nfunction requireCoachLinkDecisionRole(req, res, next) {\n\tconst role = String(req.auth?.role || '').trim().toLowerCase();\n\tif (role === 'head-coach') {\n\t\tnext();\n\t\treturn;\n\t}\n\tappendAuthAuditEvent({\n\t\taction: 'unauthorized_access_blocked',\n\t\treq,\n\t\tstatus: 'blocked',\n\t\treason: 'head_coach_required_for_swimmer_membership_decision',\n\t\tdetails: { role, path: req.path },\n\t});\n\tres.status(403).json({ error: 'Session Coordinator approval is required for swimmer membership decisions.' });\n}`;
  if (!source.includes(managerFunction)) throw new Error('Coach-link manager role function anchor not found.');
  source = source.replace(managerFunction, hardenedFunctions);

  source = source.replace(
    "app.post('/coach/swimmer-links/:requestId/accept', requireStrictAuth, requireCoachLinkManagerRole, (req, res) => {",
    "app.post('/coach/swimmer-links/:requestId/accept', requireStrictAuth, requireCoachLinkDecisionRole, (req, res) => {",
  );
  source = source.replace(
    "app.post('/coach/swimmer-links/:requestId/reject', requireStrictAuth, requireCoachLinkManagerRole, (req, res) => {",
    "app.post('/coach/swimmer-links/:requestId/reject', requireStrictAuth, requireCoachLinkDecisionRole, (req, res) => {",
  );

  const rawListResponse = `\t\tconst requests = Array.isArray(db?.coachLinkRequests) ? db.coachLinkRequests : [];\n\t\tres.status(200).json({ ok: true, tenantId, requests });`;
  const privateListResponse = `\t\tconst requests = Array.isArray(db?.coachLinkRequests) ? db.coachLinkRequests : [];\n\t\t// ATHLYRAX_COACH_LINK_PARENT_CONTACTS_PRIVATE\n\t\tconst publicRequests = requests.map((row) => ({\n\t\t\tid: String(row?.id || ''),\n\t\t\tstatus: String(row?.status || ''),\n\t\t\trequestedAt: String(row?.requestedAt || ''),\n\t\t\tdecidedAt: String(row?.decidedAt || ''),\n\t\t\tdecidedBy: String(row?.decidedBy || ''),\n\t\t\tswimmerUsername: String(row?.swimmerUsername || ''),\n\t\t\tswimmerEmail: String(row?.swimmerEmail || ''),\n\t\t\tswimmerName: String(row?.swimmerName || ''),\n\t\t\tswimmerId: String(row?.swimmerId || ''),\n\t\t\tcoachEmail: String(row?.coachEmail || ''),\n\t\t}));\n\t\tres.status(200).json({ ok: true, tenantId, requests: publicRequests });`;
  if (!source.includes(rawListResponse)) throw new Error('Coach-link list response anchor not found.');
  source = source.replace(rawListResponse, privateListResponse);

  const disconnectStart = source.indexOf("app.post('/swimmer/coach/disconnect', requireStrictAuth, requireSwimmerRole, (req, res) => {");
  const disconnectEndMarker = '\n// Serve db.json at /db';
  const disconnectEnd = source.indexOf(disconnectEndMarker, disconnectStart);
  if (disconnectStart < 0 || disconnectEnd < 0) throw new Error('Swimmer disconnect route bounds not found.');

  const safeDisconnect = `app.post('/swimmer/coach/disconnect', requireStrictAuth, requireSwimmerRole, (req, res) => {\n\t// ATHLYRAX_COACH_LINK_DISCONNECT_COPY_BACK_FIRST\n\tconst authUsername = String(req.auth?.username || '').trim();\n\tconst authUserIndex = authUsers.findIndex((row) => String(row?.username || '').trim().toLowerCase() === authUsername.toLowerCase());\n\tif (authUserIndex < 0 || String(authUsers[authUserIndex]?.role || '').trim().toLowerCase() !== 'swimmer') {\n\t\tres.status(404).json({ error: 'Swimmer account was not found.' });\n\t\treturn;\n\t}\n\n\tconst currentTenantId = resolveTenantKeyFromUser(authUsers[authUserIndex]);\n\tconst currentPaths = resolveStoragePathsForTenantKey(currentTenantId);\n\ttry {\n\t\tconst currentDb = readCoachLinkDbStrict(currentPaths, 'Current swimmer');\n\t\tconst currentRows = Array.isArray(currentDb?.swimmers) ? currentDb.swimmers.slice() : [];\n\t\tconst currentIndex = findBoundSwimmerIndex(currentRows, authUsername);\n\t\tif (currentIndex < 0) {\n\t\t\tres.status(409).json({ error: 'Current swimmer profile binding is missing. Disconnect was not performed.' });\n\t\t\treturn;\n\t\t}\n\n\t\tconst currentRow = currentRows[currentIndex] && typeof currentRows[currentIndex] === 'object' ? currentRows[currentIndex] : {};\n\t\tconst wasApproved = String(currentRow?.coachLinkStatus || '').trim().toLowerCase() === 'approved';\n\t\tconst sourceTenantId = normalizeTenantId(currentRow?.coachLinkSourceTenantId);\n\t\tconst disconnectedAt = new Date().toISOString();\n\n\t\tif (!wasApproved) {\n\t\t\tconst nextRows = currentRows.slice();\n\t\t\tnextRows[currentIndex] = {\n\t\t\t\t...currentRow,\n\t\t\t\tpathway: 'individual',\n\t\t\t\tcoachConnected: false,\n\t\t\t\tcoachLinkStatus: 'none',\n\t\t\t\tcoachEmail: '',\n\t\t\t\tcoachCode: '',\n\t\t\t\tcoachPhase: '',\n\t\t\t\tcoachRequestAt: '',\n\t\t\t\tcoachReplyAt: '',\n\t\t\t\tcoachApprovalAt: '',\n\t\t\t\tshareMode: 'Feedback link only',\n\t\t\t\tcoachConnectionStatus: { state: 'disconnected-by-swimmer', disconnectedAt, disconnectedBy: authUsername },\n\t\t\t};\n\t\t\twriteDbSnapshotIfPossible(currentPaths.dbPath, currentPaths.snapshotDir);\n\t\t\twriteAtomicJsonFile(currentPaths.dbPath, { ...currentDb, swimmers: nextRows });\n\t\t\tres.status(200).json({ ok: true, swimmerId: String(nextRows[currentIndex]?.id || ''), disconnectedAt, tenantId: currentTenantId });\n\t\t\treturn;\n\t\t}\n\n\t\tif (!sourceTenantId || sourceTenantId === currentTenantId || sourceTenantId === 'global-owner') {\n\t\t\tres.status(409).json({ error: 'Original swimmer tenant is missing or invalid. Disconnect was blocked to protect swimmer data.' });\n\t\t\treturn;\n\t\t}\n\n\t\tconst sourcePaths = resolveStoragePathsForTenantKey(sourceTenantId);\n\t\tconst sourceDb = readCoachLinkDbStrict(sourcePaths, 'Original swimmer');\n\t\tconst sourceRows = Array.isArray(sourceDb?.swimmers) ? sourceDb.swimmers.slice() : [];\n\t\tconst sourceIndex = findBoundSwimmerIndex(sourceRows, authUsername);\n\t\tif (sourceIndex < 0) {\n\t\t\tres.status(409).json({ error: 'Original swimmer profile binding is missing. Disconnect was blocked to protect swimmer data.' });\n\t\t\treturn;\n\t\t}\n\n\t\tconst restoredRow = {\n\t\t\t...currentRow,\n\t\t\tpathway: 'individual',\n\t\t\tcoachConnected: false,\n\t\t\tcoachLinkStatus: 'none',\n\t\t\tcoachEmail: '',\n\t\t\tcoachCode: '',\n\t\t\tcoachPhase: '',\n\t\t\tcoachRequestAt: '',\n\t\t\tcoachReplyAt: '',\n\t\t\tcoachApprovalAt: '',\n\t\t\tcoachLinkSourceTenantId: '',\n\t\t\tcoachTargetTenantId: '',\n\t\t\tshareMode: 'Feedback link only',\n\t\t\tcoachConnectionStatus: { state: 'disconnected-by-swimmer', disconnectedAt, disconnectedBy: authUsername },\n\t\t};\n\t\tconst nextSourceRows = sourceRows.slice();\n\t\tnextSourceRows[sourceIndex] = restoredRow;\n\t\tconst nextSourceDb = { ...sourceDb, swimmers: nextSourceRows };\n\n\t\t// Copy the newest swimmer record back to the original tenant before changing auth routing.\n\t\twriteDbSnapshotIfPossible(sourcePaths.dbPath, sourcePaths.snapshotDir);\n\t\twriteAtomicJsonFile(sourcePaths.dbPath, nextSourceDb);\n\n\t\tconst previousAuthUser = authUsers[authUserIndex];\n\t\tauthUsers[authUserIndex] = { ...previousAuthUser, tenantId: sourceTenantId };\n\t\ttry {\n\t\t\tpersistAuthUsers();\n\t\t} catch (error) {\n\t\t\tauthUsers[authUserIndex] = previousAuthUser;\n\t\t\twriteAtomicJsonFile(sourcePaths.dbPath, sourceDb);\n\t\t\tthrow error;\n\t\t}\n\n\t\t// Preserve the coach-tenant copy as a disconnected archive; never delete either copy.\n\t\ttry {\n\t\t\tconst archiveRows = currentRows.slice();\n\t\t\tarchiveRows[currentIndex] = {\n\t\t\t\t...currentRow,\n\t\t\t\tcoachConnected: false,\n\t\t\t\tcoachLinkStatus: 'disconnected',\n\t\t\t\tcoachPhase: '',\n\t\t\t\tshareMode: 'Disconnected archive',\n\t\t\t\tcoachConnectionStatus: { state: 'disconnected-by-swimmer', disconnectedAt, disconnectedBy: authUsername },\n\t\t\t};\n\t\t\twriteDbSnapshotIfPossible(currentPaths.dbPath, currentPaths.snapshotDir);\n\t\t\twriteAtomicJsonFile(currentPaths.dbPath, { ...currentDb, swimmers: archiveRows });\n\t\t} catch (archiveError) {\n\t\t\tappendAuthAuditEvent({ action: 'coach_link_disconnect_archive_update_failed', req, status: 'error', target: authUsername, details: { message: archiveError instanceof Error ? archiveError.message : 'Unknown error' } });\n\t\t}\n\n\t\tappendAuthAuditEvent({\n\t\t\taction: 'swimmer_coach_disconnected', req, status: 'success', target: authUsername,\n\t\t\tdetails: { disconnectedAt, fromTenantId: currentTenantId, restoredTenantId: sourceTenantId },\n\t\t});\n\t\tres.status(200).json({ ok: true, swimmerId: String(restoredRow?.id || ''), disconnectedAt, tenantId: sourceTenantId });\n\t} catch (error) {\n\t\tres.status(500).json({ error: 'Could not disconnect coach connection safely.', details: error instanceof Error ? error.message : 'Unknown error' });\n\t}\n});\n`;

  source = source.slice(0, disconnectStart) + safeDisconnect + source.slice(disconnectEnd);
}

for (const token of [
  'ATHLYRAX_COACH_LINK_LIFECYCLE_V1',
  'ATHLYRAX_COACH_LINK_PARENT_CONTACTS_PRIVATE',
  'ATHLYRAX_COACH_LINK_DISCONNECT_COPY_BACK_FIRST',
  'requireCoachLinkDecisionRole',
  'Session Coordinator approval is required for swimmer membership decisions.',
  "app.post('/coach/swimmer-links/:requestId/accept', requireStrictAuth, requireCoachLinkDecisionRole",
  "app.post('/coach/swimmer-links/:requestId/reject', requireStrictAuth, requireCoachLinkDecisionRole",
  'Original swimmer tenant is missing or invalid. Disconnect was blocked to protect swimmer data.',
  'writeAtomicJsonFile(sourcePaths.dbPath, nextSourceDb);',
  'tenantId: sourceTenantId',
  "coachLinkStatus: 'disconnected'",
]) if (!source.includes(token)) throw new Error(`Coach-link lifecycle hardening missing: ${token}`);

const listStart = source.indexOf("app.get('/coach/swimmer-links'");
const acceptStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/accept'", listStart);
if (listStart < 0 || acceptStart <= listStart) throw new Error('Coach-link list route bounds missing.');
const listSource = source.slice(listStart, acceptStart);
if (listSource.includes('parent1:') || listSource.includes('parent2:')) {
  throw new Error('Parent notification contacts must not be exposed by coach-link list API.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('COACH_LINK_LIFECYCLE_PATCH_OK');
