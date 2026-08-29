import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const indexPath = path.join(root, 'index.js');
const helperPath = path.join(root, 'athlete-wearable-sync.mjs');
const marker = 'ATHLYRAX_ATHLETE_WEARABLE_GATEWAY_V1';
const importLine = "import { beginWearableDelivery, buildCanonicalWearableWorkout, finishWearableDelivery, mergeWearableExecutionIntoDb } from './athlete-wearable-sync.mjs';";

if (!fs.existsSync(indexPath)) throw new Error('index.js is missing.');
if (!fs.existsSync(helperPath)) throw new Error('athlete-wearable-sync.mjs is missing.');

let source = fs.readFileSync(indexPath, 'utf8');
const sessionWriteImport = "import { appendAthleteSessionWrite, buildAthleteSessionWrite, selectAthleteSessionTarget } from './athlete-session-write.mjs';";
if (!source.includes(importLine)) {
  if (!source.includes(sessionWriteImport)) throw new Error('Athlete session authority import is missing.');
  source = source.replace(sessionWriteImport, `${sessionWriteImport}\n${importLine}`);
}

const dbMarker = '// Serve db.json at /db';
if (!source.includes(dbMarker)) throw new Error('Could not locate /db marker for wearable route.');

if (!source.includes(marker)) {
  const route = `// ${marker}\napp.post('/swimmer/athlete-sessions/:sessionId/wearable-sync', requireStrictAuth, requireSwimmerRole, async (req, res) => {\n\tconst providerUrl = String(process.env.ATHLYRAX_WEARABLE_PROVIDER_URL || '').trim();\n\tif (!providerUrl) {\n\t\tres.status(503).json({ error: 'Wearable provider is not configured.' });\n\t\treturn;\n\t}\n\tconst storageResolution = resolveStoragePathsForRequest(req);\n\tif (storageResolution?.ok !== true || !storageResolution?.storagePaths) {\n\t\tres.status(Number(storageResolution?.errorStatus || 403)).json({ error: String(storageResolution?.error || 'Tenant scope denied.') });\n\t\treturn;\n\t}\n\tconst authUser = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};\n\tconst primaryTenantId = String(storageResolution?.tenantId || resolveAuthTenantId(req.auth) || '').trim();\n\tconst authorisedTenants = activeAthleteTenantConnections(authUser, primaryTenantId);\n\tconst input = req.body && typeof req.body === 'object' ? req.body : {};\n\tconst target = selectAthleteSessionTarget(authorisedTenants, { clubId: input.clubId, primaryTenantId });\n\tif (!target) {\n\t\tres.status(403).json({ error: 'Requested wearable training context is not authorised.' });\n\t\treturn;\n\t}\n\tconst paths = target.tenantId === primaryTenantId\n\t\t? storageResolution.storagePaths\n\t\t: resolveStoragePathsForTenantKey(target.tenantId);\n\tconst sessionId = String(req.params?.sessionId || '').trim();\n\tconst providerId = String(input.providerId || 'configured-provider').trim().toLowerCase();\n\tconst initialDb = readJsonFile(paths.dbPath);\n\tif (!initialDb || typeof initialDb !== 'object' || Array.isArray(initialDb)) {\n\t\tres.status(503).json({ error: 'Authorised athlete data is temporarily unavailable.' });\n\t\treturn;\n\t}\n\tconst projection = buildAthleteHomeProjection(initialDb, authUser, { tenantId: target.tenantId, connection: target });\n\tif (!projection?.sessions?.some((row) => String(row?.id || '') === sessionId)) {\n\t\tres.status(404).json({ error: 'Canonical athlete session is not available in this authorised context.' });\n\t\treturn;\n\t}\n\tconst workoutResult = buildCanonicalWearableWorkout(initialDb, sessionId);\n\tif (!workoutResult.ok) {\n\t\tres.status(Number(workoutResult.status || 400)).json({ error: String(workoutResult.error || 'Wearable workout could not be built.') });\n\t\treturn;\n\t}\n\n\tlet delivery = null;\n\tawait enqueueWrite(async () => {\n\t\tconst latestDb = readJsonFile(paths.dbPath);\n\t\tconst begun = beginWearableDelivery(latestDb, { providerId, sessionId, attemptedAt: new Date().toISOString() });\n\t\tif (!begun.ok) throw new Error(begun.error || 'Wearable delivery could not start.');\n\t\tdelivery = begun.delivery;\n\t\twriteDbSnapshotIfPossible(paths.dbPath, paths.snapshotDir);\n\t\twriteAtomicJsonFile(paths.dbPath, begun.db);\n\t});\n\n\tconst providerToken = String(process.env.ATHLYRAX_WEARABLE_PROVIDER_TOKEN || '').trim();\n\ttry {\n\t\tconst providerResponse = await fetch(providerUrl, {\n\t\t\tmethod: 'POST',\n\t\t\theaders: {\n\t\t\t\t'content-type': 'application/json',\n\t\t\t\t'accept': 'application/json',\n\t\t\t\t'idempotency-key': delivery.key,\n\t\t\t\t...(providerToken ? { authorization: \`Bearer \${providerToken}\` } : {}),\n\t\t\t},\n\t\t\tbody: JSON.stringify({ providerId, workout: workoutResult.workout }),\n\t\t});\n\t\tconst providerPayload = await providerResponse.json().catch(() => ({}));\n\t\tif (!providerResponse.ok || providerPayload?.ok === false) {\n\t\t\tthrow new Error(String(providerPayload?.error || \`Wearable provider returned \${providerResponse.status}.\`));\n\t\t}\n\n\t\tlet finalDelivery = null;\n\t\tawait enqueueWrite(async () => {\n\t\t\tlet latestDb = readJsonFile(paths.dbPath);\n\t\t\tconst finished = finishWearableDelivery(latestDb, {\n\t\t\t\tproviderId,\n\t\t\t\tsessionId,\n\t\t\t\tok: true,\n\t\t\t\texternalWorkoutId: providerPayload?.externalWorkoutId,\n\t\t\t\tfinishedAt: new Date().toISOString(),\n\t\t\t});\n\t\t\tif (!finished.ok) throw new Error(finished.error || 'Wearable delivery could not finish.');\n\t\t\tlatestDb = finished.db;\n\t\t\tif (providerPayload?.execution && typeof providerPayload.execution === 'object') {\n\t\t\t\tconst merged = mergeWearableExecutionIntoDb(latestDb, sessionId, { ...providerPayload.execution, sessionId });\n\t\t\t\tif (!merged.ok) throw new Error(merged.error || 'Wearable execution could not be merged.');\n\t\t\t\tlatestDb = merged.db;\n\t\t\t}\n\t\t\tfinalDelivery = finished.delivery;\n\t\t\twriteDbSnapshotIfPossible(paths.dbPath, paths.snapshotDir);\n\t\t\twriteAtomicJsonFile(paths.dbPath, latestDb);\n\t\t});\n\t\tres.status(200).json({ ok: true, delivery: finalDelivery, sessionId });\n\t} catch (error) {\n\t\tlet failedDelivery = null;\n\t\tawait enqueueWrite(async () => {\n\t\t\tconst latestDb = readJsonFile(paths.dbPath);\n\t\t\tconst failed = finishWearableDelivery(latestDb, {\n\t\t\t\tproviderId,\n\t\t\t\tsessionId,\n\t\t\t\tok: false,\n\t\t\t\terror: error instanceof Error ? error.message : 'Wearable provider request failed.',\n\t\t\t\tfinishedAt: new Date().toISOString(),\n\t\t\t});\n\t\t\tif (failed.ok) {\n\t\t\t\tfailedDelivery = failed.delivery;\n\t\t\t\twriteDbSnapshotIfPossible(paths.dbPath, paths.snapshotDir);\n\t\t\t\twriteAtomicJsonFile(paths.dbPath, failed.db);\n\t\t\t}\n\t\t});\n\t\tres.status(502).json({ error: 'Wearable sync failed.', retryable: true, delivery: failedDelivery });\n\t}\n});\n\n`;
  source = source.replace(dbMarker, `${route}${dbMarker}`);
}

for (const required of [
  importLine,
  marker,
  "app.post('/swimmer/athlete-sessions/:sessionId/wearable-sync', requireStrictAuth, requireSwimmerRole, async",
  'ATHLYRAX_WEARABLE_PROVIDER_URL',
  "'idempotency-key': delivery.key",
  'beginWearableDelivery(latestDb',
  'finishWearableDelivery(latestDb',
  'mergeWearableExecutionIntoDb(latestDb, sessionId',
]) {
  if (!source.includes(required)) throw new Error(`Athlete wearable production transform missing required token: ${required}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_ATHLETE_WEARABLE_GATEWAY_OK');
