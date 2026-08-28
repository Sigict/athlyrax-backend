import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const indexPath = path.join(root, 'index.js');
const projectionPath = path.join(root, 'athlete-home-projection.mjs');
const registryPath = path.join(root, 'athlete-tenant-registry.mjs');
const sessionWritePath = path.join(root, 'athlete-session-write.mjs');
const marker = 'ATHLYRAX_SCOPED_ATHLETE_HOME_API_V1';
const writeMarker = 'ATHLYRAX_SCOPED_ATHLETE_SESSION_WRITE_V1';

if (!fs.existsSync(indexPath)) throw new Error('index.js is missing.');
if (!fs.existsSync(projectionPath)) throw new Error('athlete-home-projection.mjs is missing.');
if (!fs.existsSync(registryPath)) throw new Error('athlete-tenant-registry.mjs is missing.');
if (!fs.existsSync(sessionWritePath)) throw new Error('athlete-session-write.mjs is missing.');

let source = fs.readFileSync(indexPath, 'utf8');
const projectionImport = "import { buildAthleteHomeProjection } from './athlete-home-projection.mjs';";
const registryImport = "import { activeAthleteTenantConnections, deactivateAthleteTenantConnection, mergeAthleteHomeProjections, upsertAthleteTenantConnection } from './athlete-tenant-registry.mjs';";
const sessionWriteImport = "import { appendAthleteSessionWrite, buildAthleteSessionWrite, selectAthleteSessionTarget } from './athlete-session-write.mjs';";
if (!source.includes(projectionImport)) {
  const importMarker = "import helmet from 'helmet';";
  if (!source.includes(importMarker)) throw new Error('Could not locate helmet import for athlete-home projection import.');
  source = source.replace(importMarker, `${importMarker}\n${projectionImport}`);
}
if (!source.includes(registryImport)) {
  if (!source.includes(projectionImport)) throw new Error('Athlete projection import missing before registry import.');
  source = source.replace(projectionImport, `${projectionImport}\n${registryImport}`);
}
if (!source.includes(sessionWriteImport)) {
  if (!source.includes(registryImport)) throw new Error('Athlete registry import missing before session-write import.');
  source = source.replace(registryImport, `${registryImport}\n${sessionWriteImport}`);
}

const dbMarker = '// Serve db.json at /db';
if (!source.includes(dbMarker)) throw new Error('Could not locate /db route marker for athlete-home insertion.');

