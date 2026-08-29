import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('index.js', 'utf8');

test('demo.coach receives canonical head-coach authority without mutating its stored auth row', () => {
  assert.match(source, /const canonicalLoginUsername = String\(user\?\.username \|\| ''\)\.trim\(\)\.toLowerCase\(\);/);
  assert.match(source, /canonicalLoginUsername === 'demo\.coach'[\s\S]{0,80}role: 'head-coach'/);
  assert.match(source, /const session = issueAuthToken\(effectiveLoginUser\);/);
  assert.match(source, /user: buildAuthUserPayload\(effectiveLoginUser\)/);
  const start = source.indexOf("const canonicalLoginUsername = String(user?.username || '').trim().toLowerCase();");
  const end = source.indexOf("app.post('/auth/password-reset/request'", start);
  assert.doesNotMatch(source.slice(start, end), /persistAuthUsers\(\)/);
});
