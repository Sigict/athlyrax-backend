import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const LEGACY_MIGRATION_MARKER = '.athlyrax-legacy-storage-migration-v1.json';

function normalizeTenantId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}
function requireCanonicalTenantId(value, label = 'tenant ID') {
  const raw = String(value || '').trim();
  const normalized = normalizeTenantId(raw);
  if (!normalized || raw !== normalized) throw new Error(`Unsafe or noncanonical ${label}: ${raw}. Expected lowercase letters, numbers, underscores or hyphens only.`);
  return normalized;
}
function readJson(filePath) { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; } }
function readJsonObject(filePath) { const parsed = readJson(filePath); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
function validAuthStore(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const payload = readJson(filePath);
  const users = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.users) ? payload.users : null);
  if (!users) return null;
  return { filePath, payload, users, stat: fs.statSync(filePath) };
}
function classifyDatabase(filePath) {
  if (!fs.existsSync(filePath)) return { state: 'missing' };
  const stat = fs.statSync(filePath);
  const payload = readJsonObject(filePath);
  if (!payload) return { state: 'invalid', stat };
  if (Object.keys(payload).length === 0) return { state: 'empty', stat, payload };
  return { state: 'meaningful', stat, payload };
}
function validMeaningfulDatabase(filePath) {
  const state = classifyDatabase(filePath);
  return state.state === 'meaningful' ? { filePath, ...state } : null;
}
function assertTenantIdentity(payload, expectedTenantId, label) {
  const declaredRaw = String(payload?.__meta?.tenantId || '').trim();
  if (!declaredRaw) return;
  const declared = requireCanonicalTenantId(declaredRaw, 'declared tenant ID');
  const expected = requireCanonicalTenantId(expectedTenantId, 'expected tenant ID');
  if (declared !== expected) throw new Error(`${label} declares tenant ${declared} but is being routed to ${expected}. Refusing cross-tenant migration or recovery.`);
}
function hasMeaningfulDemoData(payload) {
  const keys = ['swimmers', 'squads', 'trainingSessions', 'trainingSessionSets', 'tests', 'attendance', 'competitions', 'fixtures', 'groups'];
  return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload)
    && keys.some((key) => Array.isArray(payload[key]) && payload[key].length > 0);
}
function validMeaningfulDemoDatabase(filePath) {
  const candidate = validMeaningfulDatabase(filePath);
  return candidate && hasMeaningfulDemoData(candidate.payload) ? candidate : null;
}
function durableWriteBytes(destination, bytes) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally { if (handle !== null) fs.closeSync(handle); }
  try { fs.renameSync(temp, destination); }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
  try {
    const directoryHandle = fs.openSync(path.dirname(destination), 'r');
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
  } catch {}
}
function copyExact(source, destination) {
  const sourceBytes = fs.readFileSync(source);
  durableWriteBytes(destination, sourceBytes);
  const destinationBytes = fs.readFileSync(destination);
  if (!sourceBytes.equals(destinationBytes)) throw new Error(`Verified copy failed: ${source} -> ${destination}`);
  return destinationBytes.length;
}
function writeAtomicJson(filePath, payload) { durableWriteBytes(filePath, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')); }
function listFilesRecursive(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const output = [];
  const visit = (current, relativeBase = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = path.join(relativeBase, entry.name);
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full, relative);
      else if (entry.isFile()) output.push({ full, relative });
    }
  };
  visit(rootDir);
  return output;
}
function readMigrationMarker(markerPath) {
  const marker = readJsonObject(markerPath);
  return marker && marker.completed === true && marker.version === 1 ? marker : null;
}

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
    legacyMigrationMarker: path.join(storage, LEGACY_MIGRATION_MARKER),
    tenantDb(tenantId) {
      const clean = requireCanonicalTenantId(tenantId);
      return path.join(tenantRoot, clean, 'db.json');
    },
  });
}

