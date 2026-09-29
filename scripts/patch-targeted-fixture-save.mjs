import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const indexPath = path.join(root, 'index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const mutationImport = "import { applyTargetedFixtureSave } from './targeted-fixture-save.mjs';";
const importAnchor = "import { applyCoachPoolsideAttendance, applyCoachPoolsideSetChange, applyCoachPoolsideExecution } from './coach-poolside-mutations.mjs';";
if (!source.includes(mutationImport)) {
  if (!source.includes(importAnchor)) throw new Error('Targeted fixture import anchor is missing.');
  source = source.replace(importAnchor, importAnchor + '\n' + mutationImport);
}

const routeAnchor = '// Serve db.json at /db';
if (!source.includes(routeAnchor)) throw new Error('Targeted fixture route anchor is missing.');

const marker = '// ATHLYRAX_TARGETED_FIXTURE_SAVE_V1';
if (!source.includes(marker)) {
  const route = String.raw`// ATHLYRAX_TARGETED_FIXTURE_SAVE_V1
app.post('/fixtures/:fixtureReference', requireStrictAuth, requireWriteRole, requireBillingWriteAccess, async (req, res) => {
	const tenantScope = resolveStoragePathsForRequest(req);
	if (!tenantScope?.ok || !tenantScope?.storagePaths?.dbPath) {
		res.status(Number(tenantScope?.status || tenantScope?.errorStatus || 403)).json(tenantScope?.body || { error: 'Tenant scope denied.' });
		return;
	}
	try {
		let output = null;
		await enqueueWrite(async () => {
			const currentDb = readJsonFile(tenantScope.storagePaths.dbPath);
			if (!currentDb || typeof currentDb !== 'object' || Array.isArray(currentDb)) throw new Error('Fixture database is unavailable.');
			output = applyTargetedFixtureSave(currentDb, {
				...req.body,
				fixtureReference: req.params?.fixtureReference,
				updatedBy: req.auth?.username,
			});
			if (!output?.ok) return;
			writeAtomicJsonFile(tenantScope.storagePaths.dbPath, output.db);
		});
		if (!output?.ok) {
			res.status(Number(output?.status || 400)).json({ error: String(output?.error || 'Fixture change was rejected.') });
			return;
		}
		res.status(200).json({ ok: true, fixture: output.fixture, venue: output.venue });
	} catch {
		res.status(503).json({ error: 'Fixture change could not be saved.' });
	}
});

`;
  source = source.replace(routeAnchor, route + routeAnchor);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_TARGETED_FIXTURE_SAVE_OK');
