import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('ATHLYRAX_COACH_LINK_WORKFLOW_V1') || !source.includes('ATHLYRAX_COACH_LINK_LIFECYCLE_V1')) {
  throw new Error('Coach-link workflow and lifecycle patches must run before integrity hardening.');
}

const marker = '// ATHLYRAX_COACH_LINK_INTEGRITY_V1';
if (!source.includes(marker)) {
  const coachLookupOld = `\treturn authUsers.find((row) => {\n\t\tconst role = String(row?.role || '').trim().toLowerCase();\n\t\tif (role !== 'head-coach' && role !== 'assistant-coach') return false;\n\t\treturn String(row?.email || '').trim().toLowerCase() === target;\n\t}) || null;`;
  const coachLookupNew = `\treturn authUsers.find((row) => {\n\t\tconst role = String(row?.role || '').trim().toLowerCase();\n\t\tif (role !== 'head-coach' && role !== 'assistant-coach') return false;\n\t\tif (row?.isApproved === false) return false;\n\t\treturn String(row?.email || '').trim().toLowerCase() === target;\n\t}) || null;`;
  if (!source.includes(coachLookupNew)) {
    if (!source.includes(coachLookupOld)) throw new Error('Coach lookup hardening anchor not found.');
    source = source.replace(coachLookupOld, coachLookupNew);
  }

  source = source.replace(`\n\t\t\tparent1: String(sourceRows[swimmerIndex]?.parent1 || '').trim(),`, '');
  source = source.replace(`\n\t\t\tparent2: String(sourceRows[swimmerIndex]?.parent2 || '').trim(),`, '');

  const existingPendingBlock = `\t\tconst existingPending = requests.find((row) =>\n\t\t\tString(row?.swimmerUsername || '').trim().toLowerCase() === String(swimmerUser.username || '').trim().toLowerCase()\n\t\t\t&& String(row?.status || '').trim().toLowerCase() === 'pending'\n\t\t);\n\t\tif (existingPending) {\n\t\t\tres.status(200).json({ ok: true, request: existingPending, alreadyPending: true });\n\t\t\treturn;\n\t\t}`;
  const singlePendingBlock = `\t\tconst sourceSwimmerRow = sourceRows[swimmerIndex] && typeof sourceRows[swimmerIndex] === 'object' ? sourceRows[swimmerIndex] : {};\n\t\tconst sourcePendingRequestId = String(sourceSwimmerRow?.coachLinkRequestId || '').trim();\n\t\tconst sourcePendingTarget = normalizeTenantId(sourceSwimmerRow?.coachTargetTenantId);\n\t\tconst sourceIsPending = String(sourceSwimmerRow?.coachLinkStatus || '').trim().toLowerCase() === 'pending';\n\t\tif (sourceIsPending) {\n\t\t\tconst matchingPending = requests.find((row) =>\n\t\t\t\tString(row?.id || '').trim() === sourcePendingRequestId\n\t\t\t\t&& String(row?.status || '').trim().toLowerCase() === 'pending'\n\t\t\t\t&& normalizeTenantId(row?.targetTenantId) === targetTenantId\n\t\t\t);\n\t\t\tif (matchingPending && sourcePendingTarget === targetTenantId) {\n\t\t\t\tres.status(200).json({ ok: true, request: matchingPending, alreadyPending: true });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tres.status(409).json({ error: 'A different coach connection request is already pending. Cancel it before creating another.' });\n\t\t\treturn;\n\t\t}\n\t\tconst existingPending = requests.find((row) =>\n\t\t\tString(row?.swimmerUsername || '').trim().toLowerCase() === String(swimmerUser.username || '').trim().toLowerCase()\n\t\t\t&& String(row?.status || '').trim().toLowerCase() === 'pending'\n\t\t);\n\t\tif (existingPending) {\n\t\t\tres.status(409).json({ error: 'Coach tenant contains an orphan pending request for this swimmer. It must be resolved before a new request is created.' });\n\t\t\treturn;\n\t\t}`;
  if (!source.includes(singlePendingBlock)) {
    if (!source.includes(existingPendingBlock)) throw new Error('Single-pending request anchor not found.');
    source = source.replace(existingPendingBlock, singlePendingBlock);
  }

  source = source.replace(
    "app.post('/coach/swimmer-links/:requestId/accept', requireStrictAuth, requireCoachLinkDecisionRole, (req, res) => {",
    "app.post('/coach/swimmer-links/:requestId/accept', requireStrictAuth, requireCoachLinkDecisionRole, requireBillingWriteAccess, (req, res) => {",
  );

  const sourceIndexAnchor = `\t\tconst sourceIndex = findBoundSwimmerIndex(sourceRows, swimmerUsername);\n\t\tif (sourceIndex < 0) { res.status(409).json({ error: 'Source swimmer profile is missing. Nothing was moved.' }); return; }`;
  const sourceIntegrityBlock = `${sourceIndexAnchor}\n\t\tconst sourceSwimmerRow = sourceRows[sourceIndex] && typeof sourceRows[sourceIndex] === 'object' ? sourceRows[sourceIndex] : {};\n\t\tif (\n\t\t\tString(sourceSwimmerRow?.coachLinkStatus || '').trim().toLowerCase() !== 'pending'\n\t\t\t|| String(sourceSwimmerRow?.coachLinkRequestId || '').trim() !== requestId\n\t\t\t|| normalizeTenantId(sourceSwimmerRow?.coachTargetTenantId) !== actorTenantId\n\t\t) {\n\t\t\tres.status(409).json({ error: 'Connection request is stale or no longer matches the swimmer pending state.' });\n\t\t\treturn;\n\t\t}`;
  const acceptStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/accept'");
  const rejectStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/reject'", acceptStart);
  if (acceptStart < 0 || rejectStart < 0) throw new Error('Coach-link accept route bounds missing.');
  let acceptSource = source.slice(acceptStart, rejectStart);
  if (!acceptSource.includes('Connection request is stale or no longer matches the swimmer pending state.')) {
    if (!acceptSource.includes(sourceIndexAnchor)) throw new Error('Acceptance source integrity anchor not found.');
    acceptSource = acceptSource.replace(sourceIndexAnchor, sourceIntegrityBlock);
  }

  const targetIndexAnchor = `\t\tconst existingTargetIndex = findBoundSwimmerIndex(currentTargetRows, swimmerUsername);`;
  const capacityBlock = `${targetIndexAnchor}\n\t\tif (existingTargetIndex < 0) {\n\t\t\tconst { limits } = resolveTenantPlanLimits(actorTenantId);\n\t\t\tconst maxSwimmers = limits?.maxSwimmers;\n\t\t\tif (maxSwimmers !== null && maxSwimmers !== undefined) {\n\t\t\t\tconst activeSwimmerCount = currentTargetRows.filter((row) => row && typeof row === 'object' && row?.active !== false).length;\n\t\t\t\tif (activeSwimmerCount >= Number(maxSwimmers)) {\n\t\t\t\t\tres.status(409).json({ error: 'This subscription tier has reached its swimmer limit. Upgrade or free capacity before accepting another swimmer.' });\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t}\n\t\t}`;
  if (!acceptSource.includes('This subscription tier has reached its swimmer limit.')) {
    if (!acceptSource.includes(targetIndexAnchor)) throw new Error('Acceptance capacity anchor not found.');
    acceptSource = acceptSource.replace(targetIndexAnchor, capacityBlock);
  }
  source = source.slice(0, acceptStart) + acceptSource + source.slice(rejectStart);

  const rejectRouteStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/reject'");
  const disconnectStart = source.indexOf("app.post('/swimmer/coach/disconnect'", rejectRouteStart);
  if (rejectRouteStart < 0 || disconnectStart < 0) throw new Error('Coach-link reject route bounds missing.');
  let rejectSource = source.slice(rejectRouteStart, disconnectStart);
  const rejectWriteOld = `\t\tif (sourceIndex >= 0) {\n\t\t\tsourceRows[sourceIndex] = {\n\t\t\t\t...sourceRows[sourceIndex],\n\t\t\t\tcoachConnected: false, coachLinkStatus: 'none', coachEmail: '', coachCode: '', coachPhase: '',\n\t\t\t\tcoachRequestAt: '', coachReplyAt: '', coachApprovalAt: '', shareMode: 'Feedback link only',\n\t\t\t};\n\t\t\twriteAtomicJsonFile(sourcePaths.dbPath, { ...sourceDb, swimmers: sourceRows });\n\t\t}`;
  const rejectWriteNew = `\t\tif (sourceIndex >= 0) {\n\t\t\tconst currentSourceRow = sourceRows[sourceIndex] && typeof sourceRows[sourceIndex] === 'object' ? sourceRows[sourceIndex] : {};\n\t\t\tconst rejectionMatchesCurrent = String(currentSourceRow?.coachLinkRequestId || '').trim() === requestId\n\t\t\t\t&& normalizeTenantId(currentSourceRow?.coachTargetTenantId) === actorTenantId\n\t\t\t\t&& String(currentSourceRow?.coachLinkStatus || '').trim().toLowerCase() === 'pending';\n\t\t\tif (rejectionMatchesCurrent) {\n\t\t\t\tsourceRows[sourceIndex] = {\n\t\t\t\t\t...currentSourceRow,\n\t\t\t\t\tcoachConnected: false, coachLinkStatus: 'none', coachEmail: '', coachCode: '', coachPhase: '',\n\t\t\t\t\tcoachRequestAt: '', coachReplyAt: '', coachApprovalAt: '', coachLinkRequestId: '', coachTargetTenantId: '', shareMode: 'Feedback link only',\n\t\t\t\t};\n\t\t\t\twriteAtomicJsonFile(sourcePaths.dbPath, { ...sourceDb, swimmers: sourceRows });\n\t\t\t}\n\t\t}`;
  if (!rejectSource.includes('rejectionMatchesCurrent')) {
    if (!rejectSource.includes(rejectWriteOld)) throw new Error('Stale rejection protection anchor not found.');
    rejectSource = rejectSource.replace(rejectWriteOld, rejectWriteNew);
  }
  source = source.slice(0, rejectRouteStart) + rejectSource + source.slice(disconnectStart);

  const pendingDisconnectOld = `\t\tif (!wasApproved) {\n\t\t\tconst nextRows = currentRows.slice();`;
  const pendingDisconnectNew = `\t\tif (!wasApproved) {\n\t\t\tconst pendingRequestId = String(currentRow?.coachLinkRequestId || '').trim();\n\t\t\tconst pendingTargetTenantId = normalizeTenantId(currentRow?.coachTargetTenantId);\n\t\t\tlet pendingTargetRollback = null;\n\t\t\tlet pendingTargetPaths = null;\n\t\t\tif (String(currentRow?.coachLinkStatus || '').trim().toLowerCase() === 'pending' && pendingRequestId && pendingTargetTenantId) {\n\t\t\t\tpendingTargetPaths = resolveStoragePathsForTenantKey(pendingTargetTenantId);\n\t\t\t\tconst pendingTargetDb = readCoachLinkDbStrict(pendingTargetPaths, 'Pending coach target');\n\t\t\t\tconst pendingRequests = Array.isArray(pendingTargetDb?.coachLinkRequests) ? pendingTargetDb.coachLinkRequests.slice() : [];\n\t\t\t\tconst pendingIndex = pendingRequests.findIndex((row) => String(row?.id || '').trim() === pendingRequestId);\n\t\t\t\tif (pendingIndex < 0 || String(pendingRequests[pendingIndex]?.status || '').trim().toLowerCase() !== 'pending') {\n\t\t\t\t\tres.status(409).json({ error: 'Pending coach request could not be verified. Disconnect was blocked to avoid leaving inconsistent membership state.' });\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tpendingTargetRollback = pendingTargetDb;\n\t\t\t\tpendingRequests[pendingIndex] = { ...pendingRequests[pendingIndex], status: 'cancelled', decidedAt: disconnectedAt, decidedBy: authUsername };\n\t\t\t\twriteAtomicJsonFile(pendingTargetPaths.dbPath, { ...pendingTargetDb, coachLinkRequests: pendingRequests });\n\t\t\t}\n\t\t\tconst nextRows = currentRows.slice();`;
  if (!source.includes('Pending coach request could not be verified.')) {
    if (!source.includes(pendingDisconnectOld)) throw new Error('Pending disconnect cancellation anchor not found.');
    source = source.replace(pendingDisconnectOld, pendingDisconnectNew);
  }
  const pendingSourceWriteOld = `\t\t\twriteDbSnapshotIfPossible(currentPaths.dbPath, currentPaths.snapshotDir);\n\t\t\twriteAtomicJsonFile(currentPaths.dbPath, { ...currentDb, swimmers: nextRows });\n\t\t\tres.status(200).json({ ok: true, swimmerId: String(nextRows[currentIndex]?.id || ''), disconnectedAt, tenantId: currentTenantId });`;
  const pendingSourceWriteNew = `\t\t\twriteDbSnapshotIfPossible(currentPaths.dbPath, currentPaths.snapshotDir);\n\t\t\ttry {\n\t\t\t\twriteAtomicJsonFile(currentPaths.dbPath, { ...currentDb, swimmers: nextRows });\n\t\t\t} catch (error) {\n\t\t\t\tif (pendingTargetRollback && pendingTargetPaths) writeAtomicJsonFile(pendingTargetPaths.dbPath, pendingTargetRollback);\n\t\t\t\tthrow error;\n\t\t\t}\n\t\t\tres.status(200).json({ ok: true, swimmerId: String(nextRows[currentIndex]?.id || ''), disconnectedAt, tenantId: currentTenantId });`;
  if (!source.includes('pendingTargetRollback && pendingTargetPaths')) {
    if (!source.includes(pendingSourceWriteOld)) throw new Error('Pending disconnect rollback anchor not found.');
    source = source.replace(pendingSourceWriteOld, pendingSourceWriteNew);
  }

  const getSendOld = `\t\t\tres.setHeader('Content-Type', 'application/json');\n\t\t\tres.send(responsePayload);`;
  const getSendNew = `\t\t\t// ATHLYRAX_COACH_LINK_REQUESTS_HIDDEN_FROM_GENERIC_DB\n\t\t\ttry {\n\t\t\t\tconst responseShape = JSON.parse(String(responsePayload || '{}'));\n\t\t\t\tif (responseShape && typeof responseShape === 'object' && !Array.isArray(responseShape)) delete responseShape.coachLinkRequests;\n\t\t\t\tresponsePayload = JSON.stringify(responseShape);\n\t\t\t} catch {\n\t\t\t\tres.status(500).json({ error: 'Could not safely scope db.json response.' });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tres.setHeader('Content-Type', 'application/json');\n\t\t\tres.send(responsePayload);`;
  if (!source.includes('ATHLYRAX_COACH_LINK_REQUESTS_HIDDEN_FROM_GENERIC_DB')) {
    if (!source.includes(getSendOld)) throw new Error('Generic DB GET response anchor not found.');
    source = source.replace(getSendOld, getSendNew);
  }

  const putSafeBodyOld = `\t\tconst safeBody = {\n\t\t\t...filtered.dbShape,\n\t\t\t__tombstones: mergedTombstones,\n\t\t};`;
  const putSafeBodyNew = `\t\t// ATHLYRAX_COACH_LINK_REQUESTS_PRESERVED_ON_GENERIC_DB_WRITE\n\t\tconst safeBody = {\n\t\t\t...filtered.dbShape,\n\t\t\t__tombstones: mergedTombstones,\n\t\t\tcoachLinkRequests: Array.isArray(currentDb?.coachLinkRequests) ? currentDb.coachLinkRequests : [],\n\t\t};`;
  if (!source.includes('ATHLYRAX_COACH_LINK_REQUESTS_PRESERVED_ON_GENERIC_DB_WRITE')) {
    if (!source.includes(putSafeBodyOld)) throw new Error('Generic DB PUT preservation anchor not found.');
    source = source.replace(putSafeBodyOld, putSafeBodyNew);
  }

  source = `${marker}\n// Dedicated coach-link routes are the sole lifecycle authority.\n${source}`;
}

for (const required of [
  'ATHLYRAX_COACH_LINK_INTEGRITY_V1',
  'ATHLYRAX_COACH_LINK_REQUESTS_HIDDEN_FROM_GENERIC_DB',
  'ATHLYRAX_COACH_LINK_REQUESTS_PRESERVED_ON_GENERIC_DB_WRITE',
  "if (row?.isApproved === false) return false;",
  'A different coach connection request is already pending.',
  'Connection request is stale or no longer matches the swimmer pending state.',
  'This subscription tier has reached its swimmer limit.',
  'rejectionMatchesCurrent',
  "status: 'cancelled'",
  'Pending coach request could not be verified.',
  'requireBillingWriteAccess',
]) if (!source.includes(required)) throw new Error(`Coach-link integrity hardening missing: ${required}`);

for (const forbidden of [
  `parent1: String(sourceRows[swimmerIndex]?.parent1 || '').trim()`,
  `parent2: String(sourceRows[swimmerIndex]?.parent2 || '').trim()`,
]) if (source.includes(forbidden)) throw new Error(`Unnecessary parent contact persisted in coach-link request: ${forbidden}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('COACH_LINK_INTEGRITY_PATCH_OK');
