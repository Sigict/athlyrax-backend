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
    legalAcceptances: path.join(storage, 'legal-acceptances.jsonl'),
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
  } catch { return null; }
}

function hasMeaningfulDemoData(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const collectionKeys = ['swimmers', 'squads', 'trainingSessions', 'trainingSessionSets', 'tests', 'attendance', 'competitions', 'fixtures', 'groups'];
  return collectionKeys.some((key) => Array.isArray(payload?.[key]) && payload[key].length > 0);
}

function validMeaningfulDatabase(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size < 1024) return null;
  const payload = readJsonObject(filePath);
  if (!payload || !hasMeaningfulDemoData(payload)) return null;
  return { filePath, stat, payload };
}

function classifyDatabase(filePath) {
  if (!fs.existsSync(filePath)) return { state: 'missing' };
  const stat = fs.statSync(filePath);
  if (stat.size <= 16) return { state: 'empty', stat };
  const payload = readJsonObject(filePath);
  if (!payload) return { state: 'invalid', stat };
  if (Object.keys(payload).length === 0 || !hasMeaningfulDemoData(payload)) return { state: 'empty', stat, payload };
  return { state: 'meaningful', stat, payload };
}

export function restoreBundledDemoTenantIfNeeded({ sourceRoot, storageRoot, backupRoot, logger = console } = {}) {
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot });
  const liveDemo = paths.tenantDb('demo-company');
  const liveState = classifyDatabase(liveDemo);
  if (liveState.state === 'meaningful') return { restored: false, reason: 'live-demo-present', liveDemo };
  if (liveState.state === 'invalid') {
    throw new Error(`Canonical demo-company database is unreadable or invalid JSON: ${liveDemo}`);
  }

  const legacyDemo = path.join(paths.storageRoot, 'tenants', 'clubs', 'demo-company', 'db.json');
  const bundledDemo = path.join(paths.repositoryStorage, 'tenants', 'demo-company', 'db.json');
  const legacyCandidate = validMeaningfulDatabase(legacyDemo);
  const bundledCandidate = validMeaningfulDatabase(bundledDemo);
  const sourceCandidate = legacyCandidate || bundledCandidate;
  if (!sourceCandidate) throw new Error('No valid demo-company recovery database is available.');

  fs.mkdirSync(path.dirname(liveDemo), { recursive: true });
  const backupDirectory = backupRoot ? path.join(path.resolve(backupRoot), 'demo-bootstrap-replaced') : '';
  if (backupDirectory) fs.mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (fs.existsSync(liveDemo) && backupDirectory) {
    fs.copyFileSync(liveDemo, path.join(backupDirectory, `${stamp}-canonical-demo-before-recovery.json`));
  }
  if (legacyCandidate && backupDirectory) {
    fs.copyFileSync(legacyDemo, path.join(backupDirectory, `${stamp}-legacy-demo-source-preserved.json`));
  }

  const sourceBytes = fs.readFileSync(sourceCandidate.filePath);
  fs.copyFileSync(sourceCandidate.filePath, liveDemo);
  const restoredBytes = fs.readFileSync(liveDemo);
  const restored = validMeaningfulDatabase(liveDemo);
  if (!restored || restored.stat.size !== sourceCandidate.stat.size || !sourceBytes.equals(restoredBytes)) {
    throw new Error('Demo-company recovery verification failed.');
  }

  const sourceLabel = legacyCandidate ? 'legacy-live' : 'bundled-seed';
  logger.info(`[storage-path] Restored demo-company database from ${sourceLabel} source (${restored.stat.size} bytes).`);
  return { restored: true, reason: 'live-demo-missing-or-empty', source: sourceLabel, liveDemo, bytes: restored.stat.size };
}

export function assertCanonicalPathContract({ sourceRoot, storageRoot, indexSource = '' } = {}) {
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot });
  const source = String(indexSource || '');
  const failures = [];
  if (paths.repositoryStorage !== path.join(path.resolve(sourceRoot), 'storage')) failures.push('Repository bundled storage path is not sourceRoot/storage.');
  if (source) {
    const forbidden = [
      [`path.join(STORAGE_ROOT, 'tenants', 'clubs')`, 'Legacy tenants/clubs path is still present.'],
      [`path.join(STORAGE_ROOT, 'auth-users.json')`, 'Legacy root-level auth-users path is still present.'],
      [`writeAtomicJsonFile(storagePaths.dbPath, {});`, 'Unsafe empty tenant database auto-creation is still present.'],
    ];
    for (const [token, message] of forbidden) if (source.includes(token)) failures.push(message);
    const required = [
      [`path.join(STORAGE_ROOT, 'tenants')`, 'Canonical tenant root is missing from backend source.'],
      [`path.join(STORAGE_ROOT, 'auth', 'auth-users.json')`, 'Canonical auth-users path is missing from backend source.'],
      [`action: 'tenant_database_missing'`, 'Fail-closed missing-tenant handling is missing from backend source.'],
    ];
    for (const [token, message] of required) if (!source.includes(token)) failures.push(message);
  }
  if (failures.length) {
    const error = new Error(failures.join('\n'));
    error.code = 'ATHLYRAX_STORAGE_PATH_CONTRACT_FAILED';
    throw error;
  }
  return paths;
}
