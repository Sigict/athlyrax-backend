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

test('password reset request endpoints do not reveal delivery outcome', () => {
  for (const startText of [
    "app.post('/auth/password-reset/request'",
    "app.post('/snapshot/account/password-reset/request'",
  ]) {
    const body = route(startText);
    assert.ok(body.includes("If an account exists, a reset code has been issued."));
    assert.equal(body.includes('Could not issue reset code. Please contact your administrator.'), false);
    assert.equal(body.includes('Could not issue reset code. Please try again.'), false);
  }
});

test('password reset confirm endpoints do not reveal whether the account exists', () => {
  for (const startText of [
    "app.post('/auth/password-reset/confirm'",
    "app.post('/snapshot/account/password-reset/confirm'",
  ]) {
    const body = route(startText);
    assert.ok(body.includes('ATHLYRAX_PASSWORD_RESET_CONFIRM_GENERIC_UNKNOWN_ACCOUNT'));
    assert.equal(body.includes("res.status(404).json({ error: 'User not found.' });"), false);
    assert.ok(body.includes("res.status(400).json({ error: 'Reset code is invalid or expired.' });"));
  }
});
