import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const INSTALL_MARK = Symbol.for('athlyrax.dataSafetyGuardsInstalled');
const EXPRESS_INSTALL_MARK = Symbol.for('athlyrax.dbRevisionResponseGuardInstalled');
const readContext = new AsyncLocalStorage();
const CORE_DB_COLLECTIONS = Object.freeze([
  'coaches', 'squads', 'swimmers', 'venues', 'sessionTypes', 'timetables', 'timetableSlots', 'schedule',
  'trainingSessions', 'trainingSessionSets', 'templateSets', 'templateTests', 'trainingSetBlocks',
  'seasonPlans', 'mesoCycles', 'microCycles', 'attendance', 'tests', 'competitions', 'fixtures', 'groups',
  'seasons', 'trainingPlannerWeeks', 'conflictResolutions', 'changeLog', 'auditLog', 'notifications', 'documents',
]);

function resolveFilePath(value) {
  if (Buffer.isBuffer(value)) return path.resolve(value.toString());
  if (value instanceof URL) return path.resolve(decodeURIComponent(value.pathname));
  return path.resolve(String(value || ''));
}
function isDatabasePath(value) {
  const resolved = resolveFilePath(value);
  return Boolean(resolved) && path.basename(resolved).toLowerCase() === 'db.json';
}
function safeJsonRead(filePath, fsModule = fs) {
  try {
    if (!fsModule.existsSync(filePath)) return null;
    return JSON.parse(fsModule.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}
function safeJsonObject(filePath, fsModule = fs) {
  const parsed = safeJsonRead(filePath, fsModule);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}
function getStorageRevision(payload) {
  const parsed = Number.parseInt(String(payload?.__meta?.storageRevision ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function getRevisionTime(payload) {
  for (const value of [payload?.__meta?.storageUpdatedAt, payload?.__meta?.updatedAt, payload?.__savedAt, payload?.updatedAt]) {
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}
function coreRecordCount(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 0;
  return CORE_DB_COLLECTIONS.reduce((sum, key) => sum + (Array.isArray(payload[key]) ? payload[key].length : 0), 0);
}
function hasRecognizedDatabaseShape(payload) {
  return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload)
    && CORE_DB_COLLECTIONS.some((key) => Array.isArray(payload[key]));
}
function assertNoCatastrophicDataShrink(current, incoming) {
  const currentCount = coreRecordCount(current);
  const incomingCount = coreRecordCount(incoming);
  if (currentCount >= 20 && incomingCount < Math.ceil(currentCount * 0.2)) {
    const error = new Error(`Refusing database replacement that would shrink recognized records from ${currentCount} to ${incomingCount}. Use an explicit controlled bulk-deletion/recovery workflow.`);
    error.code = 'ATHLYRAX_DB_CATASTROPHIC_SHRINK_BLOCKED';
    throw error;
  }
}
function assertNoTotalDataWipe(current, incoming) {
  const currentCount = coreRecordCount(current);
  const incomingCount = coreRecordCount(incoming);
  if (currentCount > 0 && incomingCount === 0) {
    const error = new Error(`Refusing database replacement that would remove all ${currentCount} existing core records. Use an explicit controlled recovery/reset procedure instead.`);
    error.code = 'ATHLYRAX_DB_TOTAL_DATA_WIPE_BLOCKED';
    throw error;
  }
}
function normalizeTenantId(value) {
  const raw = String(value || '').trim();
  return raw && /^[a-z0-9_-]+$/.test(raw) ? raw : '';
}
function expectedTenantIdForDbPath(dbPath, env) {
  const storageRootRaw = String(env.ATHLYRAX_STORAGE_ROOT || '').trim();
  if (!storageRootRaw) return '';
  const tenantRoot = path.resolve(storageRootRaw, 'tenants');
  const resolved = path.resolve(dbPath);
  const relative = path.relative(tenantRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length !== 2 || parts[1].toLowerCase() !== 'db.json') return '';
  return normalizeTenantId(parts[0]);
}
function assertTenantIdentity(payload, destination, env, label) {
  const expected = expectedTenantIdForDbPath(destination, env);
  if (!expected) return '';
  const declaredRaw = String(payload?.__meta?.tenantId || '').trim();
  if (!declaredRaw) return expected;
  const declared = normalizeTenantId(declaredRaw);
  if (!declared || declared !== expected) {
    const error = new Error(`${label} tenant identity does not match destination. Expected ${expected}, received ${declaredRaw || '(missing)'}.`);
    error.code = 'ATHLYRAX_DB_TENANT_IDENTITY_CONFLICT';
    throw error;
  }
  return expected;
}
function criticalJsonStoreKind(value, env) {
  const rootRaw = String(env.ATHLYRAX_STORAGE_ROOT || '').trim();
  if (!rootRaw) return '';
  const root = path.resolve(rootRaw);
  const destination = resolveFilePath(value);
  const entries = new Map([
    [path.join(root, 'auth', 'auth-users.json'), 'auth-users'],
    [path.join(root, 'auth', 'auth-users.backup.json'), 'auth-users-backup'],
    [path.join(root, 'auth-invites.json'), 'auth-invites'],
    [path.join(root, 'snapshot-submissions.json'), 'snapshot-submissions'],
    [path.join(root, 'billing-catalog.json'), 'billing-catalog'],
  ]);
  return entries.get(destination) || '';
}
function validateCriticalJsonPayload(payload, kind) {
  if (kind === 'auth-users' || kind === 'auth-users-backup') {
    const users = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.users) ? payload.users : null);
    return Array.isArray(users) && users.length > 0;
  }
  if (kind === 'auth-invites' || kind === 'snapshot-submissions') return Array.isArray(payload);
  if (kind === 'billing-catalog') {
    return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload)
      && Array.isArray(payload.plans) && payload.plans.length > 0
      && payload.plans.every((plan) => plan && typeof plan === 'object' && String(plan.key || '').trim());
  }
  return false;
}
function assertNoCriticalStoreWipe(current, incoming, kind) {
  if (kind === 'snapshot-submissions' && Array.isArray(current) && current.length > 0 && Array.isArray(incoming) && incoming.length === 0) {
    const error = new Error('Refusing to replace non-empty snapshot history with an empty history. Use an explicit controlled reset procedure.');
    error.code = 'ATHLYRAX_SNAPSHOT_HISTORY_EMPTY_WIPE_BLOCKED';
    throw error;
  }
  if (kind === 'snapshot-submissions' && Array.isArray(current) && Array.isArray(incoming) && incoming.length < current.length) {
    const error = new Error('Refusing to shrink snapshot submission history during ordinary persistence. Use an explicit controlled retention/reset procedure.');
    error.code = 'ATHLYRAX_SNAPSHOT_HISTORY_SHRINK_BLOCKED';
    throw error;
  }
  if (kind === 'auth-invites' && Array.isArray(current) && Array.isArray(incoming) && incoming.length < current.length) {
    const error = new Error('Refusing to shrink authentication invite history during ordinary persistence.');
    error.code = 'ATHLYRAX_AUTH_INVITE_HISTORY_SHRINK_BLOCKED';
    throw error;
  }
  if ((kind === 'auth-users' || kind === 'auth-users-backup')) {
    const currentUsers = Array.isArray(current) ? current : (current && Array.isArray(current.users) ? current.users : []);
    const incomingUsers = Array.isArray(incoming) ? incoming : (incoming && Array.isArray(incoming.users) ? incoming.users : []);
    if (incomingUsers.length < currentUsers.length - 1) {
      const error = new Error('Refusing authentication-store replacement that removes more than one account in a single ordinary operation.');
      error.code = 'ATHLYRAX_AUTH_STORE_CATASTROPHIC_SHRINK_BLOCKED';
      throw error;
    }
  }
}
function scopeToken(filePath) {
  const parent = path.basename(path.dirname(filePath)).replace(/[^a-zA-Z0-9._-]/g, '-') || 'root';
  const digest = crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 12);
  return `${parent}-${digest}`;
}
function rotate(directory, maxFiles, fsModule = fs) {
  const files = fsModule.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => { const fullPath = path.join(directory, entry.name); return { fullPath, mtime: fsModule.statSync(fullPath).mtimeMs }; })
    .sort((left, right) => right.mtime - left.mtime);
  for (const stale of files.slice(maxFiles)) {
    try { fsModule.unlinkSync(stale.fullPath); } catch {}
  }
}
function durableWriteBytes(destination, bytes, fsModule = fs) {
  fsModule.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = fsModule.openSync(temp, 'wx', 0o600);
    fsModule.writeFileSync(handle, bytes);
    fsModule.fsyncSync(handle);
  } finally { if (handle !== null) fsModule.closeSync(handle); }
  try { fsModule.renameSync(temp, destination); }
  catch (error) { try { fsModule.unlinkSync(temp); } catch {} throw error; }
  try {
    const directoryHandle = fsModule.openSync(path.dirname(destination), 'r');
    try { fsModule.fsyncSync(directoryHandle); } finally { fsModule.closeSync(directoryHandle); }
  } catch {}
}
function backupFile(filePath, reason, env, maxFiles, fsModule = fs) {
  if (!fsModule.existsSync(filePath)) return '';
  const configuredRoot = String(env.ATHLYRAX_SAFETY_BACKUP_ROOT || '').trim();
  const root = path.resolve(configuredRoot || path.join(path.dirname(filePath), 'safety-backups'));
  const directory = path.join(root, reason, scopeToken(filePath));
  fsModule.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(directory, `${stamp}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
  const sourceBytes = fsModule.readFileSync(filePath);
  durableWriteBytes(destination, sourceBytes, fsModule);
  const backupBytes = fsModule.readFileSync(destination);
  if (!sourceBytes.equals(backupBytes)) {
    try { fsModule.unlinkSync(destination); } catch {}
    const error = new Error(`Safety backup verification failed for ${filePath}.`);
    error.code = 'ATHLYRAX_BACKUP_VERIFICATION_FAILED';
    throw error;
  }
  rotate(directory, maxFiles, fsModule);
  return destination;
}
function writeRevisionToIncoming(sourcePath, payload, revision, expectedTenantId = '', fsModule = fs) {
  const rawMeta = payload?.__meta && typeof payload.__meta === 'object' ? payload.__meta : {};
  const { provisioningToken: _discardedProvisioningToken, ...safeMeta } = rawMeta;
  const updated = {
    ...payload,
    __meta: { ...safeMeta, ...(expectedTenantId ? { tenantId: expectedTenantId } : {}), storageRevision: revision, storageUpdatedAt: new Date().toISOString() },
  };
  let handle = null;
  try {
    handle = fsModule.openSync(sourcePath, 'r+');
    fsModule.ftruncateSync(handle, 0);
    fsModule.writeFileSync(handle, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    fsModule.fsyncSync(handle);
  } finally { if (handle !== null) fsModule.closeSync(handle); }
}
function hasValidProvisioningProof(incoming, destination, env) {
  const provisionedBy = String(incoming?.__meta?.provisionedBy || '').trim();
  const provisioningToken = String(incoming?.__meta?.provisioningToken || '').trim();
  const authSecret = String(env.AUTH_SECRET || '');
  if (provisionedBy !== 'auth-register' || authSecret.length < 32 || !provisioningToken) return false;
  const expected = crypto.createHmac('sha256', authSecret).update(path.resolve(destination)).digest('hex');
  const receivedBytes = Buffer.from(provisioningToken);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && crypto.timingSafeEqual(receivedBytes, expectedBytes);
}

export function installDataSafetyGuards(options = {}) {
  const fsModule = options.fsModule || fs;
  if (fsModule[INSTALL_MARK]) return fsModule[INSTALL_MARK];
  const env = options.env || process.env;
  const logger = options.logger || console;
  const isProduction = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const maxFiles = Math.max(1, Number.parseInt(String(env.ATHLYRAX_SAFETY_MAX_BACKUPS || '30'), 10) || 30);
  const originalReadFile = fsModule.readFile.bind(fsModule);
  const originalRenameSync = fsModule.renameSync.bind(fsModule);

  fsModule.readFile = function guardedReadFile(filePath, ...args) {
    if (!isDatabasePath(filePath)) return originalReadFile(filePath, ...args);
    const callbackIndex = args.findIndex((value) => typeof value === 'function');
    if (callbackIndex < 0) return originalReadFile(filePath, ...args);
    const callback = args[callbackIndex];
    const dbPath = resolveFilePath(filePath);
    args[callbackIndex] = (...callbackArgs) => readContext.run({ dbPath }, () => callback(...callbackArgs));
    return originalReadFile(filePath, ...args);
  };

  fsModule.renameSync = function guardedRenameSync(sourceValue, destinationValue) {
    const destination = resolveFilePath(destinationValue);
    const criticalKind = criticalJsonStoreKind(destination, env);
    if (!isDatabasePath(destination) && !criticalKind) return originalRenameSync(sourceValue, destinationValue);
    const source = resolveFilePath(sourceValue);

    if (criticalKind) {
      const incoming = safeJsonRead(source, fsModule);
      if (!validateCriticalJsonPayload(incoming, criticalKind)) {
        const error = new Error(`Refusing invalid replacement for critical store ${criticalKind}: ${source}`);
        error.code = 'ATHLYRAX_CRITICAL_STORE_INCOMING_INVALID';
        throw error;
      }
      if (fsModule.existsSync(destination)) {
        const current = safeJsonRead(destination, fsModule);
        if (!validateCriticalJsonPayload(current, criticalKind)) {
          const preserved = backupFile(destination, `invalid-current-${criticalKind}`, env, maxFiles, fsModule);
          const error = new Error(`Refusing to replace invalid current critical store ${criticalKind}: ${destination}${preserved ? `; current bytes preserved at ${preserved}` : ''}`);
          error.code = 'ATHLYRAX_CRITICAL_STORE_CURRENT_INVALID';
          throw error;
        }
        assertNoCriticalStoreWipe(current, incoming, criticalKind);
        backupFile(destination, `pre-write-${criticalKind}`, env, maxFiles, fsModule);
      }
      return originalRenameSync(source, destination);
    }

    const context = readContext.getStore();
    if (context?.dbPath === destination) {
      const preview = backupFile(destination, 'read-time-rewrite-blocked', env, maxFiles, fsModule);
      try { fsModule.unlinkSync(source); } catch {}
      logger.error(`[data-safety] Blocked database mutation during a read: ${destination}${preview ? `; current database preserved at ${preview}` : ''}`);
      return;
    }

    const destinationExists = fsModule.existsSync(destination);
    const current = safeJsonObject(destination, fsModule);
    const incoming = safeJsonObject(source, fsModule);
    if (destinationExists && !current) {
      const preview = backupFile(destination, 'invalid-current-blocked', env, maxFiles, fsModule);
      const error = new Error(`Refusing database replacement because the current database is unreadable or invalid JSON: ${destination}${preview ? `; current bytes preserved at ${preview}` : ''}`);
      error.code = 'ATHLYRAX_CURRENT_DB_INVALID';
      throw error;
    }
    if (!incoming) {
      const error = new Error(`Refusing database replacement because the incoming database is unreadable or invalid JSON: ${source}`);
      error.code = 'ATHLYRAX_INCOMING_DB_INVALID';
      throw error;
    }
    if (!hasRecognizedDatabaseShape(incoming)) {
      const error = new Error(`Refusing database replacement because the incoming object has no recognized AthlyraX data collections: ${source}`);
      error.code = 'ATHLYRAX_DB_SHAPE_INVALID';
      throw error;
    }

    const expectedTenantId = assertTenantIdentity(incoming, destination, env, 'Incoming database');
    if (current) {
      assertTenantIdentity(current, destination, env, 'Current database');
      assertNoTotalDataWipe(current, incoming);
      assertNoCatastrophicDataShrink(current, incoming);
    }
    if (!destinationExists && isProduction && !hasValidProvisioningProof(incoming, destination, env)) {
      const error = new Error(`Refusing to create a missing production database outside explicit server-bound tenant provisioning: ${destination}`);
      error.code = 'ATHLYRAX_MISSING_DB_CREATE_BLOCKED';
      throw error;
    }

    const currentRevisionValue = getStorageRevision(current);
    const currentRevision = currentRevisionValue ?? 0;
    const incomingRevision = getStorageRevision(incoming);
    if (current) {
      const legacyRevisionAdoption = currentRevisionValue === null && (incomingRevision === null || incomingRevision === 0);
      const exactRevisionMatch = currentRevisionValue !== null && incomingRevision === currentRevisionValue;
      if (!legacyRevisionAdoption && !exactRevisionMatch) {
        const received = incomingRevision === null ? 'missing' : String(incomingRevision);
        const expected = currentRevisionValue === null ? 'legacy baseline 0 or missing' : String(currentRevisionValue);
        const error = new Error(`Refusing database replacement. Expected storage revision ${expected}, received ${received}.`);
        error.code = 'ATHLYRAX_DB_REVISION_CONFLICT';
        throw error;
      }
    }

    writeRevisionToIncoming(source, incoming, currentRevision + 1, expectedTenantId, fsModule);
    const backup = backupFile(destination, 'pre-write', env, maxFiles, fsModule);
    try { return originalRenameSync(source, destination); }
    catch (error) {
      logger.error(`[data-safety] Database replacement failed for ${destination}${backup ? `; previous version preserved at ${backup}` : ''}`);
      throw error;
    }
  };

  const installation = Object.freeze({
    installed: true,
    uninstall() {
      fsModule.readFile = originalReadFile;
      fsModule.renameSync = originalRenameSync;
      delete fsModule[INSTALL_MARK];
    },
  });
  Object.defineProperty(fsModule, INSTALL_MARK, { configurable: true, enumerable: false, value: installation });
  logger.info('[data-safety] Database and critical-store write guards installed.');
  return installation;
}

export function installExpressDbRevisionResponseGuard(expressModule, options = {}) {
  const responsePrototype = expressModule?.response;
  if (!responsePrototype || typeof responsePrototype.send !== 'function') throw new Error('Express response prototype is required.');
  if (responsePrototype[EXPRESS_INSTALL_MARK]) return responsePrototype[EXPRESS_INSTALL_MARK];
  const logger = options.logger || console;
  const originalSend = responsePrototype.send;
  responsePrototype.send = function guardedSend(body) {
    try {
      const requestPath = String(this?.req?.originalUrl || this?.req?.url || '').split('?')[0];
      const successfulDbRead = String(this?.req?.method || '').toUpperCase() === 'GET'
        && requestPath === '/db' && Number(this?.statusCode || 200) >= 200 && Number(this?.statusCode || 200) < 300;
      if (successfulDbRead) {
        const wasBuffer = Buffer.isBuffer(body);
        const wasString = typeof body === 'string' || wasBuffer;
        const raw = wasBuffer ? body.toString('utf8') : body;
        const parsed = wasString ? JSON.parse(String(raw || '{}')) : raw;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const revision = getStorageRevision(parsed) ?? 0;
          const payload = { ...parsed, __meta: { ...(parsed?.__meta && typeof parsed.__meta === 'object' ? parsed.__meta : {}), storageRevision: revision } };
          this.setHeader?.('X-AthlyraX-DB-Revision', String(revision));
          body = wasString ? `${JSON.stringify(payload, null, 2)}\n` : payload;
        }
      }
    } catch (error) {
      logger.error(`[data-safety] Could not attach storage revision to GET /db: ${error instanceof Error ? error.message : String(error)}`);
    }
    return originalSend.call(this, body);
  };
  const installation = Object.freeze({
    installed: true,
    uninstall() { responsePrototype.send = originalSend; delete responsePrototype[EXPRESS_INSTALL_MARK]; },
  });
  Object.defineProperty(responsePrototype, EXPRESS_INSTALL_MARK, { configurable: true, enumerable: false, value: installation });
  return installation;
}

export const dataSafetyInternals = Object.freeze({
  getRevisionTime, getStorageRevision, isDatabasePath, hasValidProvisioningProof,
  expectedTenantIdForDbPath, criticalJsonStoreKind, validateCriticalJsonPayload,
  coreRecordCount, assertNoTotalDataWipe, assertNoCriticalStoreWipe,
});