const route = `// ${marker}\napp.get('/swimmer/athlete-home', requireStrictAuth, requireSwimmerRole, (req, res) => {\n\tconst storageResolution = resolveStoragePathsForRequest(req);\n\tif (storageResolution?.ok !== true || !storageResolution?.storagePaths) {\n\t\tres.status(Number(storageResolution?.errorStatus || 403)).json({ error: String(storageResolution?.error || 'Tenant scope denied.') });\n\t\treturn;\n\t}\n\tconst authUser = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};\n\tconst primaryTenantId = String(storageResolution?.tenantId || resolveAuthTenantId(req.auth) || '').trim();\n\tconst authorisedTenants = activeAthleteTenantConnections(authUser, primaryTenantId);\n\tif (!authorisedTenants.length) {\n\t\tres.status(503).json({ error: 'Athlete data scope is unavailable.' });\n\t\treturn;\n\t}\n\n\ttry {\n\t\tconst projections = [];\n\t\tfor (const connection of authorisedTenants) {\n\t\t\tconst paths = connection.tenantId === primaryTenantId\n\t\t\t\t? storageResolution.storagePaths\n\t\t\t\t: resolveStoragePathsForTenantKey(connection.tenantId);\n\t\t\tconst db = readJsonFile(paths.dbPath);\n\t\t\tif (!db || typeof db !== 'object' || Array.isArray(db)) {\n\t\t\t\tres.status(503).json({ error: 'Authorised athlete data is temporarily unavailable.' });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tconst hasExplicitContext = Boolean(connection.clubId || connection.clubName || connection.squadId || connection.squadName);\n\t\t\tconst projection = buildAthleteHomeProjection(db, authUser, hasExplicitContext\n\t\t\t\t? { tenantId: connection.tenantId, connection }\n\t\t\t\t: {});\n\t\t\tif (!projection) {\n\t\t\t\tres.status(409).json({ error: 'Authorised athlete identity could not be resolved consistently.' });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tprojections.push(projection);\n\t\t}\n\t\tconst projection = mergeAthleteHomeProjections(projections);\n\t\tif (!projection) {\n\t\t\tres.status(404).json({ error: 'Athlete profile not found.' });\n\t\t\treturn;\n\t\t}\n\t\tres.status(200).json({\n\t\t\tok: true,\n\t\t\tcsrfToken: String(req.auth?.csrf || ''),\n\t\t\tcsrfHeaderName: AUTH_CSRF_HEADER_NAME,\n\t\t\t...projection,\n\t\t});\n\t} catch (error) {\n\t\tappendAuthAuditEvent({\n\t\t\taction: 'athlete_home_scope_failed',\n\t\t\treq,\n\t\t\tstatus: 'blocked',\n\t\t\treason: 'authorised_tenant_projection_failed',\n\t\t\tdetails: { message: error instanceof Error ? error.message : 'Unknown error' },\n\t\t});\n\t\tres.status(409).json({ error: 'Athlete data could not be combined safely.' });\n\t}\n});\n\n// ${writeMarker}\napp.post('/swimmer/athlete-sessions', requireStrictAuth, requireSwimmerRole, async (req, res) => {\n\tconst storageResolution = resolveStoragePathsForRequest(req);\n\tif (storageResolution?.ok !== true || !storageResolution?.storagePaths) {\n\t\tres.status(Number(storageResolution?.errorStatus || 403)).json({ error: String(storageResolution?.error || 'Tenant scope denied.') });\n\t\treturn;\n\t}\n\tconst authUser = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};\n\tconst primaryTenantId = String(storageResolution?.tenantId || resolveAuthTenantId(req.auth) || '').trim();\n\tconst authorisedTenants = activeAthleteTenantConnections(authUser, primaryTenantId);\n\tconst input = req.body && typeof req.body === 'object' ? req.body : {};\n\tconst target = selectAthleteSessionTarget(authorisedTenants, { clubId: input.clubId, primaryTenantId });\n\tif (!target) {\n\t\tres.status(403).json({ error: 'Requested athlete training context is not authorised.' });\n\t\treturn;\n\t}\n\n\ttry {\n\t\tconst paths = target.tenantId === primaryTenantId\n\t\t\t? storageResolution.storagePaths\n\t\t\t: resolveStoragePathsForTenantKey(target.tenantId);\n\t\tconst db = readJsonFile(paths.dbPath);\n\t\tif (!db || typeof db !== 'object' || Array.isArray(db)) {\n\t\t\tres.status(503).json({ error: 'Authorised athlete data is temporarily unavailable.' });\n\t\t\treturn;\n\t\t}\n\t\tconst projection = buildAthleteHomeProjection(db, authUser, { tenantId: target.tenantId, connection: target });\n\t\tif (!projection?.athlete?.id) {\n\t\t\tres.status(409).json({ error: 'Authenticated athlete identity could not be resolved in the requested context.' });\n\t\t\treturn;\n\t\t}\n\t\tconst sessionId = \`athlete-session:\${crypto.randomUUID()}\`;\n\t\tconst write = buildAthleteSessionWrite({\n\t\t\tathlete: projection.athlete,\n\t\t\tauthUser,\n\t\t\ttarget,\n\t\t\tprojection,\n\t\t\tinput,\n\t\t\tsessionId,\n\t\t\tsetIdFactory: (index) => \`\${sessionId}:set:\${index + 1}\`,\n\t\t\tcreatedAt: new Date().toISOString(),\n\t\t});\n\t\tif (!write.ok) {\n\t\t\tres.status(Number(write.status || 400)).json({ error: String(write.error || 'Athlete session could not be created.') });\n\t\t\treturn;\n\t\t}\n\t\tconst nextDb = appendAthleteSessionWrite(db, write);\n\t\tawait enqueueWrite(async () => {\n\t\t\twriteDbSnapshotIfPossible(paths.dbPath, paths.snapshotDir);\n\t\t\twriteAtomicJsonFile(paths.dbPath, nextDb);\n\t\t});\n\t\tappendAuthAuditEvent({\n\t\t\taction: 'athlete_session_created',\n\t\t\treq,\n\t\t\tstatus: write.approvalRequired ? 'pending_approval' : 'created',\n\t\t\treason: write.policy,\n\t\t\tdetails: { sessionId: write.session.id, tenantId: target.tenantId, clubId: write.session.ownerClubId },\n\t\t});\n\t\tres.status(201).json({\n\t\t\tok: true,\n\t\t\tapprovalRequired: write.approvalRequired,\n\t\t\tpolicy: write.policy,\n\t\t\tsession: { ...write.session, sets: write.sets },\n\t\t});\n\t} catch (error) {\n\t\tappendAuthAuditEvent({\n\t\t\taction: 'athlete_session_create_failed',\n\t\t\treq,\n\t\t\tstatus: 'blocked',\n\t\t\treason: 'athlete_session_write_failed',\n\t\t\tdetails: { message: error instanceof Error ? error.message : 'Unknown error' },\n\t\t});\n\t\tres.status(409).json({ error: 'Athlete session could not be created safely.' });\n\t}\n});\n\n`;

