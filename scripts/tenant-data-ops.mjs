import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_RETIRE_TENANTS = new Set(['global-owner', 'demo-company', 'snapshot-public']);
const TENANT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function clean(value) { return String(value ?? '').trim(); }
function canonicalTenantId(value) {
  const tenantId = clean(value).toLowerCase();
  if (!tenantId || tenantId !== clean(value) || !TENANT_PATTERN.test(tenantId)) {
    throw new Error(`Tenant ID must be canonical lowercase letters, numbers, underscores or hyphens: ${clean(value) || '(missing)'}`);
  }
  return tenantId;
}
function isWithin(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function requireSeparateRoots(primary, secondary, label) {
  const a = path.resolve(primary);
  const b = path.resolve(secondary);
  if (a === b || isWithin(a, b) || isWithin(b, a)) throw new Error(`${label} must be separate and non-nested from production storage.`);
}
function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { throw new Error(`${label} is not valid JSON: ${filePath}`); }
}
function authRows(value) {
  const rows = Array.isArray(value) ? value : (value && Array.isArray(value.users) ? value.users : null);
  if (!rows) throw new Error('Authentication user store has an unsupported shape.');
  return rows;
}
function assertTenantPayload(payload, tenantId, label) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`${label} must be a JSON object.`);
  const declared = clean(payload?.__meta?.tenantId);
  if (declared && declared !== tenantId) throw new Error(`${label} declares tenant ${declared}, expected ${tenantId}.`);
}
function sha256Bytes(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function sha256File(filePath) { return sha256Bytes(fs.readFileSync(filePath)); }
function durableWrite(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const handle = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  fs.renameSync(temp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
  try {
    const directory = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch {}
}
function writeJson(filePath, value) { durableWrite(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')); }
function ensureEmptyDestination(destination) {
  if (!fs.existsSync(destination)) return;
  if (!fs.statSync(destination).isDirectory()) throw new Error(`Destination exists and is not a directory: ${destination}`);
  if (fs.readdirSync(destination).length > 0) throw new Error(`Destination must be empty: ${destination}`);
}
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
  return output.sort((a, b) => a.relative.localeCompare(b.relative));
}
function sanitizeAccount(row) {
  const source = row && typeof row === 'object' ? row : {};
  const allowed = [
    'username', 'email', 'role', 'tenantId', 'clubId', 'swimClub', 'teamName', 'createdVia',
    'createdAt', 'updatedAt', 'isApproved', 'approvedAt', 'approvedBy', 'disabled',
    'onboardingCompletedAt', 'onboardingComplete', 'referredByUsername', 'referralCode', 'billing',
  ];
  return Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(source, key)).map((key) => [key, source[key]]));
}
function readLegalAcceptanceRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Legal acceptance journal contains invalid JSON at line ${index + 1}.`); }
  });
}
function operationManifest({ operation, tenantId, files, extra = {} }) {
  return {
    version: 1,
    operation,
    tenantId,
    createdAt: new Date().toISOString(),
    files: files.map(({ relative, full }) => ({ path: relative.replaceAll(path.sep, '/'), bytes: fs.statSync(full).size, sha256: sha256File(full) })),
    ...extra,
  };
}

export function exportTenantData({ tenantId: rawTenantId, storageRoot: rawStorageRoot, destination: rawDestination } = {}) {
  const tenantId = canonicalTenantId(rawTenantId);
  const storageRoot = path.resolve(clean(rawStorageRoot));
  const destination = path.resolve(clean(rawDestination));
  if (!clean(rawStorageRoot)) throw new Error('Storage root is required.');
  if (!clean(rawDestination)) throw new Error('Export destination is required.');
  if (isWithin(destination, storageRoot)) throw new Error('Export destination must be outside production storage.');
  ensureEmptyDestination(destination);

  const tenantDb = path.join(storageRoot, 'tenants', tenantId, 'db.json');
  const tenantPayload = readJson(tenantDb, `Tenant database ${tenantId}`);
  assertTenantPayload(tenantPayload, tenantId, `Tenant database ${tenantId}`);

  const authPath = path.join(storageRoot, 'auth', 'auth-users.json');
  const accounts = authRows(readJson(authPath, 'Authentication user store'))
    .filter((row) => clean(row?.tenantId) === tenantId)
    .map(sanitizeAccount);
  const legalRows = readLegalAcceptanceRows(path.join(storageRoot, 'legal-acceptances.jsonl'))
    .filter((row) => clean(row?.tenantId) === tenantId);

  fs.mkdirSync(destination, { recursive: true });
  writeJson(path.join(destination, 'tenant-data.json'), tenantPayload);
  writeJson(path.join(destination, 'accounts.json'), accounts);
  durableWrite(path.join(destination, 'legal-acceptances.jsonl'), Buffer.from(legalRows.map((row) => JSON.stringify(row)).join('\n') + (legalRows.length ? '\n' : ''), 'utf8'));

  const dataFiles = listFilesRecursive(destination);
  const manifest = operationManifest({
    operation: 'tenant-data-export', tenantId, files: dataFiles,
    extra: { accountCount: accounts.length, legalAcceptanceCount: legalRows.length },
  });
  writeJson(path.join(destination, 'manifest.json'), manifest);
  console.log(`ATHLYRAX_TENANT_EXPORT_OK tenant=${tenantId} files=${manifest.files.length} accounts=${accounts.length} legal=${legalRows.length}`);
  return { destination, manifest };
}

export function retireTenantData({ tenantId: rawTenantId, storageRoot: rawStorageRoot, backupRoot: rawBackupRoot } = {}) {
  const tenantId = canonicalTenantId(rawTenantId);
  if (FORBIDDEN_RETIRE_TENANTS.has(tenantId)) throw new Error(`Tenant ${tenantId} cannot be retired by this operator tool.`);
  const storageRoot = path.resolve(clean(rawStorageRoot));
  const backupRoot = path.resolve(clean(rawBackupRoot));
  if (!clean(rawStorageRoot) || !clean(rawBackupRoot)) throw new Error('Storage root and backup root are required.');
  requireSeparateRoots(storageRoot, backupRoot, 'Backup root');

  const tenantDir = path.join(storageRoot, 'tenants', tenantId);
  const tenantDb = path.join(tenantDir, 'db.json');
  const payload = readJson(tenantDb, `Tenant database ${tenantId}`);
  assertTenantPayload(payload, tenantId, `Tenant database ${tenantId}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(backupRoot, 'retired-tenants', tenantId, stamp);
  if (fs.existsSync(archiveDir)) throw new Error(`Retirement archive already exists: ${archiveDir}`);
  fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
  fs.cpSync(tenantDir, archiveDir, { recursive: true, errorOnExist: true, force: false });

  const sourceFiles = listFilesRecursive(tenantDir);
  const archivedFiles = listFilesRecursive(archiveDir);
  if (sourceFiles.length !== archivedFiles.length) throw new Error('Retirement archive file count verification failed.');
  const archiveByRelative = new Map(archivedFiles.map((row) => [row.relative, row]));
  for (const source of sourceFiles) {
    const archived = archiveByRelative.get(source.relative);
    if (!archived || sha256File(source.full) !== sha256File(archived.full)) throw new Error(`Retirement archive verification failed for ${source.relative}.`);
  }

  const manifest = operationManifest({ operation: 'tenant-data-retirement', tenantId, files: archivedFiles, extra: { livePath: tenantDir } });
  writeJson(path.join(archiveDir, 'retirement-manifest.json'), manifest);

  fs.rmSync(tenantDir, { recursive: true, force: false });
  if (fs.existsSync(tenantDir)) throw new Error('Live tenant directory still exists after retirement.');
  try {
    const parent = fs.openSync(path.dirname(tenantDir), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } catch {}

  console.log(`ATHLYRAX_TENANT_RETIRE_OK tenant=${tenantId} archive=${archiveDir} files=${archivedFiles.length}`);
  console.log(`ATHLYRAX_TENANT_RETIRE_NEXT_ACTION remove_or_disable_auth_accounts_for=${tenantId}`);
  return { archiveDir, manifest };
}

export function purgeRetiredTenantArchive({ tenantId: rawTenantId, backupRoot: rawBackupRoot, archive: rawArchive } = {}) {
  const tenantId = canonicalTenantId(rawTenantId);
  const backupRoot = path.resolve(clean(rawBackupRoot));
  const archive = path.resolve(clean(rawArchive));
  if (!clean(rawBackupRoot) || !clean(rawArchive)) throw new Error('Backup root and archive path are required.');
  const expectedRoot = path.join(backupRoot, 'retired-tenants', tenantId);
  if (!isWithin(archive, expectedRoot) || archive === expectedRoot) throw new Error('Archive path is outside the selected tenant retirement root.');

  const manifestPath = path.join(archive, 'retirement-manifest.json');
  const manifest = readJson(manifestPath, 'Retirement manifest');
  if (manifest?.operation !== 'tenant-data-retirement' || manifest?.tenantId !== tenantId || !Array.isArray(manifest?.files)) {
    throw new Error('Retirement manifest does not match the requested tenant archive.');
  }
  for (const row of manifest.files) {
    const relative = clean(row?.path);
    const expectedHash = clean(row?.sha256);
    const filePath = path.join(archive, ...relative.split('/'));
    if (!relative || !isWithin(filePath, archive) || !fs.existsSync(filePath) || sha256File(filePath) !== expectedHash) {
      throw new Error(`Retirement archive integrity verification failed before purge: ${relative || '(missing path)'}.`);
    }
  }

  fs.rmSync(archive, { recursive: true, force: false });
  if (fs.existsSync(archive)) throw new Error('Retirement archive still exists after purge.');
  console.log(`ATHLYRAX_TENANT_RETIRED_ARCHIVE_PURGE_OK tenant=${tenantId}`);
  return { tenantId, archive };
}

function parseCli(argv) {
  const [command = '', ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function runCli() {
  const options = parseCli(process.argv.slice(2));
  const storageRoot = clean(options['storage-root'] || process.env.ATHLYRAX_STORAGE_ROOT);
  const backupRoot = clean(options['backup-root'] || process.env.ATHLYRAX_SAFETY_BACKUP_ROOT);
  if (options.command === 'export') {
    if (options.approve !== 'EXPORT_TENANT_DATA') throw new Error('Explicit approval is required: --approve EXPORT_TENANT_DATA');
    exportTenantData({ tenantId: options.tenant, storageRoot, destination: options.destination });
    return;
  }
  if (options.command === 'retire') {
    if (options.approve !== 'RETIRE_TENANT_DATA') throw new Error('Explicit approval is required: --approve RETIRE_TENANT_DATA');
    retireTenantData({ tenantId: options.tenant, storageRoot, backupRoot });
    return;
  }
  if (options.command === 'purge-retired') {
    if (options.approve !== 'PURGE_RETIRED_TENANT_ARCHIVE') throw new Error('Explicit approval is required: --approve PURGE_RETIRED_TENANT_ARCHIVE');
    purgeRetiredTenantArchive({ tenantId: options.tenant, backupRoot, archive: options.archive });
    return;
  }
  throw new Error('Command must be one of: export, retire, purge-retired.');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try { runCli(); }
  catch (error) { console.error(error?.message || error); process.exit(1); }
}
