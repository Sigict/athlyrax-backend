import fs from 'node:fs';
import path from 'node:path';

export function canonicalStoragePaths({ sourceRoot, storageRoot } = {}) {
  const source = path.resolve(String(sourceRoot || process.cwd()));
  const storage = path.resolve(String(storageRoot || path.join(source, 'storage')));
  const tenantRoot = path.join(storage, 'tenants');
  const authRoot = path.join(storage, 'auth');
  return Object.freeze({
    sourceRoot: source,
    repositoryStorage: path.join(source, 'storage'),
    storageRoot: storage,
    globalDb: path.join(storage, 'db.json'),
    targetBackup: path.join(storage, 'trainingPlannerTargets.backup.json'),
    snapshotDir: path.join(storage, 'db-snapshots'),
    tenantRoot,
    billingCatalog: path.join(storage, 'billing-catalog.json'),
    billingBackupDir: path.join(storage, 'billing-catalog-backups'),
    authRoot,
    authUsers: path.join(authRoot, 'auth-users.json'),
    authUsersBackup: path.join(authRoot, 'auth-users.backup.json'),
    authInvites: path.join(storage, 'auth-invites.json'),
    snapshotSubmissions: path.join(storage, 'snapshot-submissions.json'),
    authAuditDir: path.join(storage, 'auth-audit'),
    tenantDb(tenantId) {
      const clean = String(tenantId || '').trim();
      if (!/^[a-zA-Z0-9._-]+$/.test(clean)) throw new Error(`Unsafe tenant ID: ${clean}`);
      return path.join(tenantRoot, clean, 'db.json');
    },
  });
}

function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasMeaningfulDemoData(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const collectionKeys = [
    'swimmers', 'squads', 'trainingSessions', 'trainingSessionSets', 'tests',
    'attendance', 'competitions', 'fixtures', 'groups',
  ];
  return collectionKeys.some((key) => Array.isArray(payload?.[key]) && payload[key].length > 0);
}

function isEffectivelyEmptyDatabase(filePath) {
  if (!fs.existsSync(filePath)) return true;
  const stat = fs.statSync(filePath);
  if (stat.size <= 16) return true;
  const parsed = readJsonObject(filePath);
  if (!parsed) return false;
  if (Object.keys(parsed).length === 0) return true;
  return !hasMeaningfulDemoData(parsed);
}

export function restoreBundledDemoTenantIfNeeded({ sourceRoot, storageRoot, backupRoot, logger = console } = {}) {
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot });
  const bundledDemo = path.join(paths.repositoryStorage, 'tenants', 'demo-company', 'db.json');
  const liveDemo = paths.tenantDb('demo-company');

  if (!fs.existsSync(bundledDemo)) return { restored: false, reason: 'bundled-demo-not-present', liveDemo };

  const bundledStat = fs.statSync(bundledDemo);
  const bundledPayload = readJsonObject(bundledDemo);
  if (!bundledPayload || bundledStat.size < 1024 || !hasMeaningfulDemoData(bundledPayload)) {
    throw new Error('Bundled demo-company database is invalid, unexpectedly small, or contains no demo records.');
  }

  if (!isEffectivelyEmptyDatabase(liveDemo)) return { restored: false, reason: 'live-demo-present', liveDemo };

  fs.mkdirSync(path.dirname(liveDemo), { recursive: true });
  if (fs.existsSync(liveDemo) && backupRoot) {
    const backupDirectory = path.join(path.resolve(backupRoot), 'demo-bootstrap-replaced');
    fs.mkdirSync(backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(liveDemo, path.join(backupDirectory, `${stamp}-demo-company-db.json`));
  }

  fs.copyFileSync(bundledDemo, liveDemo);
  const restoredStat = fs.statSync(liveDemo);
  const restoredPayload = readJsonObject(liveDemo);
  if (restoredStat.size !== bundledStat.size || !hasMeaningfulDemoData(restoredPayload)) {
    throw new Error('Demo-company restore verification failed.');
  }

  logger.info(`[storage-path] Restored demo-company database from bundled source (${restoredStat.size} bytes).`);
  return { restored: true, reason: 'live-demo-missing-or-empty', liveDemo, bytes: restoredStat.size };
}

export function assertCanonicalPathContract({ sourceRoot, storageRoot, indexSource = '' } = {}) {
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot });
  const source = String(indexSource || '');
  const failures = [];

  if (paths.repositoryStorage !== path.join(path.resolve(sourceRoot), 'storage')) {
    failures.push('Repository bundled storage path is not sourceRoot/storage.');
  }

  if (source) {
    const forbidden = [
      [`path.join(STORAGE_ROOT, 'tenants', 'clubs')`, 'Legacy tenants/clubs path is still present.'],
      [`path.join(STORAGE_ROOT, 'auth-users.json')`, 'Legacy root-level auth-users path is still present.'],
      [`writeAtomicJsonFile(storagePaths.dbPath, {});`, 'Unsafe empty tenant database auto-creation is still present.'],
    ];
    for (const [token, message] of forbidden) {
      if (source.includes(token)) failures.push(message);
    }

    const required = [
      [`path.join(STORAGE_ROOT, 'tenants')`, 'Canonical tenant root is missing from backend source.'],
      [`path.join(STORAGE_ROOT, 'auth', 'auth-users.json')`, 'Canonical auth-users path is missing from backend source.'],
      [`action: 'tenant_database_missing'`, 'Fail-closed missing-tenant handling is missing from backend source.'],
    ];
    for (const [token, message] of required) {
      if (!source.includes(token)) failures.push(message);
    }
  }

  if (failures.length) {
    const error = new Error(failures.join('\n'));
    error.code = 'ATHLYRAX_STORAGE_PATH_CONTRACT_FAILED';
    throw error;
  }
  return paths;
}
