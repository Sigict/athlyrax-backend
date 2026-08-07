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

test('production runtime cannot activate built-in default auth users', () => {
  assert.ok(source.includes('ATHLYRAX_PRODUCTION_DEFAULT_AUTH_USERS_DISABLED'));
  assert.ok(source.includes('const DEFAULT_AUTH_USERS = IS_PRODUCTION ? [] : ['));
});

test('password reset request endpoints do not reveal delivery outcome or use first-match identity lookup', () => {
  for (const startText of [
    "app.post('/auth/password-reset/request'",
    "app.post('/snapshot/account/password-reset/request'",
  ]) {
    const body = route(startText);
    assert.ok(body.includes("If an account exists, a reset code has been issued."));
    assert.equal(body.includes('Could not issue reset code. Please contact your administrator.'), false);
    assert.equal(body.includes('Could not issue reset code. Please try again.'), false);
    assert.equal(body.includes('findAuthUserByIdentifier(identifier)'), false);
    assert.ok(body.includes('resolveLoginUserByIdentifier(identifier)'));
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
  const snapshotConfirm = route("app.post('/snapshot/account/password-reset/confirm'");
  assert.equal(snapshotConfirm.includes('findAuthUserByIdentifier(identifier)'), false);
  assert.ok(snapshotConfirm.includes('resolveLoginUserByIdentifier(identifier)'));
});

test('snapshot sign-in rejects ambiguous identifiers instead of selecting first match', () => {
  const body = route("app.post('/snapshot/account/auth'");
  assert.ok(body.includes('ATHLYRAX_SNAPSHOT_LOGIN_IDENTIFIER_AMBIGUITY_SAFE'));
  assert.ok(body.includes('resolveLoginUserByIdentifier(identifier)'));
  assert.equal(body.includes('findAuthUserByIdentifier(identifier)'), false);
});

test('onboarding email uniqueness has one authoritative guard', () => {
  const body = route("app.post('/auth/onboarding/complete'");
  assert.ok(body.includes('ATHLYRAX_ONBOARDING_EMAIL_UNIQUE'));
  assert.equal(body.includes('ATHLYRAX_ONBOARDING_EMAIL_UNIQUENESS'), false);
  assert.ok(body.includes('duplicateOnboardingEmail'));
  assert.ok(body.includes("res.status(409).json({ error: 'Email is already registered.' });"));
});
