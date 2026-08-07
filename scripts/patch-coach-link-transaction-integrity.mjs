import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('ATHLYRAX_COACH_LINK_RECONNECT_V1')) {
  throw new Error('Coach-link reconnect hardening must run before transactional lifecycle hardening.');
}

const marker = '// ATHLYRAX_COACH_LINK_TRANSACTIONAL_COMMIT_V1';
if (!source.includes(marker)) {
  // Acceptance: commit both database copies before auth routing. If either database
  // write fails, auth remains on the source tenant. If auth persistence fails,
  // restore both database copies before reporting failure.
  {
    const acceptStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/accept'");
    const rejectStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/reject'", acceptStart);
    if (acceptStart < 0 || rejectStart < 0) throw new Error('Coach-link accept route bounds missing for transaction hardening.');
    let route = source.slice(acceptStart, rejectStart);
    const blockStart = route.indexOf("\t\twriteDbSnapshotIfPossible(targetPaths.dbPath, targetPaths.snapshotDir);");
    const blockEnd = route.indexOf("\n\t\tappendAuthAuditEvent({ action: 'coach_swimmer_link_approved'", blockStart);
    if (blockStart < 0 || blockEnd < 0) throw new Error('Coach-link accept commit block anchors missing.');

    const transaction = `\t\t// ATHLYRAX_COACH_LINK_ACCEPT_DB_FIRST_AUTH_LAST\n\t\twriteDbSnapshotIfPossible(targetPaths.dbPath, targetPaths.snapshotDir);\n\t\twriteAtomicJsonFile(targetPaths.dbPath, nextTargetDb);\n\n\t\tconst nextSourceDb = { ...sourceDb, swimmers: sourceRows.slice() };\n\t\tnextSourceDb.swimmers[sourceIndex] = {\n\t\t\t...sourceRows[sourceIndex],\n\t\t\tcoachConnected: true, coachLinkStatus: 'approved', coachApprovalAt: approvedAt,\n\t\t\tcoachLinkRequestId: requestId, coachTargetTenantId: actorTenantId,\n\t\t\tcoachLinkMigratedAt: approvedAt, coachLinkMigratedToTenantId: actorTenantId,\n\t\t};\n\t\ttry {\n\t\t\twriteDbSnapshotIfPossible(sourcePaths.dbPath, sourcePaths.snapshotDir);\n\t\t\twriteAtomicJsonFile(sourcePaths.dbPath, nextSourceDb);\n\t\t} catch (sourceError) {\n\t\t\ttry {\n\t\t\t\twriteAtomicJsonFile(targetPaths.dbPath, targetDb);\n\t\t\t} catch (rollbackError) {\n\t\t\t\tthrow new Error(\`Coach-link acceptance source write failed and target rollback failed: \${rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'}. Original error: \${sourceError instanceof Error ? sourceError.message : 'unknown source write error'}\`);\n\t\t\t}\n\t\t\tthrow sourceError;\n\t\t}\n\n\t\tconst previousAuthUser = authUsers[swimmerUserIndex];\n\t\tauthUsers[swimmerUserIndex] = { ...previousAuthUser, tenantId: actorTenantId };\n\t\ttry {\n\t\t\tpersistAuthUsers();\n\t\t} catch (error) {\n\t\t\tauthUsers[swimmerUserIndex] = previousAuthUser;\n\t\t\tconst rollbackErrors = [];\n\t\t\ttry { writeAtomicJsonFile(sourcePaths.dbPath, sourceDb); } catch (rollbackError) { rollbackErrors.push(\`source: \${rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'}\`); }\n\t\t\ttry { writeAtomicJsonFile(targetPaths.dbPath, targetDb); } catch (rollbackError) { rollbackErrors.push(\`target: \${rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'}\`); }\n\t\t\tif (rollbackErrors.length > 0) {\n\t\t\t\tthrow new Error(\`Coach-link acceptance auth persistence failed and database rollback was incomplete (\${rollbackErrors.join('; ')}). Original error: \${error instanceof Error ? error.message : 'unknown auth persistence error'}\`);\n\t\t\t}\n\t\t\tthrow error;\n\t\t}`;

    route = route.slice(0, blockStart) + transaction + route.slice(blockEnd);
    source = source.slice(0, acceptStart) + route + source.slice(rejectStart);
  }

  // Rejection: if the current swimmer-side pending state matches this request, its
  // update is part of the same logical decision. A source-side write failure must
  // restore the target request to pending instead of reporting a false success.
  {
    const rejectStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/reject'");
    const disconnectStart = source.indexOf("app.post('/swimmer/coach/disconnect'", rejectStart);
    if (rejectStart < 0 || disconnectStart < 0) throw new Error('Coach-link reject route bounds missing for transaction hardening.');
    let route = source.slice(rejectStart, disconnectStart);
    const oldCatch = `\t\t} catch (sourceError) {\n\t\t\tappendAuthAuditEvent({ action: 'coach_link_rejection_source_update_failed', req, status: 'error', target: requestId, details: { message: sourceError instanceof Error ? sourceError.message : 'Unknown error' } });\n\t\t}`;
    const newCatch = `\t\t} catch (sourceError) {\n\t\t\t// ATHLYRAX_COACH_LINK_REJECT_ROLLBACK_TARGET\n\t\t\ttry {\n\t\t\t\twriteAtomicJsonFile(targetPaths.dbPath, targetDb);\n\t\t\t} catch (rollbackError) {\n\t\t\t\tthrow new Error(\`Coach-link rejection source update failed and target rollback failed: \${rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'}. Original error: \${sourceError instanceof Error ? sourceError.message : 'unknown source update error'}\`);\n\t\t\t}\n\t\t\tthrow sourceError;\n\t\t}`;
    if (!route.includes(oldCatch)) throw new Error('Coach-link rejection best-effort catch anchor missing.');
    route = route.replace(oldCatch, newCatch);
    source = source.slice(0, rejectStart) + route + source.slice(disconnectStart);
  }

  // Approved disconnect: restore the original copy and mark the coach copy inactive
  // before changing auth routing. Auth is the final commit point. If it fails, both
  // database copies are restored to their pre-disconnect state.
  {
    const disconnectStart = source.indexOf("app.post('/swimmer/coach/disconnect'");
    const dbStart = source.indexOf('// Serve db.json at /db', disconnectStart);
    if (disconnectStart < 0 || dbStart < 0) throw new Error('Coach-link disconnect route bounds missing for transaction hardening.');
    let route = source.slice(disconnectStart, dbStart);
    const blockStart = route.indexOf("\t\t// Copy the newest swimmer record back to the original tenant before changing auth routing.");
    const blockEnd = route.indexOf("\n\t\tappendAuthAuditEvent({\n\t\t\taction: 'swimmer_coach_disconnected'", blockStart);
    if (blockStart < 0 || blockEnd < 0) throw new Error('Coach-link approved disconnect commit block anchors missing.');

    const transaction = `\t\t// ATHLYRAX_COACH_LINK_DISCONNECT_DB_FIRST_AUTH_LAST\n\t\twriteDbSnapshotIfPossible(sourcePaths.dbPath, sourcePaths.snapshotDir);\n\t\twriteAtomicJsonFile(sourcePaths.dbPath, nextSourceDb);\n\n\t\tconst archiveRows = currentRows.slice();\n\t\tarchiveRows[currentIndex] = {\n\t\t\t...currentRow,\n\t\t\tactive: false,\n\t\t\tcoachConnected: false,\n\t\t\tcoachLinkStatus: 'disconnected',\n\t\t\tcoachPhase: '',\n\t\t\tshareMode: 'Disconnected archive',\n\t\t\tcoachConnectionStatus: { state: 'disconnected-by-swimmer', disconnectedAt, disconnectedBy: authUsername },\n\t\t};\n\t\ttry {\n\t\t\twriteDbSnapshotIfPossible(currentPaths.dbPath, currentPaths.snapshotDir);\n\t\t\twriteAtomicJsonFile(currentPaths.dbPath, { ...currentDb, swimmers: archiveRows });\n\t\t} catch (archiveError) {\n\t\t\ttry {\n\t\t\t\twriteAtomicJsonFile(sourcePaths.dbPath, sourceDb);\n\t\t\t} catch (rollbackError) {\n\t\t\t\tthrow new Error(\`Coach-link disconnect archive write failed and source rollback failed: \${rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'}. Original error: \${archiveError instanceof Error ? archiveError.message : 'unknown archive write error'}\`);\n\t\t\t}\n\t\t\tthrow archiveError;\n\t\t}\n\n\t\tconst previousAuthUser = authUsers[authUserIndex];\n\t\tauthUsers[authUserIndex] = { ...previousAuthUser, tenantId: sourceTenantId };\n\t\ttry {\n\t\t\tpersistAuthUsers();\n\t\t} catch (error) {\n\t\t\tauthUsers[authUserIndex] = previousAuthUser;\n\t\t\tconst rollbackErrors = [];\n\t\t\ttry { writeAtomicJsonFile(sourcePaths.dbPath, sourceDb); } catch (rollbackError) { rollbackErrors.push(\`source: \${rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'}\`); }\n\t\t\ttry { writeAtomicJsonFile(currentPaths.dbPath, currentDb); } catch (rollbackError) { rollbackErrors.push(\`coach: \${rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'}\`); }\n\t\t\tif (rollbackErrors.length > 0) {\n\t\t\t\tthrow new Error(\`Coach-link disconnect auth persistence failed and database rollback was incomplete (\${rollbackErrors.join('; ')}). Original error: \${error instanceof Error ? error.message : 'unknown auth persistence error'}\`);\n\t\t\t}\n\t\t\tthrow error;\n\t\t}`;

    route = route.slice(0, blockStart) + transaction + route.slice(blockEnd);
    source = source.slice(0, disconnectStart) + route + source.slice(dbStart);
  }

  source = `${marker}\n${source}`;
}

for (const required of [
  'ATHLYRAX_COACH_LINK_TRANSACTIONAL_COMMIT_V1',
  'ATHLYRAX_COACH_LINK_ACCEPT_DB_FIRST_AUTH_LAST',
  'ATHLYRAX_COACH_LINK_REJECT_ROLLBACK_TARGET',
  'ATHLYRAX_COACH_LINK_DISCONNECT_DB_FIRST_AUTH_LAST',
  'Coach-link acceptance auth persistence failed and database rollback was incomplete',
  'Coach-link rejection source update failed and target rollback failed',
  'Coach-link disconnect auth persistence failed and database rollback was incomplete',
]) if (!source.includes(required)) throw new Error(`Coach-link transactional hardening missing: ${required}`);

for (const forbidden of [
  "action: 'coach_link_source_archive_update_failed'",
  "action: 'coach_link_rejection_source_update_failed'",
  "action: 'coach_link_disconnect_archive_update_failed'",
]) if (source.includes(forbidden)) throw new Error(`Best-effort coach-link lifecycle failure remains: ${forbidden}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('COACH_LINK_TRANSACTION_INTEGRITY_OK');
