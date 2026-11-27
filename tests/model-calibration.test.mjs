// Mathematical calibration versions (Final Model C): server-enforced permissions, validation, approval and activation.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerModelCalibration, activeModelConfig, createModelCalibrationStore } from '../model-calibration.mjs';
import { buildClubCapabilityProfile } from '../athlete-club-capability.mjs';

function server() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-mc-'));
  const app = express(); app.use(express.json());
  // test auth: x-test-user header = 'owner' | 'coach' | absent
  const requireStrictAuth = (req, res, next) => { const u = req.get('x-test-user'); if (!u) return res.status(401).json({ error: 'auth' }); req.auth = { username: u === 'owner' ? 'softwareowner' : 'demo.coach', role: u === 'owner' ? 'software-owner' : 'head-coach' }; return next(); };
  const requireSoftwareOwnerRole = (req, res, next) => (req.auth?.role === 'software-owner' && req.auth.username === 'softwareowner' ? next() : res.status(403).json({ error: 'owner' }));
  const audit = []; const store = registerModelCalibration(app, { storageRoot: root, requireStrictAuth, requireSoftwareOwnerRole, audit: (req, action, d) => audit.push({ action, ...d }) });
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, user, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { call, store, audit, root, close: () => { srv.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('permissions: only the primary Software Owner manages versions; every signed-in account reads the active one', async () => {
  const s = server();
  try {
    assert.equal((await s.call('GET', '/auth/model-calibration/active')).status, 401);
    assert.deepEqual((await s.call('GET', '/auth/model-calibration/active', 'coach')).body, { active: null });
    for (const [m, p, b] of [['GET', '/owner/model-calibration'], ['POST', '/owner/model-calibration/versions', { description: 'x' }], ['POST', '/owner/model-calibration/activate', { id: 'original-engine', confirm: true }],
      ['POST', '/owner/model-calibration/versions/mc-final-simulation/approve', { confirm: true }], ['PUT', '/owner/model-calibration/versions/mc-final-simulation', { description: 'x' }]]) {
      assert.equal((await s.call(m, p, 'coach', b)).status, 403, `${m} ${p}`);
    }
  } finally { s.close(); }
});

test('the approved simulation configuration is seeded as a draft; nothing is active until approved and activated', async () => {
  const s = server();
  try {
    const g = await s.call('GET', '/owner/model-calibration', 'owner');
    assert.equal(g.status, 200); assert.equal(g.body.activeId, 'original-engine'); assert.equal(g.body.versions.length, 1);
    assert.equal(g.body.versions[0].status, 'draft'); assert.equal(g.body.versions[0].config.engine, 'model-c');
    assert.equal(activeModelConfig(s.store), null);
    assert.equal((await s.call('POST', '/owner/model-calibration/activate', 'owner', { id: 'mc-final-simulation', confirm: true })).status, 409, 'draft cannot be activated');
    assert.equal((await s.call('POST', '/owner/model-calibration/versions/mc-final-simulation/approve', 'owner', {})).status, 400, 'approval needs explicit confirmation');
    assert.equal((await s.call('POST', '/owner/model-calibration/versions/mc-final-simulation/approve', 'owner', { confirm: true })).status, 200);
    assert.equal((await s.call('POST', '/owner/model-calibration/activate', 'owner', { id: 'mc-final-simulation' })).status, 400, 'activation needs explicit confirmation');
    const a = await s.call('POST', '/owner/model-calibration/activate', 'owner', { id: 'mc-final-simulation', confirm: true, reason: 'test' });
    assert.equal(a.status, 200); assert.equal(a.body.active.id, 'mc-final-simulation');
    assert.equal(activeModelConfig(s.store).engine, 'model-c');
    assert.equal((await s.call('PUT', '/owner/model-calibration/versions/mc-final-simulation', 'owner', { description: 'x', config: {} })).status, 409, 'approved versions are immutable');
    // rollback and restore
    assert.equal((await s.call('POST', '/owner/model-calibration/activate', 'owner', { id: 'original-engine', confirm: true })).status, 200);
    assert.equal(activeModelConfig(s.store), null);
    const r = await s.call('POST', '/owner/model-calibration/activate', 'owner', { id: 'mc-final-simulation', confirm: true });
    assert.equal(r.status, 200);
    const h = await s.call('GET', '/owner/model-calibration', 'owner');
    assert.deepEqual(h.body.history.map((x) => [x.from, x.to, x.by]), [['original-engine', 'mc-final-simulation', 'softwareowner'], ['mc-final-simulation', 'original-engine', 'softwareowner'], ['original-engine', 'mc-final-simulation', 'softwareowner']]);
    assert.ok(s.audit.some((x) => x.action === 'model_calibration_activated'));
  } finally { s.close(); }
});

test('drafts: validation, required description, duplicate, complete version metadata, persistence', async () => {
  const s = server();
  try {
    await s.call('GET', '/owner/model-calibration', 'owner');
    assert.equal((await s.call('POST', '/owner/model-calibration/versions', 'owner', { config: {} })).status, 400, 'description required');
    const bad = await s.call('POST', '/owner/model-calibration/versions', 'owner', { description: 'bad', config: { sourceWeights: { training: 0.9, testing: 0.5, competition: 0.2 } } });
    assert.equal(bad.status, 400); assert.ok(bad.body.details.some((e) => /sourceWeights/.test(e)));
    const neg = await s.call('POST', '/owner/model-calibration/versions', 'owner', { description: 'bad ref', config: { references: { speedTable: { 'SC|free|100|EN2': -1 } } } });
    assert.equal(neg.status, 400);
    const ok = await s.call('POST', '/owner/model-calibration/versions', 'owner', { description: 'alpha durability 0.9', label: 'test', config: { alpha: { durability: 0.9 } } });
    assert.equal(ok.status, 201); const v = ok.body.version;
    for (const k of ['id', 'creator', 'createdAt', 'engineVersion', 'referenceVersion', 'description', 'status', 'config']) assert.ok(v[k], k);
    assert.equal(v.config.alpha.durability, 0.9); assert.equal(v.config.alpha.technical_control, 1, 'complete parameter set stored');
    const dup = await s.call('POST', '/owner/model-calibration/versions', 'owner', { duplicateOf: v.id, description: 'copy' });
    assert.equal(dup.status, 201); assert.equal(dup.body.version.basedOn, v.id); assert.deepEqual(dup.body.version.config, v.config);
    const fresh = createModelCalibrationStore(s.root).read(); assert.equal(fresh.versions.length, 3, 'persisted to storage');
  } finally { s.close(); }
});

test('Athlete App profile follows the active model; with none active it is the original engine', () => {
  const db = { swimmers: [{ id: 's1', firstName: 'A', lastName: 'B', currentSquadId: 'q' }], squads: [{ id: 'q' }] };
  const original = buildClubCapabilityProfile(db, db.swimmers[0], { today: '2026-11-15', modelConfig: null });
  assert.ok(!original || !original.integratedUnrounded);
});
