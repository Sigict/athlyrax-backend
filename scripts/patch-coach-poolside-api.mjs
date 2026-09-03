import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const indexPath = path.join(root, 'index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const projectionImport = "import { buildCoachPoolsideProjection } from './coach-poolside-projection.mjs';";
const mutationImport = "import { applyCoachPoolsideAttendance, applyCoachPoolsideSetChange, applyCoachPoolsideExecution } from './coach-poolside-mutations.mjs';";
const importAnchor = "import Stripe from 'stripe';";
if (!source.includes(projectionImport)) {
  if (!source.includes(importAnchor)) throw new Error('Coach Poolside import anchor is missing.');
  source = source.replace(importAnchor, importAnchor + '\n' + projectionImport);
}
if (!source.includes(mutationImport)) {
  source = source.replace(projectionImport, projectionImport + '\n' + mutationImport);
}

const dbAnchor = '// Serve db.json at /db';
if (!source.includes(dbAnchor)) throw new Error('Coach Poolside route anchor is missing.');

const projectionMarker = '// ATHLYRAX_COACH_POOLSIDE_PROJECTION_V1';
if (!source.includes(projectionMarker)) {
  const projectionRoute = String.raw`// ATHLYRAX_COACH_POOLSIDE_PROJECTION_V1
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
  source = source.replace(dbAnchor, projectionRoute + dbAnchor);
}

const mutationMarker = '// ATHLYRAX_COACH_POOLSIDE_MUTATIONS_V1';
if (!source.includes(mutationMarker)) {
  const mutationRoutes = String.raw`// ATHLYRAX_COACH_POOLSIDE_MUTATIONS_V1
async function applyCoachPoolsideMutation(req, res, mutator) {
\tconst tenantScope = resolveStoragePathsForRequest(req);
\tif (!tenantScope?.ok || !tenantScope?.storagePaths?.dbPath) {
\t\tres.status(Number(tenantScope?.status || tenantScope?.errorStatus || 403)).json(tenantScope?.body || { error: 'Tenant scope denied.' });
\t\treturn;
\t}
\ttry {
\t\tlet output = null;
\t\tawait enqueueWrite(async () => {
\t\t\tconst currentDb = readJsonFile(tenantScope.storagePaths.dbPath);
\t\t\tif (!currentDb || typeof currentDb !== 'object' || Array.isArray(currentDb)) throw new Error('Coach Poolside database is unavailable.');
\t\t\toutput = mutator(currentDb);
\t\t\tif (!output?.ok) return;
\t\t\twriteAtomicJsonFile(tenantScope.storagePaths.dbPath, output.db);
\t\t});
\t\tif (!output?.ok) {
\t\t\tres.status(Number(output?.status || 400)).json({ error: String(output?.error || 'Poolside change was rejected.') });
\t\t\treturn;
\t\t}
\t\tres.status(200).json({ ok: true, rows: output.rows, set: output.set, execution: output.execution });
\t} catch {
\t\tres.status(503).json({ error: 'Poolside change could not be saved.' });
\t}
}

app.post('/coach/poolside/sessions/:sessionId/attendance', requireStrictAuth, requireWriteRole, requireBillingWriteAccess, async (req, res) => {
\tawait applyCoachPoolsideMutation(req, res, (db) => applyCoachPoolsideAttendance(db, {
\t\tsessionId: req.params?.sessionId,
\t\tscheduleId: req.body?.scheduleId,
\t\trows: req.body?.rows,
\t\tupdatedBy: req.auth?.username,
\t}));
});

app.post('/coach/poolside/sessions/:sessionId/sets/:setId/executions', requireStrictAuth, requireWriteRole, requireBillingWriteAccess, async (req, res) => {
\tawait applyCoachPoolsideMutation(req, res, (db) => applyCoachPoolsideExecution(db, {
\t\tsessionId: req.params?.sessionId,
\t\tsetId: req.params?.setId,
\t\tswimmerId: req.body?.swimmerId,
\t\texecution: req.body?.execution,
\t\tupdatedBy: req.auth?.username,
\t}));
});

app.post('/coach/poolside/sessions/:sessionId/sets/:setId', requireStrictAuth, requireWriteRole, requireBillingWriteAccess, async (req, res) => {
\tawait applyCoachPoolsideMutation(req, res, (db) => applyCoachPoolsideSetChange(db, {
\t\tsessionId: req.params?.sessionId,
\t\tsetId: req.params?.setId,
\t\treps: req.body?.reps,
\t\tsendoffSeconds: req.body?.sendoffSeconds,
\t\tupdatedBy: req.auth?.username,
\t}));
});

`;
  source = source.replace(dbAnchor, mutationRoutes + dbAnchor);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_COACH_POOLSIDE_PROJECTION_OK');