export function migrateLegacyStorageIfNeeded({ sourceRoot, storageRoot, backupRoot, logger = console } = {}) {
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot });
  const existingMarker = readMigrationMarker(paths.legacyMigrationMarker);
  if (existingMarker) return { migrated: [], count: 0, skipped: true, reason: 'legacy-migration-already-finalized', markerPath: paths.legacyMigrationMarker };

  const migrated = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupSession = backupRoot ? path.join(path.resolve(backupRoot), 'legacy-storage-migration', stamp) : '';
  const preserve = (source, relative) => {
    if (!backupSession || !fs.existsSync(source)) return '';
    const destination = path.join(backupSession, relative);
    copyExact(source, destination);
    return destination;
  };

  const legacyAuthUsers = path.join(paths.storageRoot, 'auth-users.json');
  const legacyAuthBackup = path.join(paths.storageRoot, 'auth-users.backup.json');
  if (fs.existsSync(paths.authUsers) && !validAuthStore(paths.authUsers)) throw new Error(`Canonical auth users store is unreadable or invalid: ${paths.authUsers}`);
  if (fs.existsSync(paths.authUsersBackup) && !validAuthStore(paths.authUsersBackup)) throw new Error(`Canonical auth users backup is unreadable or invalid: ${paths.authUsersBackup}`);

  if (!fs.existsSync(paths.authUsers) && fs.existsSync(legacyAuthUsers)) {
    if (!validAuthStore(legacyAuthUsers)) throw new Error(`Legacy auth users store is unreadable or invalid: ${legacyAuthUsers}`);
    preserve(legacyAuthUsers, path.join('legacy-auth', 'auth-users.json'));
    migrated.push({ kind: 'auth-users', from: legacyAuthUsers, to: paths.authUsers, bytes: copyExact(legacyAuthUsers, paths.authUsers) });
  }
  if (!fs.existsSync(paths.authUsersBackup) && fs.existsSync(legacyAuthBackup)) {
    if (!validAuthStore(legacyAuthBackup)) throw new Error(`Legacy auth users backup is unreadable or invalid: ${legacyAuthBackup}`);
    preserve(legacyAuthBackup, path.join('legacy-auth', 'auth-users.backup.json'));
    migrated.push({ kind: 'auth-users-backup', from: legacyAuthBackup, to: paths.authUsersBackup, bytes: copyExact(legacyAuthBackup, paths.authUsersBackup) });
  }
  if (fs.existsSync(paths.authUsers) && !fs.existsSync(paths.authUsersBackup)) {
    throw new Error('Authentication primary exists but no independent authentication backup is available. Refusing to manufacture a backup baseline from the primary store.');
  }

  const legacyTenantRoot = path.join(paths.storageRoot, 'tenants', 'clubs');
  if (fs.existsSync(legacyTenantRoot)) {
    for (const entry of fs.readdirSync(legacyTenantRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const tenantId = requireCanonicalTenantId(entry.name, 'legacy tenant directory name');
      const legacyTenantDir = path.join(legacyTenantRoot, entry.name);
      const canonicalTenantDir = path.join(paths.tenantRoot, tenantId);
      const legacyDb = path.join(legacyTenantDir, 'db.json');
      const canonicalDb = paths.tenantDb(tenantId);
      const canonicalState = classifyDatabase(canonicalDb);
      if (canonicalState.state === 'invalid') throw new Error(`Canonical tenant database is unreadable or invalid JSON: ${canonicalDb}`);
      if (canonicalState.state === 'meaningful') assertTenantIdentity(canonicalState.payload, tenantId, `Canonical tenant database ${canonicalDb}`);

      const legacyFiles = listFilesRecursive(legacyTenantDir);
      for (const file of legacyFiles) preserve(file.full, path.join('legacy-tenants', tenantId, file.relative));
      if (canonicalState.state !== 'meaningful' && fs.existsSync(legacyDb)) {
        const legacyCandidate = validMeaningfulDatabase(legacyDb);
        if (!legacyCandidate) throw new Error(`Legacy tenant database is unreadable, invalid or empty: ${legacyDb}`);
        assertTenantIdentity(legacyCandidate.payload, tenantId, `Legacy tenant database ${legacyDb}`);
        if (fs.existsSync(canonicalDb)) preserve(canonicalDb, path.join('canonical-before-migration', tenantId, 'db.json'));
        migrated.push({ kind: 'tenant-db', tenantId, from: legacyDb, to: canonicalDb, bytes: copyExact(legacyDb, canonicalDb) });
      }
      for (const file of legacyFiles) {
        if (file.relative === 'db.json') continue;
        const destination = path.join(canonicalTenantDir, file.relative);
        if (fs.existsSync(destination)) continue;
        migrated.push({ kind: 'tenant-ancillary', tenantId, from: file.full, to: destination, bytes: copyExact(file.full, destination) });
      }
    }
  }

  for (const item of migrated) logger.info(`[storage-path] Migrated ${item.kind}${item.tenantId ? ` ${item.tenantId}` : ''} to canonical storage (${item.bytes} bytes).`);
  return { migrated, count: migrated.length, skipped: false, markerPath: paths.legacyMigrationMarker, backupSession, legacyDetected: fs.existsSync(legacyAuthUsers) || fs.existsSync(legacyAuthBackup) || fs.existsSync(legacyTenantRoot) };
}

