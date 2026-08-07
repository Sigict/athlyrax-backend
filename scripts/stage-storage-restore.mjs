import fs from 'node:fs';
import path from 'node:path';
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
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--tenant') { result.tenants.push(value); index += 1; }
    else if (key === '--destination') { result.destination = value; index += 1; }
    else if (key === '--global-db') { result.globalDb = value; index += 1; }
    else if (key === '--approve') { result.approve = value; index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${key}`);
  }
  return result;
}

function assertJsonObject(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Expected a JSON object: ${filePath}`);
}

function copyValidatedJson(source, destination) {
  const resolvedSource = path.resolve(source);
  if (!fs.existsSync(resolvedSource)) throw new Error(`Source file not found: ${resolvedSource}`);
  assertJsonObject(resolvedSource);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(resolvedSource, destination);
  return { source: resolvedSource, destination, bytes: fs.statSync(destination).size, sha256: sha256File(destination) };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.approve !== 'STAGE_ONLY') throw new Error('Explicit approval is required: --approve STAGE_ONLY');
  if (!args.destination || !args.globalDb) { usage(); process.exit(2); }

  const destination = path.resolve(args.destination);
  if (destination === '/' || destination.startsWith('/opt/render/') || destination.startsWith('/var/data')) {
    throw new Error('The staging script refuses Render and production disk paths.');
  }
  if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) throw new Error(`Destination must be empty: ${destination}`);
  fs.mkdirSync(destination, { recursive: true });

  const paths = canonicalStoragePaths({ sourceRoot: process.cwd(), storageRoot: destination });
  const files = [copyValidatedJson(args.globalDb, paths.globalDb)];
  const tenantIds = [];

  for (const tenantSpec of args.tenants) {
    const separator = String(tenantSpec || '').indexOf('=');
    if (separator <= 0) throw new Error(`Invalid --tenant mapping: ${tenantSpec}`);
    const tenantId = tenantSpec.slice(0, separator).trim();
    const source = tenantSpec.slice(separator + 1).trim();
    tenantIds.push(tenantId);
    files.push(copyValidatedJson(source, paths.tenantDb(tenantId)));
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
  fs.writeFileSync(path.join(destination, 'staged-restore-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

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
