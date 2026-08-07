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

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function readJsonObject(filePath) {
  const parsed = readJson(filePath);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function hasMeaningfulDemoData(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const collectionKeys = ['swimmers', 'squads', 'trainingSessions', 'trainingSessionSets', 'tests', 'attendance', 'competitions', 'fixtures', 'groups'];
  return collectionKeys.some((key) => Array.isArray(payload?.[key]) && payload[key].length > 0);
}

function validMeaningfulDatabase(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size < 2) return null;
  const payload = readJsonObject(filePath);
  if (!payload || Object.keys(payload).length === 0) return null;
  return { filePath, stat, payload };
}

function classifyDatabase(filePath) {
  if (!fs.existsSync(filePath)) return { state: 'missing' };
  const stat = fs.statSync(filePath);
  if (stat.size <= 16) {
    const tinyPayload = readJsonObject(filePath);
    if (tinyPayload && Object.keys(tinyPayload).length === 0) return { state: 'empty', stat, payload: tinyPayload };
  }
  const payload = readJsonObject(filePath);
  if (!payload) return { state: 'invalid', stat };
  if (Object.keys(payload).length === 0) return { state: 'empty', stat, payload };
  return { state: 'meaningful', stat, payload };
}

function validAuthStore(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size < 2) return null;
  const payload = readJson(filePath);
  const users = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.users) ? payload.users : null);
  if (!users) return null;
  return { filePath, stat, payload, users };
}

function copyExact(source, destination) {
  const sourceBytes = fs.readFileSync(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const destinationBytes = fs.readFileSync(destination);
  if (!sourceBytes.equals(destinationBytes)) throw new Error(`Verified copy failed: ${source} -> ${destination}`);
  return destinationBytes.length;
}

function backupLegacySource(source, backupRoot, relativeLabel) {
  if (!backupRoot || !fs.existsSync(source)) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(path.resolve(backupRoot), 'legacy-storage-migration', stamp, relativeLabel);
  copyExact(source, destination);
  return destination;
}

export function migrateLegacyStorageIfNeeded({ sourceRoot, storageRoot, backupRoot, logger = console } = {}) {
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot });
  const migrated = [];
  const legacyAuthUsers = path.join(paths.storageRoot, 'auth-users.json');
  const legacyAuthBackup = path.join(paths.storageRoot, 'auth-users.backup.json');

  if (fs.existsSync(paths.authUsers) && !validAuthStore(paths.authUsers)) {
    throw new Error(`Canonical auth users store is unreadable or invalid: ${paths.authUsers}`);
  }
  if (fs.existsSync(paths.authUsersBackup) && !validAuthStore(paths.authUsersBackup)) {
    throw new Error(`Canonical auth users backup is unreadable or invalid: ${paths.authUsersBackup}`);
  }
  if (!fs.existsSync(paths.authUsers) && fs.existsSync(legacyAuthUsers)) {
    if (!validAuthStore(legacyAuthUsers)) throw new Error(`Legacy auth users store is unreadable or invalid: ${legacyAuthUsers}`);
    backupLegacySource(legacyAuthUsers, backupRoot, path.join('auth', 'auth-users.json'));
    const bytes = copyExact(legacyAuthUsers, paths.authUsers);
    migrated.push({ kind: 'auth-users', from: legacyAuthUsers, to: paths.authUsers, bytes });
  }
  if (!fs.existsSync(paths.authUsersBackup) && fs.existsSync(legacyAuthBackup)) {
    if (!validAuthStore(legacyAuthBackup)) throw new Error(`Legacy auth users backup is unreadable or invalid: ${legacyAuthBackup}`);
    backupLegacySource(legacyAuthBackup, backupRoot, path.join('auth', 'auth-users.backup.json'));
    const bytes = copyExact(legacyAuthBackup, paths.authUsersBackup);
    migrated.push({ kind: 'auth-users-backup', from: legacyAuthBackup, to: paths.authUsersBackup, bytes });
  }
  if (fs.existsSync(paths.authUsers) && !fs.existsSync(paths.authUsersBackup)) {
    const bytes = copyExact(paths.authUsers, paths.authUsersBackup);
    migrated.push({ kind: 'auth-users-backup-baseline', from: paths.authUsers, to: paths.authUsersBackup, bytes });
  }

  const legacyTenantRoot = path.join(paths.storageRoot, 'tenants', 'clubs');
  if (fs.existsSync(legacyTenantRoot)) {
    for (const entry of fs.readdirSync(legacyTenantRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const tenantId = String(entry.name || '').trim();
      if (!/^[a-zA-Z0-9._-]+$/.test(tenantId)) throw new Error(`Unsafe legacy tenant directory name: ${tenantId}`);
      const legacyDb = path.join(legacyTenantRoot, tenantId, 'db.json');
      if (!fs.existsSync(legacyDb)) continue;
      const legacyCandidate = validMeaningfulDatabase(legacyDb);
      if (!legacyCandidate) throw new Error(`Legacy tenant database is unreadable, invalid or empty: ${legacyDb}`);

      const canonicalDb = paths.tenantDb(tenantId);
      const canonicalState = classifyDatabase(canonicalDb);
      if (canonicalState.state === 'invalid') throw new Error(`Canonical tenant database is unreadable or invalid JSON: ${canonicalDb}`);
      if (canonicalState.state === 'meaningful') continue;

      if (fs.existsSync(canonicalDb)) backupLegacySource(canonicalDb, backupRoot, path.join('canonical-before-migration', tenantId, 'db.json'));
      backupLegacySource(legacyDb, backupRoot, path.join('legacy-tenants', tenantId, 'db.json'));
      const bytes = copyExact(legacyDb, canonicalDb);
      migrated.push({ kind: 'tenant-db', tenantId, from: legacyDb, to: canonicalDb, bytes });
    }
  }

  for (const item of migrated) {
    logger.info(`[storage-path] Migrated ${item.kind}${item.tenantId ? ` ${item.tenantId}` : ''} to canonical storage (${item.bytes} bytes).`);
  }
  return { migrated, count: migrated.length };
}

