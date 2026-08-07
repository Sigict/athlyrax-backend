import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const INSTALL_MARK = Symbol.for('athlyrax.dataSafetyGuardsInstalled');
const EXPRESS_INSTALL_MARK = Symbol.for('athlyrax.dbRevisionResponseGuardInstalled');
const readContext = new AsyncLocalStorage();

function resolveFilePath(value) {
  if (Buffer.isBuffer(value)) return path.resolve(value.toString());
  if (value instanceof URL) return path.resolve(value.pathname);
  return path.resolve(String(value || ''));
}

function isDatabasePath(value) {
  const resolved = resolveFilePath(value);
  return Boolean(resolved) && path.basename(resolved).toLowerCase() === 'db.json';
}

function safeJsonRead(filePath, fsModule = fs) {
  try {
    if (!fsModule.existsSync(filePath)) return null;
    const parsed = JSON.parse(fsModule.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getStorageRevision(payload) {
  const parsed = Number.parseInt(String(payload?.__meta?.storageRevision ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function getRevisionTime(payload) {
  for (const value of [
    payload?.__meta?.storageUpdatedAt,
    payload?.__meta?.updatedAt,
    payload?.__savedAt,
    payload?.updatedAt,
  ]) {
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function scopeToken(dbPath) {
  const parent = path.basename(path.dirname(dbPath)).replace(/[^a-zA-Z0-9._-]/g, '-') || 'root';
  const digest = crypto.createHash('sha256').update(path.resolve(dbPath)).digest('hex').slice(0, 12);
  return `${parent}-${digest}`;
}

function rotate(directory, maxFiles, fsModule = fs) {
  const files = fsModule.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const fullPath = path.join(directory, entry.name);
      return { fullPath, mtime: fsModule.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtime - left.mtime);
  for (const stale of files.slice(maxFiles)) {
    try {
      fsModule.unlinkSync(stale.fullPath);
    } catch {
      // Retention cleanup must not block the database write.
    }
  }
}

function backupDatabase(dbPath, reason, env, maxFiles, fsModule = fs) {
  if (!fsModule.existsSync(dbPath)) return '';
  const configuredRoot = String(env.ATHLYRAX_SAFETY_BACKUP_ROOT || '').trim();
  const root = path.resolve(configuredRoot || path.join(path.dirname(dbPath), 'safety-backups'));
  const directory = path.join(root, reason, scopeToken(dbPath));
  fsModule.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(
    directory,
    `${stamp}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`,
  );
  const sourceBytes = fsModule.readFileSync(dbPath);
  fsModule.copyFileSync(dbPath, destination);
  const backupBytes = fsModule.readFileSync(destination);
  if (!sourceBytes.equals(backupBytes)) {
    try { fsModule.unlinkSync(destination); } catch {}
    const error = new Error(`Safety backup verification failed for ${dbPath}.`);
    error.code = 'ATHLYRAX_DB_BACKUP_VERIFICATION_FAILED';
    throw error;
  }
  rotate(directory, maxFiles, fsModule);
  return destination;
}

function writeRevisionToIncoming(sourcePath, payload, revision, fsModule = fs) {
  const updated = {
    ...payload,
    __meta: {
      ...(payload?.__meta && typeof payload.__meta === 'object' ? payload.__meta : {}),
      storageRevision: revision,
      storageUpdatedAt: new Date().toISOString(),
    },
  };
  fsModule.writeFileSync(sourcePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}

export function installDataSafetyGuards(options = {}) {
  const fsModule = options.fsModule || fs;
  if (fsModule[INSTALL_MARK]) return fsModule[INSTALL_MARK];

  const env = options.env || process.env;
  const logger = options.logger || console;
  const isProduction = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const maxFiles = Math.max(
    1,
    Number.parseInt(String(env.ATHLYRAX_SAFETY_MAX_BACKUPS || '30'), 10) || 30,
  );
  const staleToleranceMs = Math.max(
    0,
    Number.parseInt(String(env.ATHLYRAX_STALE_WRITE_TOLERANCE_MS || '1000'), 10) || 1000,
  );
  const originalReadFile = fsModule.readFile.bind(fsModule);
  const originalRenameSync = fsModule.renameSync.bind(fsModule);

  fsModule.readFile = function guardedReadFile(filePath, ...args) {
    if (!isDatabasePath(filePath)) return originalReadFile(filePath, ...args);
    const callbackIndex = args.findIndex((value) => typeof value === 'function');
    if (callbackIndex < 0) return originalReadFile(filePath, ...args);
    const callback = args[callbackIndex];
    const dbPath = resolveFilePath(filePath);
    args[callbackIndex] = (...callbackArgs) => readContext.run(
      { dbPath },
      () => callback(...callbackArgs),
    );
    return originalReadFile(filePath, ...args);
  };

  fsModule.renameSync = function guardedRenameSync(sourceValue, destinationValue) {
    if (!isDatabasePath(destinationValue)) {
      return originalRenameSync(sourceValue, destinationValue);
    }

    const source = resolveFilePath(sourceValue);
    const destination = resolveFilePath(destinationValue);
    const context = readContext.getStore();

    if (context?.dbPath === destination) {
      const preview = backupDatabase(destination, 'read-time-rewrite-blocked', env, maxFiles, fsModule);
      try {
        fsModule.unlinkSync(source);
      } catch {
        // Temporary source cleanup is best effort.
      }
      logger.error(
        `[data-safety] Blocked database mutation during a read: ${destination}`
        + (preview ? `; current database preserved at ${preview}` : ''),
      );
      return;
    }

    const destinationExists = fsModule.existsSync(destination);
    const current = safeJsonRead(destination, fsModule);
    const incoming = safeJsonRead(source, fsModule);

    if (destinationExists && !current) {
      const preview = backupDatabase(destination, 'invalid-current-blocked', env, maxFiles, fsModule);
      const error = new Error(
        `Refusing database replacement because the current database is unreadable or invalid JSON: ${destination}`
        + (preview ? `; current bytes preserved at ${preview}` : ''),
      );
      error.code = 'ATHLYRAX_CURRENT_DB_INVALID';
      throw error;
    }

    if (!incoming) {
      const error = new Error(`Refusing database replacement because the incoming database is unreadable or invalid JSON: ${source}`);
      error.code = 'ATHLYRAX_INCOMING_DB_INVALID';
      throw error;
    }

    if (!destinationExists && isProduction) {
      const provisionedBy = String(incoming?.__meta?.provisionedBy || '').trim();
      const provisioningToken = String(incoming?.__meta?.provisioningToken || '').trim();
      const explicitProvisioning = provisionedBy === 'auth-register' && Boolean(provisioningToken);
      if (!explicitProvisioning) {
        const error = new Error(`Refusing to create a missing production database outside explicit tenant provisioning: ${destination}`);
        error.code = 'ATHLYRAX_MISSING_DB_CREATE_BLOCKED';
        throw error;
      }
    }

    const currentRevisionValue = getStorageRevision(current);
    const currentRevision = currentRevisionValue ?? 0;
    const incomingRevision = getStorageRevision(incoming);

    if (current && incomingRevision !== currentRevision) {
      const received = incomingRevision === null ? 'missing' : String(incomingRevision);
      const error = new Error(
        `Refusing database replacement. Expected storage revision ${currentRevision}, received ${received}.`,
      );
      error.code = 'ATHLYRAX_DB_REVISION_CONFLICT';
      throw error;
    }

    const currentTime = getRevisionTime(current);
    const incomingTime = getRevisionTime(incoming);
    if (
      Number.isFinite(currentTime)
      && Number.isFinite(incomingTime)
      && incomingTime + staleToleranceMs < currentTime
    ) {
      const error = new Error('Refusing stale database replacement.');
      error.code = 'ATHLYRAX_STALE_DB_WRITE';
      throw error;
    }

    writeRevisionToIncoming(source, incoming, currentRevision + 1, fsModule);
    const backup = backupDatabase(destination, 'pre-write', env, maxFiles, fsModule);
    try {
      return originalRenameSync(source, destination);
    } catch (error) {
      logger.error(
        `[data-safety] Database replacement failed for ${destination}`
        + (backup ? `; previous version preserved at ${backup}` : ''),
      );
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
  Object.defineProperty(fsModule, INSTALL_MARK, {
    configurable: true,
    enumerable: false,
    value: installation,
  });
  logger.info('[data-safety] Database write guards installed.');
  return installation;
}

export function installExpressDbRevisionResponseGuard(expressModule, options = {}) {
  const responsePrototype = expressModule?.response;
  if (!responsePrototype || typeof responsePrototype.send !== 'function') {
    throw new Error('Express response prototype is required.');
  }
  if (responsePrototype[EXPRESS_INSTALL_MARK]) return responsePrototype[EXPRESS_INSTALL_MARK];

  const logger = options.logger || console;
  const originalSend = responsePrototype.send;
  responsePrototype.send = function guardedSend(body) {
    try {
      const requestPath = String(this?.req?.originalUrl || this?.req?.url || '').split('?')[0];
      const successfulDbRead = String(this?.req?.method || '').toUpperCase() === 'GET'
        && requestPath === '/db'
        && Number(this?.statusCode || 200) >= 200
        && Number(this?.statusCode || 200) < 300;
      if (successfulDbRead) {
        const wasBuffer = Buffer.isBuffer(body);
        const wasString = typeof body === 'string' || wasBuffer;
        const raw = wasBuffer ? body.toString('utf8') : body;
        const parsed = wasString ? JSON.parse(String(raw || '{}')) : raw;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const revision = getStorageRevision(parsed) ?? 0;
          const payload = {
            ...parsed,
            __meta: {
              ...(parsed?.__meta && typeof parsed.__meta === 'object' ? parsed.__meta : {}),
              storageRevision: revision,
            },
          };
          this.setHeader?.('X-AthlyraX-DB-Revision', String(revision));
          body = wasString ? `${JSON.stringify(payload, null, 2)}\n` : payload;
        }
      }
    } catch (error) {
      logger.error(
        `[data-safety] Could not attach storage revision to GET /db: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return originalSend.call(this, body);
  };

  const installation = Object.freeze({
    installed: true,
    uninstall() {
      responsePrototype.send = originalSend;
      delete responsePrototype[EXPRESS_INSTALL_MARK];
    },
  });
  Object.defineProperty(responsePrototype, EXPRESS_INSTALL_MARK, {
    configurable: true,
    enumerable: false,
    value: installation,
  });
  return installation;
}

export const dataSafetyInternals = Object.freeze({
  getRevisionTime,
  getStorageRevision,
  isDatabasePath,
});
