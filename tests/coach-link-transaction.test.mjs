import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('index.js'), 'utf8');

test('coach request refuses a same-tenant two-database transfer', () => {
  const requestStart = source.indexOf("app.post('/swimmer/coach/request'");
  const listStart = source.indexOf("app.get('/coach/swimmer-links'", requestStart);
  assert.ok(requestStart >= 0 && listStart > requestStart, 'request route bounds missing');
  const request = source.slice(requestStart, listStart);
  assert.ok(request.includes('ATHLYRAX_COACH_LINK_DISTINCT_SOURCE_TARGET'));
  assert.ok(request.includes('sourceTenantId === targetTenantId'));
  assert.ok(request.includes('A cross-tenant connection request was not created.'));
});

test('coach-link lifecycle uses database-first auth-last commit ordering', () => {
  for (const marker of [
    'ATHLYRAX_COACH_LINK_TRANSACTIONAL_COMMIT_V1',
    'ATHLYRAX_COACH_LINK_ACCEPT_DB_FIRST_AUTH_LAST',
    'ATHLYRAX_COACH_LINK_REJECT_ROLLBACK_TARGET',
    'ATHLYRAX_COACH_LINK_DISCONNECT_DB_FIRST_AUTH_LAST',
    'ATHLYRAX_ATHLETE_TENANT_REGISTRY_V1',
  ]) assert.ok(source.includes(marker), `missing transaction marker ${marker}`);

  const acceptStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/accept'");
  const rejectStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/reject'", acceptStart);
  assert.ok(acceptStart >= 0 && rejectStart > acceptStart, 'accept route bounds missing');
  const accept = source.slice(acceptStart, rejectStart);
  const targetWrite = accept.indexOf('writeAtomicJsonFile(targetPaths.dbPath, nextTargetDb);');
  const sourceWrite = accept.indexOf('writeAtomicJsonFile(sourcePaths.dbPath, nextSourceDb);');
  const authMove = accept.indexOf('authUsers[swimmerUserIndex] = {');
  const registryPersist = accept.indexOf('athleteTenantConnections: nextAthleteTenantConnections');
  const authPersist = accept.indexOf('persistAuthUsers();');
  assert.ok(targetWrite >= 0 && sourceWrite > targetWrite, 'acceptance does not commit target then source');
  assert.ok(authMove > sourceWrite, 'acceptance changes auth before both database copies commit');
  assert.ok(registryPersist > authMove && authPersist > registryPersist, 'athlete tenant registry must be committed with the auth move and persisted last');
  assert.ok(accept.includes('tenantId: actorTenantId'), 'acceptance no longer routes the legacy primary tenant to the accepted club');
  assert.ok(accept.includes('writeAtomicJsonFile(sourcePaths.dbPath, sourceDb);'), 'acceptance source rollback missing');
  assert.ok(accept.includes('writeAtomicJsonFile(targetPaths.dbPath, targetDb);'), 'acceptance target rollback missing');
  assert.equal(accept.includes("action: 'coach_link_source_archive_update_failed'"), false, 'acceptance still treats source update as best-effort');
});

test('rejection cannot report success after swimmer-side update failure', () => {
  const rejectStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/reject'");
  const disconnectStart = source.indexOf("app.post('/swimmer/coach/disconnect'", rejectStart);
  assert.ok(rejectStart >= 0 && disconnectStart > rejectStart, 'reject route bounds missing');
  const reject = source.slice(rejectStart, disconnectStart);
  assert.ok(reject.includes('ATHLYRAX_COACH_LINK_REJECT_ROLLBACK_TARGET'));
  assert.ok(reject.includes('writeAtomicJsonFile(targetPaths.dbPath, targetDb);'));
  assert.ok(reject.includes('throw sourceError;'));
  assert.equal(reject.includes("action: 'coach_link_rejection_source_update_failed'"), false, 'rejection still swallows swimmer-side failure');
});

test('approved disconnect commits source and coach archive before auth routing', () => {
  const disconnectStart = source.indexOf("app.post('/swimmer/coach/disconnect'");
  const dbStart = source.indexOf('// Serve db.json at /db', disconnectStart);
  assert.ok(disconnectStart >= 0 && dbStart > disconnectStart, 'disconnect route bounds missing');
  const disconnect = source.slice(disconnectStart, dbStart);
  const sourceWrite = disconnect.indexOf('writeAtomicJsonFile(sourcePaths.dbPath, nextSourceDb);');
  const archiveWrite = disconnect.indexOf('writeAtomicJsonFile(currentPaths.dbPath, { ...currentDb, swimmers: archiveRows });');
  const authMove = disconnect.indexOf('authUsers[authUserIndex] = {');
  const registryPersist = disconnect.indexOf('athleteTenantConnections: nextAthleteTenantConnections');
  const authPersist = disconnect.indexOf('persistAuthUsers();');
  assert.ok(sourceWrite >= 0 && archiveWrite > sourceWrite, 'disconnect does not commit source then coach archive');
  assert.ok(authMove > archiveWrite, 'disconnect changes auth before both database copies commit');
  assert.ok(registryPersist > authMove && authPersist > registryPersist, 'disconnect registry update must be part of the auth-last commit');
  assert.ok(disconnect.includes('tenantId: sourceTenantId'), 'disconnect no longer restores the legacy primary tenant to the source club');
  assert.ok(disconnect.includes('deactivateAthleteTenantConnection('), 'disconnect does not deactivate only the current tenant registry entry');
  assert.ok(disconnect.includes('writeAtomicJsonFile(sourcePaths.dbPath, sourceDb);'), 'disconnect source rollback missing');
  assert.ok(disconnect.includes('writeAtomicJsonFile(currentPaths.dbPath, currentDb);'), 'disconnect coach rollback missing');
  assert.equal(disconnect.includes("action: 'coach_link_disconnect_archive_update_failed'"), false, 'disconnect still treats coach archive update as best-effort');
});
