// AthlyraX mathematical calibration versions (Final Model C), global to the software.
// Only the primary Software Owner may create, change, approve or activate a version (enforced here, on the server).
// Every signed-in account may READ the active version so its calculations use it; with no active Model C version the
// original working engine stays in use. Versions are never edited after approval and never deleted, so every historical
// result can be reproduced with the exact parameters, engine version and reference-table version it used.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildDefaultModelConfig, resolveModelConfig, validateModelConfig, MODEL_C_ENGINE_VERSION, MODEL_C_REFERENCE_VERSION } from './capability-engine/src/utils/modelC/config.js';

export const MODEL_CALIBRATION_FILE = 'model-calibration/versions.json';
export const ORIGINAL_VERSION_ID = 'original-engine';
const text = (v) => String(v ?? '').trim();
const nowIso = () => new Date().toISOString();
const EMPTY = () => ({ schema: 'athlyrax-model-calibration-v1', activeId: null, history: [], versions: [] });

export function createModelCalibrationStore(storageRoot) {
  const file = path.join(storageRoot, MODEL_CALIBRATION_FILE);
  let cache = null;
  const read = () => {
    if (cache) return cache;
    try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); cache = v && Array.isArray(v.versions) ? v : EMPTY(); } catch { cache = EMPTY(); }
    return cache;
  };
  const write = (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw e; }
    cache = data;
  };
  // First owner visit: the approved Phase 0 configuration is available as a DRAFT (never approved or activated by code).
  const ensureSeed = (actor) => {
    const data = read();
    if (data.versions.length) return data;
    const config = buildDefaultModelConfig();
    const next = { ...data, versions: [{ id: 'mc-final-simulation', label: 'Final Model C — approved simulation configuration', description: 'Recommended configuration of the approved Phase 0 final simulation (27-11-2026). Reproduces the simulation exactly.',
      status: 'draft', creator: actor, createdAt: nowIso(), engineVersion: MODEL_C_ENGINE_VERSION, referenceVersion: MODEL_C_REFERENCE_VERSION, basedOn: null, config }] };
    write(next); return next;
  };
  const activeRecord = () => {
    const data = read();
    if (!data.activeId || data.activeId === ORIGINAL_VERSION_ID) return null;
    const v = data.versions.find((x) => x.id === data.activeId);
    return v ? { id: v.id, label: v.label, config: v.config, engineVersion: v.engineVersion, referenceVersion: v.referenceVersion, approvedAt: v.approvedAt, activatedAt: v.activatedAt } : null;
  };
  return { file, read, write, ensureSeed, activeRecord };
}

// Active Model C configuration for server-side calculations (Athlete App); null = original engine.
let registeredStore = null;
export function activeModelConfig(store = registeredStore) {
  const rec = store?.activeRecord?.();
  return rec ? resolveModelConfig(rec.config) : null;
}

