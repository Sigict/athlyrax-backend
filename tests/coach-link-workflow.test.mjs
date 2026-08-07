import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('index.js'), 'utf8');

test('coach link workflow exists and is coach-authoritative', () => {
  for (const token of [
    'ATHLYRAX_COACH_LINK_WORKFLOW_V1',
    "app.post('/swimmer/coach/request'",
    "app.get('/coach/swimmer-links'",
    "app.post('/coach/swimmer-links/:requestId/accept'",
    "app.post('/coach/swimmer-links/:requestId/reject'",
    "role === 'head-coach' || role === 'assistant-coach'",
    'A valid registered coach email is required for AthlyraX coach connection.',
    'Coach account required for swimmer connection decisions.',
    'coachLinkSourceTenantId',
  ]) assert.ok(source.includes(token), `missing coach-link workflow token ${token}`);
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
