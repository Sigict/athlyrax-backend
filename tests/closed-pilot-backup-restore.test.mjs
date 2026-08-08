import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(process.cwd());
const stageScript = path.join(root, 'scripts', 'stage-storage-restore.mjs');

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function runStage(args) {
  return spawnSync(process.execPath, [stageScript, ...args], { cwd: root, encoding: 'utf8' });
}

test('guarded stage restore preserves tenant separation and never activates production', () => {
  const temp = tempDir('athlyrax-stage-restore-');
  try {
    const exportsDir = path.join(temp, 'exports');
    const stageDir = path.join(temp, 'stage');
    const globalDb = path.join(exportsDir, 'global.json');
    const tenantA = path.join(exportsDir, 'tenant-a.json');
    const tenantB = path.join(exportsDir, 'tenant-b.json');

    writeJson(globalDb, { __meta: { tenantId: 'global-owner' }, settings: { version: 1 } });
    writeJson(tenantA, { __meta: { tenantId: 'tenant-a' }, swimmers: [{ id: 'swimmer-a' }] });
    writeJson(tenantB, { __meta: { tenantId: 'tenant-b' }, swimmers: [{ id: 'swimmer-b' }] });

    const result = runStage([
      '--destination', stageDir,
      '--global-db', globalDb,
      '--tenant', `tenant-a=${tenantA}`,
      '--tenant', `tenant-b=${tenantB}`,
      '--approve', 'STAGE_ONLY',
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ATHLYRAX_STORAGE_RESTORE_STAGED/);
    assert.match(result.stdout, /Production activation: NOT PERFORMED/);
    assert.match(result.stdout, /Storage approval marker: NOT CREATED/);

    const stagedA = JSON.parse(fs.readFileSync(path.join(stageDir, 'tenants', 'tenant-a', 'db.json'), 'utf8'));
    const stagedB = JSON.parse(fs.readFileSync(path.join(stageDir, 'tenants', 'tenant-b', 'db.json'), 'utf8'));
    assert.equal(stagedA.__meta.tenantId, 'tenant-a');
    assert.equal(stagedB.__meta.tenantId, 'tenant-b');
    assert.equal(stagedA.swimmers[0].id, 'swimmer-a');
    assert.equal(stagedB.swimmers[0].id, 'swimmer-b');
    assert.equal(fs.existsSync(path.join(stageDir, '.athlyrax-storage-ready.json')), false);

    const manifest = JSON.parse(fs.readFileSync(path.join(stageDir, 'staged-restore-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.tenantIds, ['tenant-a', 'tenant-b']);
    assert.equal(manifest.mode, 'api-export-stage-only');
    assert.equal(manifest.files.length, 3);
    assert.ok(manifest.files.every((row) => /^[a-f0-9]{64}$/.test(String(row.sha256 || ''))));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('guarded stage restore rejects cross-tenant mapping before creating any staged output', () => {
  const temp = tempDir('athlyrax-stage-cross-tenant-');
  try {
    const globalDb = path.join(temp, 'global.json');
    const wrongTenant = path.join(temp, 'wrong-tenant.json');
    const stageDir = path.join(temp, 'stage');
    writeJson(globalDb, { settings: { version: 1 } });
    writeJson(wrongTenant, { __meta: { tenantId: 'tenant-b' }, swimmers: [{ id: 'wrong' }] });

    const result = runStage([
      '--destination', stageDir,
      '--global-db', globalDb,
      '--tenant', `tenant-a=${wrongTenant}`,
      '--approve', 'STAGE_ONLY',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /declares tenant tenant-b but restore mapping is tenant-a/);
    assert.equal(fs.existsSync(stageDir), false, 'validation failure must not leave a partial destination');
    const leftovers = fs.readdirSync(temp).filter((name) => name.includes('.stage.athlyrax-stage-'));
    assert.deepEqual(leftovers, [], 'validation failure must not leave a temporary staging tree');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('guarded stage restore rejects a global export declaring a tenant identity', () => {
  const temp = tempDir('athlyrax-stage-global-identity-');
  try {
    const globalDb = path.join(temp, 'global.json');
    const stageDir = path.join(temp, 'stage');
    writeJson(globalDb, { __meta: { tenantId: 'tenant-a' }, settings: { version: 1 } });
    const result = runStage([
      '--destination', stageDir,
      '--global-db', globalDb,
      '--approve', 'STAGE_ONLY',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /declares tenant tenant-a but restore mapping is global-owner/);
    assert.equal(fs.existsSync(stageDir), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('guarded stage restore refuses a non-empty destination and missing explicit approval', () => {
  const temp = tempDir('athlyrax-stage-destination-');
  try {
    const globalDb = path.join(temp, 'global.json');
    const nonEmpty = path.join(temp, 'stage');
    writeJson(globalDb, { settings: { version: 1 } });
    fs.mkdirSync(nonEmpty, { recursive: true });
    fs.writeFileSync(path.join(nonEmpty, 'existing.txt'), 'keep\n', 'utf8');

    const nonEmptyResult = runStage([
      '--destination', nonEmpty,
      '--global-db', globalDb,
      '--approve', 'STAGE_ONLY',
    ]);
    assert.notEqual(nonEmptyResult.status, 0);
    assert.match(nonEmptyResult.stderr, /Destination must be empty/);
    assert.equal(fs.readFileSync(path.join(nonEmpty, 'existing.txt'), 'utf8'), 'keep\n');

    const noApproval = runStage([
      '--destination', path.join(temp, 'another-stage'),
      '--global-db', globalDb,
      '--approve', 'NO',
    ]);
    assert.notEqual(noApproval.status, 0);
    assert.match(noApproval.stderr, /Explicit approval is required: --approve STAGE_ONLY/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
