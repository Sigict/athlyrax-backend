import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEMO_TENANT_ID = 'demo-company';
const TRAINING_MIRROR_CLEANUP_VERSION = 1;
const TIMETABLE_LEGACY_CLEANUP_VERSION = 1;
const TRAINING_MIRROR_IGNORED_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'createdByUserId',
  'updatedByUserId',
  'tenantId',
  'attributionStatus',
  'squadNames',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value ?? '').trim();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function stripMirrorMetadata(row) {
  const result = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (!TRAINING_MIRROR_IGNORED_FIELDS.has(key)) result[key] = value;
  }
  return result;
}

function rowsAreSafeScheduleMirror(leftRows, rightRows) {
  const left = asArray(leftRows);
  const right = asArray(rightRows);
  if (left.length === 0 || left.length !== right.length) return false;

  const rightById = new Map();
  for (const row of right) {
    const id = text(row?.id);
    if (!id || rightById.has(id)) return false;
    rightById.set(id, row);
  }
  if (rightById.size !== right.length) return false;

  const seen = new Set();
  for (const row of left) {
    const id = text(row?.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    const other = rightById.get(id);
    if (!other || canonicalJson(stripMirrorMetadata(row)) !== canonicalJson(stripMirrorMetadata(other))) return false;
  }
  return seen.size === left.length;
}

function looksLikeLegacyTimetableSession(row) {
  if (!row || typeof row !== 'object') return false;
  const day = text(row.dayLabel || row.day || row.weekday);
  const squads = [
    ...asArray(row.squadIds),
    row.squadId,
  ].map(text).filter(Boolean);
  return Boolean(day && text(row.startTime) && text(row.endTime) && squads.length > 0);
}

function verifiedBackup(dbPath, backupRoot, bytes, fsModule) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(backupRoot, 'planning-cleanup', DEMO_TENANT_ID);
  fsModule.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, `${stamp}-${crypto.randomBytes(4).toString('hex')}.json`);
  fsModule.writeFileSync(destination, bytes, { mode: 0o600 });
  const verify = fsModule.readFileSync(destination);
  if (!bytes.equals(verify)) throw new Error('Demo planning cleanup backup verification failed.');
  return destination;
}

function atomicWriteJson(destination, payload, fsModule) {
  const temp = `${destination}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  let handle = null;
  try {
    handle = fsModule.openSync(temp, 'wx', 0o600);
    fsModule.writeFileSync(handle, bytes);
    fsModule.fsyncSync(handle);
  } finally {
    if (handle !== null) fsModule.closeSync(handle);
  }
  fsModule.renameSync(temp, destination);
}

export function cleanupDemoPlanningStorage({ storageRoot, backupRoot, fsModule = fs, logger = console } = {}) {
  if (!text(storageRoot)) throw new Error('cleanupDemoPlanningStorage requires storageRoot.');
  if (!text(backupRoot)) throw new Error('cleanupDemoPlanningStorage requires backupRoot.');

  const dbPath = path.resolve(storageRoot, 'tenants', DEMO_TENANT_ID, 'db.json');
  if (!fsModule.existsSync(dbPath)) return { changed: false, reason: 'missing-demo-db' };

  const sourceBytes = fsModule.readFileSync(dbPath);
  const db = JSON.parse(sourceBytes.toString('utf8'));
  if (!db || typeof db !== 'object' || Array.isArray(db)) throw new Error('Demo database is not an object.');
  const tenantId = text(db?.__meta?.tenantId);
  if (tenantId && tenantId !== DEMO_TENANT_ID) throw new Error(`Refusing demo cleanup for tenant ${tenantId}.`);

  const next = { ...db, __meta: { ...(db.__meta || {}), tenantId: DEMO_TENANT_ID } };
  let changed = false;
  let clearedTrainingSchedules = 0;
  let clearedLegacyTimetableRows = 0;
  let clearedEmbeddedTimetableRows = 0;

  const trainingCleanupDone = Number(next.__meta.demoTrainingSchedulesMirrorCleanupVersion || 0) >= TRAINING_MIRROR_CLEANUP_VERSION;
  if (!trainingCleanupDone) {
    const schedule = asArray(next.schedule);
    const legacy = asArray(next.trainingSchedules);
    if (legacy.length === 0) {
      next.__meta.demoTrainingSchedulesMirrorCleanupVersion = TRAINING_MIRROR_CLEANUP_VERSION;
      changed = true;
    } else if (rowsAreSafeScheduleMirror(schedule, legacy)) {
      clearedTrainingSchedules = legacy.length;
      next.trainingSchedules = [];
      next.__meta.demoTrainingSchedulesMirrorCleanupVersion = TRAINING_MIRROR_CLEANUP_VERSION;
      changed = true;
    } else {
      logger.warn('[planning-cleanup] trainingSchedules differs from canonical schedule in protected business fields; leaving it untouched.');
    }
  }

  const timetableCleanupDone = Number(next.__meta.demoTimetableLegacyCleanupVersion || 0) >= TIMETABLE_LEGACY_CLEANUP_VERSION;
  if (!timetableCleanupDone) {
    const migrationVersion = Number(next.__meta.timetableSlotsLegacyMigrationVersion || 0);
    if (migrationVersion >= 5) {
      const legacyTable = asArray(next.timetable);
      const timetableRows = asArray(next.timetables);
      const persistentHeaders = timetableRows.filter((row) => !looksLikeLegacyTimetableSession(row));
      clearedLegacyTimetableRows = legacyTable.length;
      clearedEmbeddedTimetableRows = timetableRows.length - persistentHeaders.length;
      if (clearedLegacyTimetableRows > 0) next.timetable = [];
      if (clearedEmbeddedTimetableRows > 0) next.timetables = persistentHeaders;
      next.__meta.demoTimetableLegacyCleanupVersion = TIMETABLE_LEGACY_CLEANUP_VERSION;
      changed = true;
    } else {
      logger.warn('[planning-cleanup] timetable canonical migration v5 is not confirmed; leaving legacy timetable storage untouched.');
    }
  }

  if (!changed) {
    return {
      changed: false,
      reason: 'nothing-safe-to-clean',
      clearedTrainingSchedules,
      clearedLegacyTimetableRows,
      clearedEmbeddedTimetableRows,
    };
  }

  const backupPath = verifiedBackup(dbPath, backupRoot, sourceBytes, fsModule);
  const previousRevision = Number.parseInt(String(db?.__meta?.storageRevision ?? '0'), 10);
  next.__meta.storageRevision = (Number.isFinite(previousRevision) && previousRevision >= 0 ? previousRevision : 0) + 1;
  next.__meta.storageUpdatedAt = new Date().toISOString();
  next.__meta.demoPlanningStorageCleanupAt = new Date().toISOString();
  atomicWriteJson(dbPath, next, fsModule);

  const written = JSON.parse(fsModule.readFileSync(dbPath, 'utf8'));
  if (asArray(written.trainingSchedules).length !== asArray(next.trainingSchedules).length) {
    throw new Error('Demo planning cleanup post-write verification failed for trainingSchedules.');
  }
  if (asArray(written.timetable).length !== asArray(next.timetable).length) {
    throw new Error('Demo planning cleanup post-write verification failed for timetable.');
  }

  return {
    changed: true,
    backupPath,
    storageRevision: next.__meta.storageRevision,
    clearedTrainingSchedules,
    clearedLegacyTimetableRows,
    clearedEmbeddedTimetableRows,
  };
}