export function finalizeLegacyStorageMigration({ storageRoot, migrationResult, logger = console } = {}) {
  if (!migrationResult || migrationResult.skipped) return { finalized: false, reason: 'nothing-to-finalize' };
  const rawStorage = String(storageRoot || '').trim();
  if (!rawStorage) throw new Error('Storage root is required to finalize legacy migration.');
  const markerPath = path.join(path.resolve(rawStorage), LEGACY_MIGRATION_MARKER);
  writeAtomicJson(markerPath, { version: 1, completed: true, completedAt: new Date().toISOString(), migratedItems: Number(migrationResult.count || 0), legacyDetected: migrationResult.legacyDetected === true, backupSession: String(migrationResult.backupSession || '') });
  if (!readMigrationMarker(markerPath)) throw new Error(`Legacy migration marker verification failed: ${markerPath}`);
  logger.info(`[storage-path] Legacy migration finalized. Future startups will not reuse legacy paths: ${markerPath}`);
  return { finalized: true, markerPath };
}

export function restoreBundledDemoTenantIfNeeded({ sourceRoot, storageRoot, backupRoot, logger = console } = {}) {
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot });
  const liveDemo = paths.tenantDb('demo-company');
  const liveState = classifyDatabase(liveDemo);
  if (liveState.state === 'invalid') throw new Error(`Canonical demo-company database is unreadable or invalid JSON: ${liveDemo}`);
  if (liveState.state === 'meaningful') {
    assertTenantIdentity(liveState.payload, 'demo-company', `Canonical demo-company database ${liveDemo}`);
    if (hasMeaningfulDemoData(liveState.payload)) return { restored: false, reason: 'live-demo-present', liveDemo };
    logger.warn('[storage-path] Canonical demo-company database exists but contains no meaningful demo records; recovery is required.');
  }

  const legacyDemo = path.join(paths.storageRoot, 'tenants', 'clubs', 'demo-company', 'db.json');
  const bundledDemo = path.join(paths.repositoryStorage, 'tenants', 'demo-company', 'db.json');
  const markerFinalized = Boolean(readMigrationMarker(paths.legacyMigrationMarker));
  const rawLegacyCandidate = markerFinalized ? null : validMeaningfulDatabase(legacyDemo);
  if (rawLegacyCandidate) assertTenantIdentity(rawLegacyCandidate.payload, 'demo-company', `Legacy demo-company database ${legacyDemo}`);
  const legacyCandidate = rawLegacyCandidate && hasMeaningfulDemoData(rawLegacyCandidate.payload) ? rawLegacyCandidate : null;
  const bundledCandidate = validMeaningfulDemoDatabase(bundledDemo);
  if (bundledCandidate) assertTenantIdentity(bundledCandidate.payload, 'demo-company', `Bundled demo-company database ${bundledDemo}`);
  if (!bundledCandidate && fs.existsSync(bundledDemo)) throw new Error(`Bundled demo-company database contains no meaningful demo records: ${bundledDemo}`);

  const sourceCandidate = legacyCandidate || bundledCandidate;
  if (!sourceCandidate) throw new Error('No valid demo-company recovery database with meaningful demo records is available.');

  const backupDirectory = backupRoot ? path.join(path.resolve(backupRoot), 'demo-bootstrap-replaced') : '';
  if (backupDirectory) fs.mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (fs.existsSync(liveDemo) && backupDirectory) copyExact(liveDemo, path.join(backupDirectory, `${stamp}-canonical-demo-before-recovery.json`));
  if (rawLegacyCandidate && backupDirectory) copyExact(legacyDemo, path.join(backupDirectory, `${stamp}-legacy-demo-source-preserved.json`));

  const bytes = copyExact(sourceCandidate.filePath, liveDemo);
  const restored = validMeaningfulDemoDatabase(liveDemo);
  if (!restored || restored.stat.size !== sourceCandidate.stat.size) throw new Error('Demo-company recovery verification failed.');
  assertTenantIdentity(restored.payload, 'demo-company', `Recovered demo-company database ${liveDemo}`);
  const sourceLabel = legacyCandidate ? 'legacy-live' : 'bundled-seed';
  logger.info(`[storage-path] Restored demo-company database from ${sourceLabel} source (${bytes} bytes).`);
  return { restored: true, reason: 'live-demo-missing-empty-or-no-records', source: sourceLabel, liveDemo, bytes };
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