const existingRouteStart = source.indexOf("app.get('/swimmer/athlete-home'");
if (existingRouteStart >= 0) {
  let replacementStart = existingRouteStart;
  const markerStart = source.lastIndexOf(`// ${marker}`, existingRouteStart);
  if (markerStart >= 0 && existingRouteStart - markerStart < 100) replacementStart = markerStart;
  const dbMarkerIndex = source.indexOf(dbMarker, existingRouteStart);
  if (dbMarkerIndex < 0) throw new Error('Existing athlete-home route has no following /db marker.');
  source = source.slice(0, replacementStart) + route + source.slice(dbMarkerIndex);
} else {
  source = source.replace(dbMarker, `${route}${dbMarker}`);
}

for (const required of [
  projectionImport,
  registryImport,
  sessionWriteImport,
  marker,
  writeMarker,
  "app.get('/swimmer/athlete-home', requireStrictAuth, requireSwimmerRole",
  "app.post('/swimmer/athlete-sessions', requireStrictAuth, requireSwimmerRole, async",
  'csrfToken: String(req.auth?.csrf || \'\')',
  'csrfHeaderName: AUTH_CSRF_HEADER_NAME',
  'const storageResolution = resolveStoragePathsForRequest(req);',
  'storageResolution.storagePaths',
  'activeAthleteTenantConnections(authUser, primaryTenantId)',
  'selectAthleteSessionTarget(authorisedTenants',
  'buildAthleteSessionWrite({',
  'appendAthleteSessionWrite(db, write)',
  'await enqueueWrite(async () => {',
  'writeDbSnapshotIfPossible(paths.dbPath, paths.snapshotDir)',
  'writeAtomicJsonFile(paths.dbPath, nextDb)',
  'resolveStoragePathsForTenantKey(connection.tenantId)',
  'buildAthleteHomeProjection(db, authUser, hasExplicitContext',
  'mergeAthleteHomeProjections(projections)',
]) {
  if (!source.includes(required)) throw new Error(`Athlete-home production transform missing required token: ${required}`);
}
if (source.includes("fs.readFile(paths.dbPath, 'utf8'")) {
  throw new Error('Legacy asynchronous athlete-home database read remains.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_SCOPED_ATHLETE_HOME_API_OK');
console.log('ATHLYRAX_SCOPED_ATHLETE_SESSION_WRITE_OK');
