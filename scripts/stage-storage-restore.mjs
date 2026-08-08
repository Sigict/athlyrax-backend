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
function parseValidatedJsonBytes(bytes, label, sourcePath, expectedTenantId = '') {
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must contain a JSON object: ${sourcePath}`);
  if (Object.keys(parsed).length === 0) throw new Error(`${label} must not be empty: ${sourcePath}`);
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
function validatedSource(filePath, label, expectedTenantId = '') {
  const source = assertRegularNonSymlinkFile(filePath, label);
  const bytes = fs.readFileSync(source);
  parseValidatedJsonBytes(bytes, label, source, expectedTenantId);
  return { source, bytes, label, expectedTenantId };
}
function writeValidatedBytes(plan, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(handle, plan.bytes);
    fs.fsyncSync(handle);
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
  try { fs.renameSync(temp, destination); }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
  const copied = fs.readFileSync(destination);
  if (!plan.bytes.equals(copied)) throw new Error(`Staged copy verification failed: ${plan.source}`);
  try {
    const directoryHandle = fs.openSync(path.dirname(destination), 'r');
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
  } catch {}
  return { source: plan.source, destination, bytes: copied.length, sha256: sha256File(destination) };
}
function fsyncDirectory(directory) {
  try {
    const handle = fs.openSync(directory, 'r');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  } catch {}
}

let workDirectory = '';
let originalDestinationExisted = false;
let destination = '';
try {
  const args = parseArgs(process.argv.slice(2));
  if (args.approve !== 'STAGE_ONLY') throw new Error('Explicit approval is required: --approve STAGE_ONLY');
  if (!args.destination || !args.globalDb) { usage(); process.exit(2); }

  destination = assertSafeDestination(args.destination);
  originalDestinationExisted = fs.existsSync(destination);

  // ATHLYRAX_STAGE_RESTORE_VALIDATE_ALL_BEFORE_WRITE
  // Freeze validated source bytes before creating any staging output so a bad
  // tenant mapping cannot leave a partially staged restore behind.
  const globalPlan = validatedSource(args.globalDb, 'Global database', 'global-owner');
  const tenantPlans = [];
  const tenantIds = [];
  const seenTenantIds = new Set();
  for (const tenantSpec of args.tenants) {
    const separator = String(tenantSpec || '').indexOf('=');
    if (separator <= 0) throw new Error(`Invalid --tenant mapping: ${tenantSpec}`);
    const tenantId = requireCanonicalTenantId(tenantSpec.slice(0, separator).trim(), 'tenant mapping ID');
    const source = tenantSpec.slice(separator + 1).trim();
    if (!source) throw new Error(`Missing tenant source file for ${tenantId}.`);
    if (seenTenantIds.has(tenantId)) throw new Error(`Duplicate --tenant mapping: ${tenantId}`);
    seenTenantIds.add(tenantId);
    tenantIds.push(tenantId);
    tenantPlans.push({ tenantId, ...validatedSource(source, `Tenant database ${tenantId}`, tenantId) });
  }

  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  workDirectory = path.join(parent, `.${path.basename(destination)}.athlyrax-stage-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(workDirectory, { recursive: false, mode: 0o700 });
  if (fs.lstatSync(workDirectory).isSymbolicLink()) throw new Error(`Work directory became a symbolic link: ${workDirectory}`);

  const paths = canonicalStoragePaths({ sourceRoot: process.cwd(), storageRoot: workDirectory });
  const files = [writeValidatedBytes(globalPlan, paths.globalDb)];
  for (const plan of tenantPlans) files.push(writeValidatedBytes(plan, paths.tenantDb(plan.tenantId)));

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
  const manifestPath = path.join(workDirectory, 'staged-restore-manifest.json');
  const manifestHandle = fs.openSync(manifestPath, 'wx', 0o600);
  try {
    fs.writeFileSync(manifestHandle, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.fsyncSync(manifestHandle);
  } finally { fs.closeSync(manifestHandle); }
  fsyncDirectory(workDirectory);

  // ATHLYRAX_STAGE_RESTORE_ATOMIC_DIRECTORY_COMMIT
  // The destination is either absent or confirmed empty. Commit the completed
  // staging tree in one directory rename so callers never observe a partial set.
  if (originalDestinationExisted) fs.rmdirSync(destination);
  try {
    fs.renameSync(workDirectory, destination);
    workDirectory = '';
  } catch (error) {
    if (originalDestinationExisted && !fs.existsSync(destination)) fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    throw error;
  }
  fsyncDirectory(parent);

  console.log('ATHLYRAX_STORAGE_RESTORE_STAGED');
  console.log(`Destination: ${destination}`);
  console.log(`Files staged: ${files.length}`);
  console.log('Production activation: NOT PERFORMED');
  console.log('Storage approval marker: NOT CREATED');
} catch (error) {
  if (workDirectory && fs.existsSync(workDirectory)) {
    try { fs.rmSync(workDirectory, { recursive: true, force: true }); } catch {}
  }
  console.error('ATHLYRAX_STORAGE_RESTORE_STAGE_FAILED');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
