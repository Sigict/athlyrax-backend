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
	const role = String(req.auth?.role || '').trim().toLowerCase();
	if (!['software-owner', 'head-coach', 'assistant-coach', 'viewer'].includes(role)) {
		res.status(403).json({ error: 'Coach account required.' });
		return;
	}
	const tenantScope = resolveStoragePathsForRequest(req);
	if (!tenantScope?.ok || !tenantScope?.storagePaths?.dbPath) {
		res.status(Number(tenantScope?.status || tenantScope?.errorStatus || 403)).json(tenantScope?.body || { error: 'Tenant scope denied.' });
		return;
	}
	const db = readJsonFile(tenantScope.storagePaths.dbPath);
	if (!db || typeof db !== 'object' || Array.isArray(db)) {
		res.status(503).json({ error: 'Coach Poolside data is temporarily unavailable.' });
		return;
	}
	res.status(200).json({ ok: true, csrfToken: String(req.auth?.csrf || ''), csrfHeaderName: AUTH_CSRF_HEADER_NAME, ...buildCoachPoolsideProjection(db, { date: req.query?.date }) });
});

`;
  source = source.replace(dbAnchor, projectionRoute + dbAnchor);
}

const mutationMarker = '// ATHLYRAX_COACH_POOLSIDE_MUTATIONS_V1';
if (!source.includes(mutationMarker)) {
  const mutationRoutes = String.raw`// ATHLYRAX_COACH_POOLSIDE_MUTATIONS_V1
async function applyCoachPoolsideMutation(req, res, mutator) {
	const tenantScope = resolveStoragePathsForRequest(req);
	if (!tenantScope?.ok || !tenantScope?.storagePaths?.dbPath) {
		res.status(Number(tenantScope?.status || tenantScope?.errorStatus || 403)).json(tenantScope?.body || { error: 'Tenant scope denied.' });
		return;
	}
	try {
		let output = null;
		await enqueueWrite(async () => {
			const currentDb = readJsonFile(tenantScope.storagePaths.dbPath);
			if (!currentDb || typeof currentDb !== 'object' || Array.isArray(currentDb)) throw new Error('Coach Poolside database is unavailable.');
			output = mutator(currentDb);
			if (!output?.ok) return;
			writeAtomicJsonFile(tenantScope.storagePaths.dbPath, output.db);
		});
		if (!output?.ok) {
			res.status(Number(output?.status || 400)).json({ error: String(output?.error || 'Poolside change was rejected.') });
			return;
		}
		res.status(200).json({ ok: true, rows: output.rows, set: output.set, execution: output.execution });
	} catch {
		res.status(503).json({ error: 'Poolside change could not be saved.' });
	}
}

app.post('/coach/poolside/sessions/:sessionId/attendance', requireStrictAuth, requireWriteRole, requireBillingWriteAccess, async (req, res) => {
	await applyCoachPoolsideMutation(req, res, (db) => applyCoachPoolsideAttendance(db, {
		sessionId: req.params?.sessionId,
		scheduleId: req.body?.scheduleId,
		rows: req.body?.rows,
		updatedBy: req.auth?.username,
	}));
});

app.post('/coach/poolside/sessions/:sessionId/sets/:setId/executions', requireStrictAuth, requireWriteRole, requireBillingWriteAccess, async (req, res) => {
	await applyCoachPoolsideMutation(req, res, (db) => applyCoachPoolsideExecution(db, {
		sessionId: req.params?.sessionId,
		setId: req.params?.setId,
		swimmerId: req.body?.swimmerId,
		execution: req.body?.execution,
		updatedBy: req.auth?.username,
	}));
});

app.post('/coach/poolside/sessions/:sessionId/sets/:setId', requireStrictAuth, requireWriteRole, requireBillingWriteAccess, async (req, res) => {
	await applyCoachPoolsideMutation(req, res, (db) => applyCoachPoolsideSetChange(db, {
		sessionId: req.params?.sessionId,
		setId: req.params?.setId,
		reps: req.body?.reps,
		sendoffSeconds: req.body?.sendoffSeconds,
		updatedBy: req.auth?.username,
	}));
});

`;
  source = source.replace(dbAnchor, mutationRoutes + dbAnchor);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_COACH_POOLSIDE_PROJECTION_OK');
