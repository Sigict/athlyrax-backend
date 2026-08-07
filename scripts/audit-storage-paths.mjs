import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const runtimeFiles = [
  'index.js',
  'verify-closed-pilot-security.mjs',
  'scripts/approve-storage-layout.mjs',
  'scripts/check-storage-safety.mjs',
  'scripts/data-safety-preload.mjs',
  'scripts/db-revision-put-response.mjs',
  'scripts/prod-isolation-smoke.mjs',
  'scripts/safe-start.mjs',
  'scripts/signup-legal-acceptance-preload.mjs',
  'scripts/stage-storage-restore.mjs',
  'scripts/storage-path-contract.mjs',
  'scripts/storage-safety-lib.mjs',
];

const failures = [];
const forbiddenByFile = new Map([
  ['index.js', [
    `path.join(STORAGE_ROOT, 'tenants', 'clubs')`,
    `path.join(STORAGE_ROOT, 'auth-users.json')`,
    `writeAtomicJsonFile(storagePaths.dbPath, {});`,
  ]],
  ['verify-closed-pilot-security.mjs', [
    `path.join(storageRootPath, 'auth-users.json')`,
    `path.join(resolvedStorageRoot, 'auth-users.json')`,
  ]],
  ['scripts/storage-safety-lib.mjs', [
    'linkRepositoryStorage',
    'symlinkSync(',
    'repositoryStoragePath',
  ]],
  ['scripts/prod-isolation-smoke.mjs', [
    'Demo tenant expected empty',
    'Research tenant view expected empty',
    'authorization: `Bearer',
  ]],
  ['scripts/safe-start.mjs', ['linkStorage: true']],
]);

for (const relative of runtimeFiles) {
  const filePath = path.join(root, relative);
  if (!fs.existsSync(filePath)) {
    failures.push(`Missing runtime file: ${relative}`);
    continue;
  }
  const source = fs.readFileSync(filePath, 'utf8');
  for (const token of forbiddenByFile.get(relative) || []) {
    if (source.includes(token)) failures.push(`${relative}: forbidden storage token remains: ${token}`);
  }
}

const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
for (const required of [
  `path.join(STORAGE_ROOT, 'tenants')`,
  `path.join(STORAGE_ROOT, 'auth', 'auth-users.json')`,
  `action: 'tenant_database_missing'`,
  `// ATHLYRAX_CANONICAL_STORAGE_RUNTIME_GUARD`,
  `runStorageSafetyCheck({`,
  `restoreBundledDemoTenantIfNeeded({`,
]) {
  if (!indexSource.includes(required)) failures.push(`index.js: missing canonical token: ${required}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const postinstall = String(packageJson?.scripts?.postinstall || '');
const start = String(packageJson?.scripts?.start || '');
if (!postinstall.includes('patch-canonical-storage-contract.mjs')) {
  failures.push('package.json: canonical storage patch is not wired into postinstall.');
}
if (postinstall.includes('patch-tenant-storage-path.mjs')) {
  failures.push('package.json: obsolete tenant-storage patch is still wired into postinstall.');
}
if (Object.prototype.hasOwnProperty.call(packageJson?.scripts || {}, 'start:unsafe')) {
  failures.push('package.json: start:unsafe bypass must not exist.');
}
if (!start.includes('audit:storage-paths') || !start.includes('safe-start.mjs')) {
  failures.push('package.json: production start must run storage audit and safe-start.');
}

if (failures.length) {
  console.error('ATHLYRAX_STORAGE_PATH_AUDIT_FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('ATHLYRAX_STORAGE_PATH_AUDIT_OK');
