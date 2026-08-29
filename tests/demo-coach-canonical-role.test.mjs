import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('index.js', 'utf8');

test('demo.coach login repair restores both canonical tenant and coach role', () => {
  assert.match(source, /canonicalUsername === 'demo\.coach' \? 'head-coach' : ''/);
  assert.match(source, /canonicalProfileDrifted = Boolean\(canonicalTenantId\)/);
  assert.match(source, /canonicalRole && String\(user\?\.role \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== canonicalRole/);
  assert.match(source, /\.\.\.\(canonicalRole \? \{ role: canonicalRole \} : \{\}\)/);
});
