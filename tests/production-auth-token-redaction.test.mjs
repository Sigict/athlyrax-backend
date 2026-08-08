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

test('production login and registration do not expose bearer session tokens', () => {
  assert.ok(source.includes('ATHLYRAX_PRODUCTION_AUTH_TOKEN_RESPONSE_REDACTED'));
  for (const startText of ["app.post('/auth/register'", "app.post('/auth/login'"]) {
    const body = route(startText);
    assert.ok(body.includes('setAuthCookies(res, { token: session.token, csrfToken: session.csrf });'));
    assert.ok(body.includes('...(IS_PRODUCTION ? {} : { token: session.token })'));
    assert.ok(body.includes('csrfToken: session.csrf'));
    assert.equal(body.includes('\n\t\ttoken: session.token,'), false);
  }
});