export function restoreBundledDemoTenantIfNeeded({ sourceRoot, storageRoot, backupRoot, logger = console } = {}) {
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot });
  const liveDemo = paths.tenantDb('demo-company');
  const liveState = classifyDatabase(liveDemo);
  if (liveState.state === 'meaningful') return { restored: false, reason: 'live-demo-present', liveDemo };
  if (liveState.state === 'invalid') throw new Error(`Canonical demo-company database is unreadable or invalid JSON: ${liveDemo}`);

  const legacyDemo = path.join(paths.storageRoot, 'tenants', 'clubs', 'demo-company', 'db.json');
  const bundledDemo = path.join(paths.repositoryStorage, 'tenants', 'demo-company', 'db.json');
  const legacyCandidate = validMeaningfulDatabase(legacyDemo);
  const bundledCandidate = validMeaningfulDatabase(bundledDemo);
  if (bundledCandidate && !hasMeaningfulDemoData(bundledCandidate.payload)) throw new Error(`Bundled demo-company database contains no meaningful demo records: ${bundledDemo}`);
  const sourceCandidate = legacyCandidate || bundledCandidate;
  if (!sourceCandidate) throw new Error('No valid demo-company recovery database is available.');

  fs.mkdirSync(path.dirname(liveDemo), { recursive: true });
  const backupDirectory = backupRoot ? path.join(path.resolve(backupRoot), 'demo-bootstrap-replaced') : '';
  if (backupDirectory) fs.mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (fs.existsSync(liveDemo) && backupDirectory) copyExact(liveDemo, path.join(backupDirectory, `${stamp}-canonical-demo-before-recovery.json`));
  if (legacyCandidate && backupDirectory) copyExact(legacyDemo, path.join(backupDirectory, `${stamp}-legacy-demo-source-preserved.json`));

  const bytes = copyExact(sourceCandidate.filePath, liveDemo);
  const restored = validMeaningfulDatabase(liveDemo);
  if (!restored || restored.stat.size !== sourceCandidate.stat.size || !hasMeaningfulDemoData(restored.payload)) throw new Error('Demo-company recovery verification failed.');

  const sourceLabel = legacyCandidate ? 'legacy-live' : 'bundled-seed';
  logger.info(`[storage-path] Restored demo-company database from ${sourceLabel} source (${bytes} bytes).`);
  return { restored: true, reason: 'live-demo-missing-or-empty', source: sourceLabel, liveDemo, bytes };
}

export function assertCanonicalPathContract({ sourceRoot, storageRoot, indexSource = '' } = {}) {
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot });
  const source = String(indexSource || '');
  const failures = [];
  if (paths.repositoryStorage !== path.join(path.resolve(sourceRoot), 'storage')) failures.push('Repository bundled storage path is not sourceRoot/storage.');
  if (source) {
    const forbidden = [
      [`path.join(STORAGE_ROOT, 'tenants', 'clubs')`, 'Legacy tenants/clubs path is still present as a runtime declaration.'],
      [`path.join(STORAGE_ROOT, 'auth-users.json')`, 'Legacy root-level auth-users path is still present as a runtime declaration.'],
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
