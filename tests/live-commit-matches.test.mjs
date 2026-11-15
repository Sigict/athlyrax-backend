// Production health: identical code under a different commit id (PR head vs its merge commit) is
// current; any file difference, a failed comparison or a missing commit is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveCommitMatches, sameCode } from '../scripts/live-commit-matches.mjs';
const A = 'ec39bc75e9c73fd0a774498a787671cb2c9fb609'; const B = 'd0ba49cf0c0ec23a36c15bc1156ddc0e7b44af17';
const fake = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
test('same code under a merge commit passes; different code, errors and missing commits fail', async () => {
  assert.equal((await liveCommitMatches(B, B, { fetchImpl: fake(500, {}) })).ok, true, 'exact match needs no comparison');
  assert.equal((await liveCommitMatches(A, B, { fetchImpl: fake(200, { status: 'ahead', ahead_by: 1, files: [] }) })).ok, true);
  assert.equal((await liveCommitMatches(A, B, { fetchImpl: fake(200, { status: 'ahead', ahead_by: 7, files: [{}, {}, {}] }) })).ok, false);
  assert.equal((await liveCommitMatches(A, B, { fetchImpl: fake(200, { status: 'behind', files: [] }) })).ok, false, 'live ahead of main is not current');
  assert.equal((await liveCommitMatches(A, B, { fetchImpl: fake(404, {}) })).ok, false);
  assert.equal((await liveCommitMatches('', B, { fetchImpl: fake(200, {}) })).ok, false);
  assert.equal(sameCode({ status: 'identical', files: [] }), true);
});
