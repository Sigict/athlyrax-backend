import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('index.js'), 'utf8');

test('coach link workflow exists and is coach-authoritative', () => {
  for (const token of [
    'ATHLYRAX_COACH_LINK_WORKFLOW_V1',
    'ATHLYRAX_COACH_LINK_LIFECYCLE_V1',
    'ATHLYRAX_SWIMMER_PROFILE_SYNC_COACH_LINK_NON_AUTHORITATIVE',
    "app.post('/swimmer/coach/request'",
    "app.get('/coach/swimmer-links'",
    "app.post('/coach/swimmer-links/:requestId/accept'",
    "app.post('/coach/swimmer-links/:requestId/reject'",
    'A valid registered coach email is required for AthlyraX coach connection.',
    'coachLinkSourceTenantId',
    'ATHLYRAX_COACH_LINK_PARENT_CONTACTS_PRIVATE',
  ]) assert.ok(source.includes(token), `missing coach-link workflow token ${token}`);
});

test('generic swimmer profile sync cannot create or mutate coach-link lifecycle state', () => {
  const syncStart = source.indexOf("app.post('/swimmer/profile/sync'");
  const requestStart = source.indexOf("app.post('/swimmer/coach/request'", syncStart);
  assert.ok(syncStart >= 0 && requestStart > syncStart, 'swimmer profile sync route bounds missing');
  const syncSource = source.slice(syncStart, requestStart);

  for (const token of [
    "const nextCoachLinkStatus = previousCoachLinkStatus;",
    "coachConnected: previousCoachConnected",
    "coachEmail: String(existingRow?.coachEmail || '')",
    "coachCode: String(existingRow?.coachCode || '')",
    "coachRequestAt: String(existingRow?.coachRequestAt || '')",
    "coachReplyAt: String(existingRow?.coachReplyAt || '')",
    "coachApprovalAt: String(existingRow?.coachApprovalAt || '')",
  ]) assert.ok(syncSource.includes(token), `generic profile sync does not preserve server coach-link authority: ${token}`);

  for (const forbidden of [
    "requestedCoachLinkStatus === 'pending'",
    "coachConnected: sanitizedSync.payload.coachConnected",
    "coachLinkStatus: sanitizedSync.payload.coachLinkStatus",
    "coachEmail: sanitizedSync.payload.coachEmail",
    "coachRequestAt: sanitizedSync.payload.coachRequestAt",
    "coachApprovalAt: sanitizedSync.payload.coachApprovalAt",
  ]) assert.equal(syncSource.includes(forbidden), false, `generic profile sync still controls coach-link state: ${forbidden}`);
});

test('assistant coaches can view requests but only session coordinator can accept or reject', () => {
  assert.ok(source.includes("app.get('/coach/swimmer-links', requireStrictAuth, requireCoachLinkManagerRole"));
  assert.ok(source.includes("app.post('/coach/swimmer-links/:requestId/accept', requireStrictAuth, requireCoachLinkDecisionRole"));
  assert.ok(source.includes("app.post('/coach/swimmer-links/:requestId/reject', requireStrictAuth, requireCoachLinkDecisionRole"));
  assert.ok(source.includes("if (role === 'head-coach')"));
  assert.ok(source.includes('Session Coordinator approval is required for swimmer membership decisions.'));
});

test('coach request list does not expose parent notification contacts', () => {
  const listStart = source.indexOf("app.get('/coach/swimmer-links'");
  const acceptStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/accept'", listStart);
  assert.ok(listStart >= 0 && acceptStart > listStart, 'coach list route bounds missing');
  const listSource = source.slice(listStart, acceptStart);
  assert.equal(listSource.includes('parent1:'), false);
  assert.equal(listSource.includes('parent2:'), false);
  assert.ok(listSource.includes('requests: publicRequests'));
});

test('acceptance copies target data before changing swimmer tenant and never deletes source profile', () => {
  const acceptStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/accept'");
  const rejectStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/reject'", acceptStart);
  assert.ok(acceptStart >= 0 && rejectStart > acceptStart, 'coach accept route bounds missing');
  const acceptSource = source.slice(acceptStart, rejectStart);

  const targetWrite = acceptSource.indexOf('writeAtomicJsonFile(targetPaths.dbPath, nextTargetDb);');
  const authTenantUpdate = acceptSource.indexOf('authUsers[swimmerUserIndex] = { ...previousAuthUser, tenantId: actorTenantId };');
  const authPersist = acceptSource.indexOf('persistAuthUsers();');
  assert.ok(targetWrite >= 0, 'target DB write missing');
  assert.ok(authTenantUpdate > targetWrite, 'swimmer tenant changes before safe target copy');
  assert.ok(authPersist > authTenantUpdate, 'auth persistence must follow in-memory tenant update');
  assert.equal(acceptSource.includes('sourceRows.splice('), false, 'source swimmer data must not be deleted during acceptance');
  assert.equal(acceptSource.includes('fs.unlinkSync(sourcePaths.dbPath'), false, 'source swimmer DB must not be deleted during acceptance');
  assert.ok(acceptSource.includes('writeAtomicJsonFile(targetPaths.dbPath, targetDb);'), 'target rollback missing if auth persistence fails');
});

test('rejection updates source swimmer state without changing auth tenant', () => {
  const rejectStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/reject'");
  const disconnectStart = source.indexOf("app.post('/swimmer/coach/disconnect'", rejectStart);
  assert.ok(rejectStart >= 0 && disconnectStart > rejectStart, 'coach reject route bounds missing');
  const rejectSource = source.slice(rejectStart, disconnectStart);
  assert.ok(rejectSource.includes("coachLinkStatus: 'none'"));
  assert.equal(rejectSource.includes('tenantId: actorTenantId'), false, 'rejection must not move swimmer tenant');
});

test('approved disconnect copies latest swimmer data back before restoring auth routing', () => {
  const disconnectStart = source.indexOf("app.post('/swimmer/coach/disconnect'");
  const dbStart = source.indexOf('// Serve db.json at /db', disconnectStart);
  assert.ok(disconnectStart >= 0 && dbStart > disconnectStart, 'disconnect route bounds missing');
  const disconnectSource = source.slice(disconnectStart, dbStart);
  const sourceWrite = disconnectSource.indexOf('writeAtomicJsonFile(sourcePaths.dbPath, nextSourceDb);');
  const authMove = disconnectSource.indexOf('authUsers[authUserIndex] = { ...previousAuthUser, tenantId: sourceTenantId };');
  const authPersist = disconnectSource.indexOf('persistAuthUsers();');
  assert.ok(sourceWrite >= 0, 'copy-back write missing');
  assert.ok(authMove > sourceWrite, 'auth routing restored before safe copy-back');
  assert.ok(authPersist > authMove, 'restored auth routing not persisted after copy-back');
  assert.ok(disconnectSource.includes('writeAtomicJsonFile(sourcePaths.dbPath, sourceDb);'), 'source rollback missing if auth persist fails');
  assert.ok(disconnectSource.includes("coachLinkStatus: 'disconnected'"), 'coach-tenant archive state missing');
  assert.equal(disconnectSource.includes('fs.unlinkSync('), false, 'disconnect must not delete either tenant database');
});
