import fs from 'node:fs';
import path from 'node:path';

// Adds the scoped Group Test Results save route used by the Coach Console
// (POST /coach/tests/group-results). The submission is validated and applied
// to the caller's own tenant database only; it is not an unrestricted DB write.
const root = path.resolve(process.cwd());
const indexPath = path.join(root, 'index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const mutationImport = "import { applyScopedGroupTestSubmission } from './group-test-results.mjs';";
if (!source.includes(mutationImport)) {
  const importAnchor = "import { applyTargetedFixtureSave } from './targeted-fixture-save.mjs';";
  if (!source.includes(importAnchor)) throw new Error('Group test results import anchor is missing (run after the targeted fixture save patch).');
  source = source.replace(importAnchor, importAnchor + '\n' + mutationImport);
}

const routeAnchor = '// Serve db.json at /db';
if (!source.includes(routeAnchor)) throw new Error('Group test results route anchor is missing.');

const marker = '// ATHLYRAX_GROUP_TEST_RESULTS_V1';
if (!source.includes(marker)) {
  const route = String.raw`// ATHLYRAX_GROUP_TEST_RESULTS_V1
app.post('/coach/tests/group-results', requireStrictAuth, requireWriteRole, requireBillingWriteAccess, async (req, res) => {
	const tenantScope = resolveStoragePathsForRequest(req);
	if (!tenantScope?.ok || !tenantScope?.storagePaths?.dbPath) {
		res.status(Number(tenantScope?.status || tenantScope?.errorStatus || 403)).json(tenantScope?.body || { error: 'Tenant scope denied.' });
		return;
	}
	try {
		let output = null;
		await enqueueWrite(async () => {
			const currentDb = readJsonFile(tenantScope.storagePaths.dbPath);
			if (!currentDb || typeof currentDb !== 'object' || Array.isArray(currentDb)) throw new Error('Test database is unavailable.');
			output = applyScopedGroupTestSubmission(currentDb, req.body || {});
			writeAtomicJsonFile(tenantScope.storagePaths.dbPath, output.db);
		});
		appendAuthAuditEvent({
			action: 'activity_group_test_results_saved', req, status: 'success',
			target: String(req.body?.linkedSetId || req.body?.templateId || ''),
			details: { count: output.changedCount, syncedCount: output.syncedCount, scoringEligibleCount: output.scoringEligibleCount },
		});
		res.status(200).json({ ok: true, changedCount: output.changedCount, syncedCount: output.syncedCount, scoringEligibleCount: output.scoringEligibleCount });
	} catch (error) {
		const status = Number(error?.status);
		if (status >= 400 && status < 500) {
			res.status(status).json({ error: String(error?.message || 'Group Test Results were rejected.') });
			return;
		}
		res.status(503).json({ error: 'Group Test Results could not be saved.' });
	}
});

`;
  source = source.replace(routeAnchor, route + routeAnchor);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_GROUP_TEST_RESULTS_OK');
