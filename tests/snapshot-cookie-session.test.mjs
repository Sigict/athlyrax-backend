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

test('snapshot login uses cookie session and CSRF without exposing bearer token response', () => {
  const body = route("app.post('/snapshot/account/auth'");
  assert.ok(body.includes('ATHLYRAX_SNAPSHOT_COOKIE_SESSION_V1'));
  assert.ok(body.includes('setAuthCookies(res, { token: session.token, csrfToken: session.csrf });'));
  assert.ok(body.includes('csrfToken: session.csrf'));
  assert.ok(body.includes('csrfHeaderName: AUTH_CSRF_HEADER_NAME'));
  assert.equal(/res\.status\(200\)\.json\(\{[^}]*token:\s*session\.token/s.test(body), false);
});

test('snapshot signup keeps cookie session but does not expose bearer token', () => {
  const body = route("app.post('/snapshot/account/auth'");
  assert.ok(body.includes('ATHLYRAX_SNAPSHOT_SIGNUP_NO_BEARER_TOKEN'));
  assert.ok(body.includes("const session = issueAuthToken({ username, role: 'swimmer' });"));
  assert.ok(body.includes('setAuthCookies(res, { token: session.token, csrfToken: session.csrf });'));
  assert.equal(/res\.status\(201\)\.json\(\{[^}]*token:\s*session\.token/s.test(body), false);
});
