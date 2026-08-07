import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  resolveStorageConfiguration,
  runStorageSafetyCheck,
  sha256File,
  writeStorageReadyMarker,
} from './storage-safety-lib.mjs';
import {
  assertCanonicalPathContract,
  canonicalStoragePaths,
  finalizeLegacyStorageMigration,
  migrateLegacyStorageIfNeeded,
  restoreBundledDemoTenantIfNeeded,
} from './storage-path-contract.mjs';
import { sanitizeDemoTenantDatabase } from './demo-data-sanitizer.mjs';
import { assertNoSymlinkStorageLayout } from './storage-path-integrity.mjs';
import {
  activeMigrationTransactionPath,
  readActiveMigrationTransaction,
} from './migration-transaction-state.mjs';

const APPROVAL = 'MIGRATE_CANONICAL_STORAGE_ONCE';
let transaction = null;

function parseArgs(argv) {
  if (argv.length % 2 !== 0) throw new Error(`Incomplete argument: ${argv[argv.length - 1]}`);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = String(argv[index] || '').trim();
    if (!key.startsWith('--')) throw new Error(`Invalid argument: ${key}`);
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`Duplicate argument: ${key}`);
    result[key] = argv[index + 1];
  }
  return result;
}
function clean(value) { return String(value ?? '').trim(); }
function normalizeTenantId(value) { return clean(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''); }
function slugTenantPart(value, fallback = 'default') { const normalized = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); return normalized || fallback; }
function isCanonicalTenantId(value) { const raw = clean(value); return Boolean(raw) && /^[a-z0-9_-]+$/.test(raw) && normalizeTenantId(raw) === raw; }
function readJson(filePath, label) { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { throw new Error(`${label} is not valid JSON: ${filePath}`); } }
function authUsersFrom(value) { return Array.isArray(value) ? value : (value && Array.isArray(value.users) ? value.users : null); }
function canonicalJson(value) { if (Array.isArray(value)) return value.map(canonicalJson); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])])); return value; }
function resolveTenantFromUser(user, env) {
  const role = clean(user?.role).toLowerCase();
  const username = clean(user?.username).toLowerCase();
  const primaryOwner = clean(env.AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME || 'softwareowner').toLowerCase();
  if (username === 'demo.coach') return 'demo-company';
  if (role === 'software-owner' && username === primaryOwner) return '';
  if (role === 'swimmer' && normalizeTenantId(user?.tenantId) === 'snapshot-public' && clean(user?.createdVia) === 'snapshot-self-signup') return '';
  const explicit = normalizeTenantId(user?.tenantId);
  if (explicit) return explicit;
  const swimClub = clean(user?.swimClub);
  const teamName = clean(user?.teamName);
  if (swimClub && teamName) return `${slugTenantPart(swimClub, 'club')}__${slugTenantPart(teamName, 'team')}`;
  return username ? `user-${slugTenantPart(username, 'unknown-user')}` : '';
}
function assertMeaningfulDb(filePath, label, expectedTenantId = '') {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
  const parsed = readJson(filePath, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) throw new Error(`${label} must contain a non-empty JSON object: ${filePath}`);
  if (expectedTenantId) {
    const declaredRaw = clean(parsed?.__meta?.tenantId);
    if (declaredRaw) {
      if (!isCanonicalTenantId(declaredRaw)) throw new Error(`${label} declares noncanonical tenant ${declaredRaw}.`);
      if (declaredRaw !== expectedTenantId) throw new Error(`${label} declares tenant ${declaredRaw} but belongs to ${expectedTenantId}. Refusing cross-tenant activation.`);
    }
  }
  return parsed;
}
function listFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const rows = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link found during migration transaction scan: ${full}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) rows.push(full);
    }
  };
  visit(rootDir);
  return rows;
}
function fsyncDirectory(directory) {
  try {
    const handle = fs.openSync(directory, 'r');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  } catch {}
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
  fsyncDirectory(path.dirname(destination));
}
function durableWriteJson(destination, value) {
  durableWriteBytes(destination, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}
function durableCopy(source, destination) {
  const bytes = fs.readFileSync(source);
  durableWriteBytes(destination, bytes);
  if (!bytes.equals(fs.readFileSync(destination))) throw new Error(`Transaction copy verification failed: ${source} -> ${destination}`);
}
function assertInside(candidate, parent, label) {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedParent, resolvedCandidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} must be inside ${resolvedParent}: ${resolvedCandidate}`);
  return resolvedCandidate;
}
function validateTransactionManifest(manifest, storageRoot, snapshotRoot) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.version !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`Migration transaction manifest is invalid: ${snapshotRoot}`);
  }
  if (path.resolve(String(manifest.storageRoot || '')) !== path.resolve(storageRoot)) throw new Error('Migration transaction manifest belongs to a different storage root.');
  const normalized = [];
  const seen = new Set();
  for (const item of manifest.files) {
    const relative = String(item?.relative || '').trim();
    if (!relative || path.isAbsolute(relative) || relative.startsWith('..') || relative.split(path.sep).includes('..')) throw new Error(`Unsafe transaction manifest path: ${relative}`);
    if (seen.has(relative)) throw new Error(`Duplicate transaction manifest path: ${relative}`);
    seen.add(relative);
    const sha256 = String(item?.sha256 || '').trim();
    const bytes = Number(item?.bytes);
    if (!/^[a-f0-9]{64}$/i.test(sha256) || !Number.isFinite(bytes) || bytes < 0) throw new Error(`Invalid transaction manifest metadata: ${relative}`);
    const snapshotFile = assertInside(path.join(snapshotRoot, relative), snapshotRoot, 'Transaction snapshot file');
    if (!fs.existsSync(snapshotFile) || !fs.statSync(snapshotFile).isFile()) throw new Error(`Transaction snapshot file is missing: ${relative}`);
    if (fs.statSync(snapshotFile).size !== bytes || sha256File(snapshotFile) !== sha256) throw new Error(`Transaction snapshot verification failed: ${relative}`);
    normalized.push({ relative, sha256, bytes });
  }
  return normalized;
}
function restoreManifest(storageRoot, snapshotRoot, manifest) {
  const files = validateTransactionManifest(manifest, storageRoot, snapshotRoot);
  const originalSet = new Set(files.map((item) => item.relative));
  for (const current of listFiles(storageRoot)) {
    const relative = path.relative(storageRoot, current);
    if (!originalSet.has(relative)) fs.unlinkSync(current);
  }
  for (const item of files) {
    const destination = assertInside(path.join(storageRoot, item.relative), storageRoot, 'Rollback destination');
    durableCopy(path.join(snapshotRoot, item.relative), destination);
    if (fs.statSync(destination).size !== item.bytes || sha256File(destination) !== item.sha256) throw new Error(`Migration rollback verification failed: ${item.relative}`);
  }
  return files.length;
}
function recoverInterruptedTransaction(storageRoot, backupRoot) {
  const active = readActiveMigrationTransaction(backupRoot, fs);
  if (!active) return { recovered: false };
  if (path.resolve(String(active.storageRoot || '')) !== path.resolve(storageRoot)) throw new Error('Active migration transaction belongs to a different storage root.');
  const snapshotRoot = assertInside(String(active.snapshotRoot || ''), backupRoot, 'Migration transaction snapshot root');
  const manifestPath = assertInside(path.join(snapshotRoot, 'transaction-manifest.json'), snapshotRoot, 'Migration transaction manifest');
  const manifest = readJson(manifestPath, 'Migration transaction manifest');
  const restoredFiles = restoreManifest(storageRoot, snapshotRoot, manifest);
  fs.unlinkSync(active.journalPath);
  fsyncDirectory(path.dirname(active.journalPath));
  console.warn(`[storage-migration] Recovered interrupted migration transaction from ${snapshotRoot} (${restoredFiles} files restored).`);
  return { recovered: true, snapshotRoot, restoredFiles };
}
function beginTransaction(storageRoot, backupRoot) {
  if (!fs.existsSync(storageRoot) || !fs.statSync(storageRoot).isDirectory()) throw new Error(`Storage root is missing before migration: ${storageRoot}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotRoot = path.join(path.resolve(backupRoot), 'migration-transaction-snapshots', `${stamp}-${crypto.randomBytes(4).toString('hex')}`);
  const originalFiles = listFiles(storageRoot).map((full) => path.relative(storageRoot, full));
  const manifest = [];
  for (const relative of originalFiles) {
    const source = path.join(storageRoot, relative);
    const destination = path.join(snapshotRoot, relative);
    durableCopy(source, destination);
    manifest.push({ relative, sha256: sha256File(source), bytes: fs.statSync(source).size });
  }
  fs.mkdirSync(snapshotRoot, { recursive: true });
  const manifestPath = path.join(snapshotRoot, 'transaction-manifest.json');
  durableWriteJson(manifestPath, { version: 1, createdAt: new Date().toISOString(), storageRoot: path.resolve(storageRoot), files: manifest });
  validateTransactionManifest(readJson(manifestPath, 'Migration transaction manifest'), storageRoot, snapshotRoot);
  const journalPath = activeMigrationTransactionPath(backupRoot);
  durableWriteJson(journalPath, {
    version: 1,
    active: true,
    createdAt: new Date().toISOString(),
    storageRoot: path.resolve(storageRoot),
    snapshotRoot: path.resolve(snapshotRoot),
  });
  return { storageRoot: path.resolve(storageRoot), snapshotRoot, manifest, journalPath, committed: false };
}
function rollbackTransaction(tx) {
  if (!tx || tx.committed) return;
  restoreManifest(tx.storageRoot, tx.snapshotRoot, { version: 1, storageRoot: tx.storageRoot, files: tx.manifest });
  if (fs.existsSync(tx.journalPath)) {
    fs.unlinkSync(tx.journalPath);
    fsyncDirectory(path.dirname(tx.journalPath));
  }
}
function commitTransaction(tx) {
  if (!tx || tx.committed) return;
  if (fs.existsSync(tx.journalPath)) {
    fs.unlinkSync(tx.journalPath);
    fsyncDirectory(path.dirname(tx.journalPath));
  }
  tx.committed = true;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args['--approve'] !== APPROVAL) throw new Error(`Explicit approval is required: --approve ${APPROVAL}`);
  if (clean(process.env.NODE_ENV).toLowerCase() !== 'production') throw new Error('One-time storage migration requires NODE_ENV=production.');

  const __filename = fileURLToPath(import.meta.url);
  const sourceRoot = path.resolve(path.dirname(__filename), '..');
  const repoRoot = sourceRoot;
  const entryPath = path.join(sourceRoot, 'index.js');
  const indexSource = fs.readFileSync(entryPath, 'utf8');
  const configuration = resolveStorageConfiguration(process.env, repoRoot);
  if (configuration.failures.length > 0) { const error = new Error(configuration.failures.join('\n')); error.code = 'ATHLYRAX_STORAGE_CONFIGURATION_INVALID'; throw error; }

  assertCanonicalPathContract({ sourceRoot, storageRoot: configuration.storageRoot, indexSource });
  assertNoSymlinkStorageLayout(configuration, fs);
  recoverInterruptedTransaction(configuration.storageRoot, configuration.backupRoot);
  assertNoSymlinkStorageLayout(configuration, fs);
  const paths = canonicalStoragePaths({ sourceRoot, storageRoot: configuration.storageRoot });

  const legacyAuthUsers = path.join(configuration.storageRoot, 'auth-users.json');
  const legacyAuthBackup = path.join(configuration.storageRoot, 'auth-users.backup.json');
  const anyAuthPrimaryExists = fs.existsSync(paths.authUsers) || fs.existsSync(legacyAuthUsers);
  const anyIndependentAuthBackupExists = fs.existsSync(paths.authUsersBackup) || fs.existsSync(legacyAuthBackup);
  if (anyAuthPrimaryExists && !anyIndependentAuthBackupExists) {
    const error = new Error('Authentication data exists but no independent authentication backup exists. Refusing to manufacture a backup from the primary store.');
    error.code = 'ATHLYRAX_AUTH_BACKUP_MISSING';
    throw error;
  }

  transaction = beginTransaction(configuration.storageRoot, configuration.backupRoot);

  const migration = migrateLegacyStorageIfNeeded({ sourceRoot, storageRoot: configuration.storageRoot, backupRoot: configuration.backupRoot });
  const demoRecovery = restoreBundledDemoTenantIfNeeded({ sourceRoot, storageRoot: configuration.storageRoot, backupRoot: configuration.backupRoot });
  const demoSanitization = sanitizeDemoTenantDatabase({ filePath: paths.tenantDb('demo-company'), backupRoot: configuration.backupRoot });

  assertMeaningfulDb(paths.globalDb, 'Global database');
  const primaryUsers = authUsersFrom(readJson(paths.authUsers, 'Authentication user store'));
  const backupUsers = authUsersFrom(readJson(paths.authUsersBackup, 'Authentication user backup'));
  if (!primaryUsers || primaryUsers.length === 0) throw new Error('Authentication user store must contain at least one user.');
  if (!backupUsers || backupUsers.length === 0) throw new Error('Authentication user backup must contain at least one user.');
  if (JSON.stringify(canonicalJson(primaryUsers)) !== JSON.stringify(canonicalJson(backupUsers))) throw new Error('Authentication primary and backup stores differ after migration. Refusing activation.');

  const requiredTenants = [...new Set(primaryUsers.map((user) => resolveTenantFromUser(user, process.env)).filter(Boolean))].sort();
  for (const tenantId of requiredTenants) {
    if (!isCanonicalTenantId(tenantId)) throw new Error(`Noncanonical tenant ID after migration: ${tenantId}`);
    assertMeaningfulDb(paths.tenantDb(tenantId), `Tenant database ${tenantId}`, tenantId);
  }

  const verifiedFiles = [
    { path: paths.globalDb, sha256: sha256File(paths.globalDb), bytes: fs.statSync(paths.globalDb).size },
    { path: paths.authUsers, sha256: sha256File(paths.authUsers), bytes: fs.statSync(paths.authUsers).size },
    { path: paths.authUsersBackup, sha256: sha256File(paths.authUsersBackup), bytes: fs.statSync(paths.authUsersBackup).size },
    ...requiredTenants.map((tenantId) => { const filePath = paths.tenantDb(tenantId); return { path: filePath, sha256: sha256File(filePath), bytes: fs.statSync(filePath).size, tenantId }; }),
  ];

  writeStorageReadyMarker(configuration.storageRoot, { migrationApproval: APPROVAL, requiredTenants, verifiedFiles });
  runStorageSafetyCheck({ repoRoot, requireFiles: true, createDirectories: false });
  finalizeLegacyStorageMigration({ storageRoot: configuration.storageRoot, migrationResult: migration });
  commitTransaction(transaction);

  console.log('ATHLYRAX_STORAGE_MIGRATION_OK');
  console.log(`Canonical storage: ${configuration.storageRoot}`);
  console.log(`Required tenants: ${requiredTenants.join(', ') || '(none)'}`);
  console.log(`Migrated items: ${migration.count || 0}`);
  console.log(`Demo recovery: ${demoRecovery.restored ? demoRecovery.source : demoRecovery.reason}`);
  console.log(`Demo sanitization: ${demoSanitization.sanitized ? 'sanitized' : demoSanitization.reason}`);
  console.log(`Rollback snapshot: ${transaction.snapshotRoot}`);
} catch (error) {
  if (transaction && !transaction.committed) {
    try {
      rollbackTransaction(transaction);
      console.error(`[storage-migration] Migration failed; original storage was restored from ${transaction.snapshotRoot}.`);
    } catch (rollbackError) {
      console.error('[storage-migration] CRITICAL: automatic rollback failed:', rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
    }
  }
  console.error('ATHLYRAX_STORAGE_MIGRATION_FAILED');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
