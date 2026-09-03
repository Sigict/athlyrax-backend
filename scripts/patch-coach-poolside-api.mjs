import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const indexPath = path.join(root, 'index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
const importLine = "import { buildCoachPoolsideProjection } from './coach-poolside-projection.mjs';";
if (!source.includes(importLine)) {
  const anchor = "import Stripe from 'stripe';";
  if (!source.includes(anchor)) throw new Error('Coach Poolside import anchor is missing.');
  source = source.replace(anchor, anchor + '\n' + importLine);
}
const marker = '// ATHLYRAX_COACH_POOLSIDE_PROJECTION_V1';
if (!source.includes(marker)) {
  const anchor = '// Serve db.json at /db';
  if (!source.includes(anchor)) throw new Error('Coach Poolside route anchor is missing.');
  const route = `${marker}
app.get('/coach/poolside', requireStrictAuth, (req, res) => {
\tconst role = String(req.auth?.role || '').trim().toLowerCase();
\tif (!['software-owner', 'head-coach', 'assistant-coach', 'viewer'].includes(role)) {
\t\tres.status(403).json({ error: 'Coach account required.' });
\t\treturn;
\t}
\tconst tenantScope = resolveStoragePathsForRequest(req);
\tif (!tenantScope?.ok || !tenantScope?.storagePaths?.dbPath) {
\t\tres.status(Number(tenantScope?.status || tenantScope?.errorStatus || 403)).json(tenantScope?.body || { error: 'Tenant scope denied.' });
\t\treturn;
\t}
\tconst db = readJsonFile(tenantScope.storagePaths.dbPath);
\tif (!db || typeof db !== 'object' || Array.isArray(db)) {
\t\tres.status(503).json({ error: 'Coach Poolside data is temporarily unavailable.' });
\t\treturn;
\t}
\tres.status(200).json({ ok: true, csrfToken: String(req.auth?.csrf || ''), csrfHeaderName: AUTH_CSRF_HEADER_NAME, ...buildCoachPoolsideProjection(db, { date: req.query?.date }) });
});

`;
  source = source.replace(anchor, route + anchor);
}
const mutationImport = "import { applyCoachPoolsideAttendance, applyCoachPoolsideSetChange, applyCoachPoolsideExecution } from './coach-poolside-mutations.mjs';";
if (!source.includes(mutationImport)) {
  source = source.replace("import { buildCoachPoolsideProjection } from './coach-poolside-projection.mjs';", "import { buildCoachPoolsideProjection } from './coach-poolside-projection.mjs';\\n" + mutationImport);
}
const mutationMarker = "// ATHLYRAX_COACH_POOLSIDE_MUTATIONS_V1";
if (!source.includes(mutationMarker)) {
  const mutationAnchor = "// Serve db.json at /db";
  if (!source.includes(mutationAnchor)) throw new Error('Coach Poolside mutation route anchor is missing.');
  source = source.replace(mutationAnchor, "// ATHLYRAX_COACH_POOLSIDE_MUTATIONS_V1\nasync function applyCoachPoolsideMutation(req, res, mutator) {\n\tconst tenantScope = resolveStoragePathsForRequest(req);\n\tif (!tenantScope?.ok || !tenantScope?.storagePaths?.dbPath) {\n\t\tres.status(Number(tenantScope?.status || tenantScope?.errorStatus || 403)).json(tenantScope?.body || { error: 'Tenant scope denied.' });\n\t\treturn;\n\t}\n\ttry {\n\t\tlet output = null;\n\t\tawait enqueueWrite(async () => {\n\t\t\tconst currentDb = readJsonFile(tenantScope.storagePaths.dbPath);\n\t\t\tif (!currentDb || typeof currentDb !== 'object' || Array.isArray(currentDb)) throw new Error('Coach Poolside database is unavailable.');\n\t\t\toutput = mutator(currentDb);\n\t\t\tif (!output?.ok) return;\n\t\t\twriteAtomicJsonFile(tenantScope.storagePaths.dbPath, output.db);\n\t\t});\n\t\tif (!output?.ok) {\n\t\t\tres.status(Number(output?.status || 400)).json({ error: String(output?.error || 'Poolside change was rejected.') });\n\t\t\treturn;\n\t\t}\n\t\tres.status(200).json({ ok: true, rows: output.rows, set: output.set, execution: output.execution });\n\t} catch {\n\t\tres.status(503).json({ error: 'Poolside change could not be saved.' });\n\t}\n}\n\napp.post('/coach/poolside/sessions/:sessionId/attendance', requireStrictAuth, requireWriteRole, requireBillingWriteAccess, async (req, res) => {\n\tawait applyCoachPoolsideMutation(req, res, (db) => applyCoachPoolsideAttendance(db, {\n\t\tsessionId: req.params?.sessionId,\n\t\tscheduleId: req.body?.scheduleId,\n\t\trows: req.body?.rows,\n\t\tupdatedBy: req.auth?.username,\n\t}));\n});\n\napp.post('/coach/poolside/sessions/:sessionId/sets/:setId/executions', requireStrictAuth, requireWriteRole, requireBillingWriteAccess, async (req, res) => {
	await applyCoachPoolsideMutation(req, res, (db) => applyCoachPoolsideExecution(db, {
		sessionId: req.params?.sessionId,
		setId: req.params?.setId,
		swimmerId: req.body?.swimmerId,
		execution: req.body?.execution,
		updatedBy: req.auth?.username,
	}));
});

app.post('/coach/poolside/sessions/:sessionId/sets/:setId', requireStrictAuth, requireWriteRole, requireBillingWriteAccess, async (req, res) => {\n\tawait applyCoachPoolsideMutation(req, res, (db) => applyCoachPoolsideSetChange(db, {\n\t\tsessionId: req.params?.sessionId,\n\t\tsetId: req.params?.setId,\n\t\treps: req.body?.reps,\n\t\tsendoffSeconds: req.body?.sendoffSeconds,\n\t\tupdatedBy: req.auth?.username,\n\t}));\n});\n\n" + mutationAnchor);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_COACH_POOLSIDE_PROJECTION_OK');
