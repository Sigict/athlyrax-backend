import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(process.cwd());
const indexPath = path.join(root, 'index.js');
const buildPath = path.join(root, 'scripts', 'build-production-backend.mjs');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runBuild() {
  return spawnSync(process.execPath, [buildPath], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
  });
}

test('production hardening build can run again after postinstall without changing the installed backend', () => {
  const before = sha256(indexPath);
  const firstRepeat = runBuild();
  assert.equal(firstRepeat.status, 0, `second production build failed:\n${firstRepeat.stdout}\n${firstRepeat.stderr}`);
  const afterFirstRepeat = sha256(indexPath);
  assert.equal(afterFirstRepeat, before, 'running the production hardening build after postinstall changed index.js');

  const secondRepeat = runBuild();
  assert.equal(secondRepeat.status, 0, `third production build failed:\n${secondRepeat.stdout}\n${secondRepeat.stderr}`);
  const afterSecondRepeat = sha256(indexPath);
  assert.equal(afterSecondRepeat, before, 'repeated production hardening is not byte-for-byte idempotent');
});
