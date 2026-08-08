import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('index.js'), 'utf8');

function route(startText) {
  const start = source.indexOf(startText);
  assert.ok(start >= 0, `missing route ${startText}`);
  const next = source.indexOf('\napp.', start + startText.length);
  return source.slice(start, next >= 0 ? next : source.length);
}

test('snapshot login uses cookie session and CSRF instead of bearer token response', () => {
  const body = route("app.post('/snapshot/account/auth'");
  assert.ok(body.includes('ATHLYRAX_SNAPSHOT_COOKIE_SESSION_V1'));
  assert.ok(body.includes('setAuthCookies(res, { token: session.token, csrfToken: session.csrf });'));
  assert.ok(body.includes('csrfToken: session.csrf'));
  assert.ok(body.includes('csrfHeaderName: AUTH_CSRF_HEADER_NAME'));
  assert.equal(body.includes('res.status(200).json({ token: session.token'), false);
});

test('snapshot signup does not expose an authentication token', () => {
  const body = route("app.post('/snapshot/account/auth'");
  assert.ok(body.includes('ATHLYRAX_SNAPSHOT_SIGNUP_NO_BEARER_TOKEN'));
  assert.equal(body.includes("issueAuthToken({ username, role: 'swimmer' })"), false);
  assert.equal(body.includes('\ttoken: session.token,'), false);
});
