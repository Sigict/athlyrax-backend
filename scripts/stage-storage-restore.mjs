import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256File } from './storage-safety-lib.mjs';
import { canonicalStoragePaths } from './storage-path-contract.mjs';

function usage() {
  console.error([
    'Usage:',
    '  node scripts/stage-storage-restore.mjs',
    '    --destination <empty-stage-directory>',
    '    --global-db <exported-global-db.json>',
    '    --tenant <tenantId>=<exported-tenant-db.json>   (repeatable)',
    '    --approve STAGE_ONLY',
    '',
    'This script stages API-exported databases only. It never reads Render,',
    'never activates production storage, and refuses a non-empty destination.',
  ].join('\n'));
}

function parseArgs(argv) {
  const result = { tenants: [] };
  const singleUse = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Unknown or incomplete argument: ${key}`);
    if (key === '--tenant') { result.tenants.push(value); index += 1; }
    else if (['--destination', '--global-db', '--approve'].includes(key)) {
      if (singleUse.has(key)) throw new Error(`Duplicate argument: ${key}`);
      singleUse.add(key);
      if (key === '--destination') result.destination = value;
      else if (key === '--global-db') result.globalDb = value;
      else result.approve = value;
      index += 1;
    } else throw new Error(`Unknown or incomplete argument: ${key}`);
  }
  return result;
}

function normalizeTenantId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}
function requireCanonicalTenantId(value, label = 'tenant ID') {
  const raw = String(value || '').trim();
  const normalized = normalizeTenantId(raw);
  if (!normalized || raw !== normalized || !/^[a-z0-9_-]+$/.test(raw)) throw new Error(`Noncanonical ${label}: ${raw}`);
  return raw;
}
function assertRegularNonSymlinkFile(filePath, label) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`${label} not found: ${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${resolved}`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${resolved}`);
  return resolved;
}
function assertSafeDestination(destination) {
  const resolved = path.resolve(destination);
  if (resolved === path.parse(resolved).root) throw new Error('The staging script refuses filesystem roots.');
  const posix = resolved.replace(/\\/g, '/');
  if (posix === '/opt/render' || posix.startsWith('/opt/render/') || posix === '/var/data' || posix.startsWith('/var/data/')) {
    throw new Error('The staging script refuses Render paths and production disk paths.');
  }
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new Error(`Destination must not be a symbolic link: ${resolved}`);
    if (!stat.isDirectory()) throw new Error(`Destination must be a directory: ${resolved}`);
    if (fs.readdirSync(resolved).length > 0) throw new Error(`Destination must be empty: ${resolved}`);
  }
  return resolved;
}
function readValidatedJsonObject(filePath, label, expectedTenantId = '') {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must contain a JSON object: ${filePath}`);
  if (Object.keys(parsed).length === 0) throw new Error(`${label} must not be empty: ${filePath}`);
  if (expectedTenantId) {
    const expected = requireCanonicalTenantId(expectedTenantId, 'restore tenant ID');
    const declaredRaw = String(parsed?.__meta?.tenantId || '').trim();
    if (declaredRaw) {
      const declared = requireCanonicalTenantId(declaredRaw, 'declared tenant ID');
      if (declared !== expected) throw new Error(`${label} declares tenant ${declared} but restore mapping is ${expected}.`);
    }
  }
  return parsed;
}

function copyValidatedJson(source, destination, label, expectedTenantId = '') {
  const resolvedSource = assertRegularNonSymlinkFile(source, label);
  readValidatedJsonObject(resolvedSource, label, expectedTenantId);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const bytes = fs.readFileSync(resolvedSource);
  const temp = `${destination}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
  try { fs.renameSync(temp, destination); }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
  const copied = fs.readFileSync(destination);
  if (!bytes.equals(copied)) throw new Error(`Staged copy verification failed: ${resolvedSource}`);
  try {
    const directoryHandle = fs.openSync(path.dirname(destination), 'r');
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
  } catch {}
  return { source: resolvedSource, destination, bytes: copied.length, sha256: sha256File(destination) };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.approve !== 'STAGE_ONLY') throw new Error('Explicit approval is required: --approve STAGE_ONLY');
  if (!args.destination || !args.globalDb) { usage(); process.exit(2); }

  const destination = assertSafeDestination(args.destination);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(destination).isSymbolicLink()) throw new Error(`Destination became a symbolic link: ${destination}`);

  const paths = canonicalStoragePaths({ sourceRoot: process.cwd(), storageRoot: destination });
  const files = [copyValidatedJson(args.globalDb, paths.globalDb, 'Global database')];
  const tenantIds = [];
  const seenTenantIds = new Set();

  for (const tenantSpec of args.tenants) {
    const separator = String(tenantSpec || '').indexOf('=');
    if (separator <= 0) throw new Error(`Invalid --tenant mapping: ${tenantSpec}`);
    const tenantId = requireCanonicalTenantId(tenantSpec.slice(0, separator).trim(), 'tenant mapping ID');
    const source = tenantSpec.slice(separator + 1).trim();
    if (!source) throw new Error(`Missing tenant source file for ${tenantId}.`);
    const dbPath = paths.tenantDb(tenantId);
    if (seenTenantIds.has(tenantId)) throw new Error(`Duplicate --tenant mapping: ${tenantId}`);
    seenTenantIds.add(tenantId);
    tenantIds.push(tenantId);
    files.push(copyValidatedJson(source, dbPath, `Tenant database ${tenantId}`, tenantId));
  }

  const manifest = {
    stagedAt: new Date().toISOString(),
    mode: 'api-export-stage-only',
    tenantIds,
    files,
    missingByDesign: [
      'auth/auth-users.json',
      'auth/auth-users.backup.json',
      'auth-invites.json',
      'trainingPlannerTargets.backup.json',
      'tenant trainingPlannerTargets.backup.json files',
      'db-snapshots',
      'auth-audit backups',
      'billing-catalog backups',
    ],
  };
  const manifestPath = path.join(destination, 'staged-restore-manifest.json');
  const manifestHandle = fs.openSync(manifestPath, 'wx', 0o600);
  try {
    fs.writeFileSync(manifestHandle, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.fsyncSync(manifestHandle);
  } finally {
    fs.closeSync(manifestHandle);
  }
  try {
    const directoryHandle = fs.openSync(destination, 'r');
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
  } catch {}

  console.log('ATHLYRAX_STORAGE_RESTORE_STAGED');
  console.log(`Destination: ${destination}`);
  console.log(`Files staged: ${files.length}`);
  console.log('Production activation: NOT PERFORMED');
  console.log('Storage approval marker: NOT CREATED');
} catch (error) {
  console.error('ATHLYRAX_STORAGE_RESTORE_STAGE_FAILED');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
