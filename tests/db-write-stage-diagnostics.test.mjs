import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(process.cwd());
const patchSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'patch-db-write-stage-diagnostics.mjs'), 'utf8');

const fixture = `const IS_PRODUCTION = true;\nfunction enqueueWrite(fn) { return Promise.resolve().then(fn); }\nfunction ensureStorageLayout() {}\nfunction writeDbSnapshotIfPossible() {}\nfunction readJsonFile() { return {}; }\nfunction getDbShapeUpdatedAtMs() { return 0; }\nfunction collectTimetableLegacyLockViolations() { return []; }\nfunction mergePlannerTargets(body) { return { nextWeeks: [], recoveredTargets: 0, recoveredFixtureIds: 0 }; }\nfunction mergeTombstoneLists() { return []; }\nfunction buildTombstoneLookup() { return new Map(); }\nfunction mergeScheduleOccurrenceSuppressionLists() { return []; }\nfunction applyTombstonesToDbShape(body) { return { dbShape: body, blockedResurrections: [] }; }\nfunction applyScheduleOccurrenceSuppressionsToDbShape(body) { return { dbShape: body, blockedResurrections: [] }; }\nfunction applyOwnershipMetadataToDbShape(body) { return body; }\nfunction writeAtomicJsonFile() {}\nfunction extractPlannerTargetRows() { return []; }\nconst app = { put() {} };\nconst requireAuth = null; const requireWriteRole = null; const requireBillingWriteAccess = null;\napp.put('/db', requireAuth, requireWriteRole, requireBillingWriteAccess, (req, res) => {\n\tconst tenantScope = { ok: true, tenantId: 'demo-company', storagePaths: { dbPath: 'db.json', snapshotDir: 'snapshots', backupPath: 'backup.json' } };\n\tconst body = {};\n\tconst storagePaths = tenantScope.storagePaths;\n\tenqueueWrite(async () => {\n\t\tensureStorageLayout(storagePaths);\n\t\twriteDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir);\n\n\t\tconst currentDb = readJsonFile(storagePaths.dbPath);\n\t\tconst currentUpdatedAtMs = getDbShapeUpdatedAtMs(currentDb);\n\t\tconst incomingUpdatedAtMs = getDbShapeUpdatedAtMs(body);\n\t\tconst isStaleWrite = Number.isFinite(currentUpdatedAtMs) && Number.isFinite(incomingUpdatedAtMs) && incomingUpdatedAtMs + 1000 < currentUpdatedAtMs;\n\t\tif (isStaleWrite) return { staleWriteIgnored: true, recoveredTargets: 0, recoveredFixtureIds: 0 };\n\t\tconst backupPayload = readJsonFile(storagePaths.backupPath);\n\t\tconst backupRows = Array.isArray(backupPayload?.rows) ? backupPayload.rows : [];\n\t\tconst timetableLegacyLockViolations = collectTimetableLegacyLockViolations(currentDb, body);\n\t\tif (timetableLegacyLockViolations.length > 0) throw new Error('locked');\n\t\tconst merged = mergePlannerTargets(body, backupRows);\n\t\tconst mergedTombstones = mergeTombstoneLists([], []);\n\t\tconst tombstoneLookup = buildTombstoneLookup(mergedTombstones);\n\t\tconst mergedScheduleOccurrenceSuppressions = mergeScheduleOccurrenceSuppressionLists([], []);\n\t\tconst filtered = applyTombstonesToDbShape({ ...body, trainingPlannerWeeks: merged.nextWeeks }, tombstoneLookup);\n\t\tconst occurrenceFiltered = applyScheduleOccurrenceSuppressionsToDbShape(filtered.dbShape, mergedScheduleOccurrenceSuppressions);\n\t\tconst safeBody = { ...occurrenceFiltered.dbShape, __tombstones: mergedTombstones, __meta: { ...(occurrenceFiltered.dbShape?.__meta || {}), scheduleOccurrenceSuppressions: mergedScheduleOccurrenceSuppressions } };\n\t\tconst ownershipStampedBody = applyOwnershipMetadataToDbShape(safeBody, currentDb, req.auth);\n\n\t\twriteAtomicJsonFile(storagePaths.dbPath, ownershipStampedBody);\n\n\t\tconst nextBackup = { savedAt: new Date().toISOString(), rows: extractPlannerTargetRows(ownershipStampedBody) };\n\t\twriteAtomicJsonFile(storagePaths.backupPath, nextBackup);\n\t\treturn { recoveredTargets: 0, recoveredFixtureIds: 0, staleWriteIgnored: false, blockedResurrections: [], tombstoneCount: 0 };\n\t})\n\t\t.then(() => res.status(200).json({ ok: true }))\n\t\t.catch((error) => {\n\t\t\tif (error && error.status === 400 && error.body) { res.status(400).json(error.body); return; }\n\t\t\tres.status(500).json({\n\t\t\t\terror: 'Could not write db.json',\n\t\t\t\t...(IS_PRODUCTION ? {} : { details: error instanceof Error ? error.message : 'Unknown error' }),\n\t\t\t});\n\t\t});\n});\n\nconst server = app.listen(PORT, () => {\n});\n`;

test('production transform exposes only bounded DB write stage/code diagnostics', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-db-write-diag-'));
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'index.js'), fixture, 'utf8');
  fs.writeFileSync(path.join(tmp, 'scripts', 'patch-db-write-stage-diagnostics.mjs'), patchSource, 'utf8');

  const first = spawnSync(process.execPath, ['scripts/patch-db-write-stage-diagnostics.mjs'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const transformed = fs.readFileSync(path.join(tmp, 'index.js'), 'utf8');
  assert.match(transformed, /ATHLYRAX_DB_WRITE_STAGE_DIAGNOSTICS_V1/);
  assert.match(transformed, /'prewrite_snapshot'/);
  assert.match(transformed, /'primary_db_write'/);
  assert.match(transformed, /'planner_backup_write'/);
  assert.match(transformed, /failureStage,/);
  assert.match(transformed, /failureCode,/);
  assert.match(transformed, /ENOSPC/);
  assert.match(transformed, /EACCES/);
  assert.doesNotMatch(transformed, /failurePath/);
  assert.doesNotMatch(transformed, /errorPath/);

  const second = spawnSync(process.execPath, ['scripts/patch-db-write-stage-diagnostics.mjs'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(fs.readFileSync(path.join(tmp, 'index.js'), 'utf8'), transformed, 'diagnostic transform must be idempotent');
});