export function registerModelCalibration(app, { storageRoot, requireStrictAuth, requireSoftwareOwnerRole, audit = () => {}, store = createModelCalibrationStore(storageRoot) }) {
  registeredStore = store;
  const actorOf = (req) => text(req.auth?.username) || 'unknown';
  const fail = (res, status, error, details) => res.status(status).json({ error, ...(details ? { details } : {}) });
  const summary = (v) => ({ id: v.id, label: v.label, description: v.description, status: v.status, creator: v.creator, createdAt: v.createdAt, updatedAt: v.updatedAt || null,
    approvedBy: v.approvedBy || null, approvedAt: v.approvedAt || null, activatedBy: v.activatedBy || null, activatedAt: v.activatedAt || null,
    engineVersion: v.engineVersion, referenceVersion: v.referenceVersion, basedOn: v.basedOn || null, config: v.config });

  // Read-only for every signed-in account (calculations need the active version).
  // Under /auth so every deployment path (production /api/*, local development proxy) reaches it; alias kept.
  const readActive = (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ active: store.activeRecord() }); };
  app.get('/auth/model-calibration/active', requireStrictAuth, readActive);
  app.get('/model-calibration/active', requireStrictAuth, readActive);

  app.get('/owner/model-calibration', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
    const data = store.ensureSeed(actorOf(req));
    res.set('Cache-Control', 'no-store');
    res.json({ activeId: data.activeId || ORIGINAL_VERSION_ID, history: data.history.slice(-100), versions: data.versions.map(summary),
      defaults: buildDefaultModelConfig(), engineVersion: MODEL_C_ENGINE_VERSION, referenceVersion: MODEL_C_REFERENCE_VERSION });
  });

  // Save a new draft (from a configuration, or duplicating an existing version).
  app.post('/owner/model-calibration/versions', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
    const data = store.ensureSeed(actorOf(req));
    const body = req.body || {};
    const source = body.duplicateOf ? data.versions.find((v) => v.id === text(body.duplicateOf)) : null;
    if (body.duplicateOf && !source) return fail(res, 404, 'Version to duplicate not found.');
    const config = resolveModelConfig(source ? source.config : body.config);
    const check = validateModelConfig(config);
    if (!check.ok) return fail(res, 400, 'Invalid configuration.', check.errors);
    const description = text(body.description).slice(0, 2000);
    if (!description) return fail(res, 400, 'A change description is required.');
    const v = { id: `mc-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, label: text(body.label).slice(0, 120) || (source ? `Copy of ${source.label}` : 'Draft configuration'),
      description, status: 'draft', creator: actorOf(req), createdAt: nowIso(), engineVersion: MODEL_C_ENGINE_VERSION, referenceVersion: MODEL_C_REFERENCE_VERSION,
      basedOn: source ? source.id : text(body.basedOn) || null, config };
    store.write({ ...data, versions: [...data.versions, v] });
    audit(req, 'model_calibration_draft_saved', { id: v.id, basedOn: v.basedOn });
    res.status(201).json({ version: summary(v), warnings: check.warnings });
  });

  // Update a DRAFT only (approved versions are immutable).
  app.put('/owner/model-calibration/versions/:id', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
    const data = store.ensureSeed(actorOf(req)); const id = text(req.params.id);
    const v = data.versions.find((x) => x.id === id); if (!v) return fail(res, 404, 'Version not found.');
    if (v.status !== 'draft') return fail(res, 409, 'Only a draft can be changed; duplicate an approved version to change it.');
    const config = resolveModelConfig(req.body?.config ?? v.config); const check = validateModelConfig(config);
    if (!check.ok) return fail(res, 400, 'Invalid configuration.', check.errors);
    const description = text(req.body?.description ?? v.description).slice(0, 2000); if (!description) return fail(res, 400, 'A change description is required.');
    const next = { ...v, config, description, label: text(req.body?.label ?? v.label).slice(0, 120) || v.label, updatedAt: nowIso(), updatedBy: actorOf(req) };
    store.write({ ...data, versions: data.versions.map((x) => (x.id === id ? next : x)) });
    audit(req, 'model_calibration_draft_updated', { id });
    res.json({ version: summary(next), warnings: check.warnings });
  });

  app.post('/owner/model-calibration/versions/:id/approve', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
    const data = store.ensureSeed(actorOf(req)); const id = text(req.params.id);
    const v = data.versions.find((x) => x.id === id); if (!v) return fail(res, 404, 'Version not found.');
    if (v.status !== 'draft') return fail(res, 409, `Version is already ${v.status}.`);
    if (req.body?.confirm !== true) return fail(res, 400, 'Explicit confirmation is required to approve a configuration.');
    const check = validateModelConfig(resolveModelConfig(v.config)); if (!check.ok) return fail(res, 400, 'Invalid configuration cannot be approved.', check.errors);
    const next = { ...v, status: 'approved', approvedBy: actorOf(req), approvedAt: nowIso() };
    store.write({ ...data, versions: data.versions.map((x) => (x.id === id ? next : x)) });
    audit(req, 'model_calibration_approved', { id });
    res.json({ version: summary(next) });
  });

  // Activate an approved version, or the original engine (id 'original-engine' = rollback / reset to baseline).
  app.post('/owner/model-calibration/activate', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
    const data = store.ensureSeed(actorOf(req)); const id = text(req.body?.id);
    if (req.body?.confirm !== true) return fail(res, 400, 'Explicit Software Owner confirmation is required to activate.');
    let versions = data.versions;
    if (id !== ORIGINAL_VERSION_ID) {
      const v = data.versions.find((x) => x.id === id); if (!v) return fail(res, 404, 'Version not found.');
      if (!['approved', 'active', 'superseded'].includes(v.status)) return fail(res, 409, 'Only an approved configuration can be activated.');
      const check = validateModelConfig(resolveModelConfig(v.config)); if (!check.ok) return fail(res, 400, 'Invalid configuration cannot be activated.', check.errors);
    }
    const at = nowIso();
    versions = versions.map((x) => (x.id === id ? { ...x, status: 'active', activatedBy: actorOf(req), activatedAt: at } : x.status === 'active' ? { ...x, status: 'superseded', supersededAt: at } : x));
    const history = [...data.history, { at, by: actorOf(req), from: data.activeId || ORIGINAL_VERSION_ID, to: id || ORIGINAL_VERSION_ID, reason: text(req.body?.reason).slice(0, 500) }];
    store.write({ ...data, activeId: id === ORIGINAL_VERSION_ID ? null : id, versions, history });
    audit(req, 'model_calibration_activated', { id, previous: data.activeId || ORIGINAL_VERSION_ID });
    res.json({ activeId: id, active: store.activeRecord() });
  });
  return store;
}
