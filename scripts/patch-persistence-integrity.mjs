import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const snapshotMarker = `// ATHLYRAX_SNAPSHOT_SUBMISSIONS_FAIL_CLOSED`;
if (!source.includes(snapshotMarker)) {
  const unsafeSnapshotLoader = `function loadOrCreateSnapshotSubmissions() {\n\tconst parsed = readJsonFile(SNAPSHOT_SUBMISSIONS_PATH);\n\tif (Array.isArray(parsed)) return parsed;\n\ttry {\n\t\twriteAtomicJsonFile(SNAPSHOT_SUBMISSIONS_PATH, []);\n\t} catch {\n\t\t// Keep boot resilient when first-write fails.\n\t}\n\treturn [];\n}\n\nfunction persistSnapshotSubmissions() {\n\twriteAtomicJsonFile(SNAPSHOT_SUBMISSIONS_PATH, Array.isArray(snapshotSubmissions) ? snapshotSubmissions : []);\n}`;
  const safeSnapshotLoader = `function loadOrCreateSnapshotSubmissions() {\n${snapshotMarker}\n\tif (fs.existsSync(SNAPSHOT_SUBMISSIONS_PATH)) {\n\t\tconst parsed = readJsonFile(SNAPSHOT_SUBMISSIONS_PATH);\n\t\tif (!Array.isArray(parsed)) {\n\t\t\tthrow new Error('Snapshot submissions store is unreadable or invalid. Refusing to replace it with an empty file.');\n\t\t}\n\t\treturn parsed;\n\t}\n\twriteAtomicJsonFile(SNAPSHOT_SUBMISSIONS_PATH, []);\n\treturn [];\n}\n\nfunction persistSnapshotSubmissions() {\n\tif (!Array.isArray(snapshotSubmissions)) {\n\t\tthrow new Error('Snapshot submissions in-memory state is invalid. Refusing destructive persistence.');\n\t}\n\twriteAtomicJsonFile(SNAPSHOT_SUBMISSIONS_PATH, snapshotSubmissions);\n}`;
  if (!source.includes(unsafeSnapshotLoader)) throw new Error('Could not find snapshot submissions loader anchor.');
  source = source.replace(unsafeSnapshotLoader, safeSnapshotLoader);
}

const snapshotRetentionMarker = `// ATHLYRAX_SNAPSHOT_HISTORY_NO_SILENT_TRUNCATION`;
if (!source.includes(snapshotRetentionMarker)) {
  const destructiveCap = `\tsnapshotSubmissions.unshift(submission);\n\tif (snapshotSubmissions.length > 5000) {\n\t\tsnapshotSubmissions.length = 5000;\n\t}`;
  const preserveAll = `\tsnapshotSubmissions.unshift(submission);\n\t${snapshotRetentionMarker}`;
  if (!source.includes(destructiveCap)) throw new Error('Could not find destructive snapshot history cap.');
  source = source.replace(destructiveCap, preserveAll);
}
if (source.includes('snapshotSubmissions.length = 5000;')) {
  throw new Error('Destructive snapshot history truncation remains in backend source.');
}

const billingMarker = `// ATHLYRAX_BILLING_CATALOG_FAIL_CLOSED`;
if (!source.includes(billingMarker)) {
  const loaderStart = source.indexOf('function loadOrCreateBillingCatalog() {');
  const loaderEnd = source.indexOf('\nfunction persistBillingCatalog()', loaderStart);
  if (loaderStart < 0 || loaderEnd < 0) throw new Error('Could not locate billing catalog loader.');
  const safeLoader = `function isValidRawBillingCatalog(raw) {\n\treturn Boolean(raw)\n\t\t&& typeof raw === 'object'\n\t\t&& !Array.isArray(raw)\n\t\t&& Array.isArray(raw.plans)\n\t\t&& raw.plans.length > 0\n\t\t&& raw.plans.every((plan) => plan && typeof plan === 'object' && String(plan.key || '').trim());\n}\n\nfunction loadLatestBillingCatalogBackupStrict() {\n\tif (!fs.existsSync(BILLING_CATALOG_BACKUP_DIR)) return null;\n\tconst snapshots = fs.readdirSync(BILLING_CATALOG_BACKUP_DIR)\n\t\t.filter((name) => name.startsWith('billing-catalog-') && name.endsWith('.json'))\n\t\t.map((name) => ({\n\t\t\tfullPath: path.join(BILLING_CATALOG_BACKUP_DIR, name),\n\t\t\tmtime: fs.statSync(path.join(BILLING_CATALOG_BACKUP_DIR, name)).mtimeMs,\n\t\t}))\n\t\t.sort((a, b) => b.mtime - a.mtime);\n\tfor (const snapshot of snapshots) {\n\t\tconst parsed = readJsonFile(snapshot.fullPath);\n\t\tif (!isValidRawBillingCatalog(parsed)) continue;\n\t\treturn normalizeBillingCatalog(parsed);\n\t}\n\treturn null;\n}\n\nfunction loadOrCreateBillingCatalog() {\n${billingMarker}\n\tensureStorageLayout();\n\tconst exists = fs.existsSync(BILLING_CATALOG_PATH);\n\tconst existing = exists ? readJsonFile(BILLING_CATALOG_PATH) : null;\n\tif (isValidRawBillingCatalog(existing)) {\n\t\tconst normalized = normalizeBillingCatalog(existing);\n\t\twriteAtomicJsonFile(BILLING_CATALOG_PATH, normalized);\n\t\tbackupBillingCatalogSnapshot(normalized, 'bootstrap-current');\n\t\treturn normalized;\n\t}\n\n\tconst recovered = loadLatestBillingCatalogBackupStrict();\n\tif (recovered) {\n\t\tconsole.warn('[billing] billing-catalog.json missing/invalid; restored latest structurally valid backup snapshot.');\n\t\twriteAtomicJsonFile(BILLING_CATALOG_PATH, recovered);\n\t\treturn recovered;\n\t}\n\n\tif (IS_PRODUCTION || BILLING_STRICT_RECOVERY) {\n\t\tconst state = exists ? 'invalid' : 'missing';\n\t\tthrow new Error(\`[billing] billing-catalog.json is \${state} and no structurally valid backup is available. Refusing default bootstrap.\`);\n\t}\n\n\tconst normalized = normalizeBillingCatalog(null);\n\tconsole.warn('[billing] No billing catalog or valid backup found; bootstrapping defaults outside production.');\n\twriteAtomicJsonFile(BILLING_CATALOG_PATH, normalized);\n\tbackupBillingCatalogSnapshot(normalized, 'bootstrap-default');\n\treturn normalized;\n}\n`;
  source = source.slice(0, loaderStart) + safeLoader + source.slice(loaderEnd);
}

const passwordResetMarker = `// ATHLYRAX_PRODUCTION_PASSWORD_RESET_NO_CONSOLE`;
if (!source.includes(passwordResetMarker)) {
  const consoleBlock = `\tconsole.log(\`[auth] Password reset code for \${username}: \${resetCode} (expires in \${AUTH_PASSWORD_RESET_TTL_MINUTES} minutes)\`);\n\treturn { mode: 'console' };`;
  const safeConsoleBlock = `${passwordResetMarker}\n\tif (IS_PRODUCTION) {\n\t\tthrow new Error('Password reset email delivery is not configured. Refusing to expose reset code through server logs.');\n\t}\n\tconsole.log(\`[auth] Password reset code for \${username}: \${resetCode} (expires in \${AUTH_PASSWORD_RESET_TTL_MINUTES} minutes)\`);\n\treturn { mode: 'console' };`;
  if (!source.includes(consoleBlock)) throw new Error('Could not find password reset console-delivery anchor.');
  source = source.replace(consoleBlock, safeConsoleBlock);
}

for (const token of [
  snapshotMarker,
  snapshotRetentionMarker,
  billingMarker,
  passwordResetMarker,
  'Snapshot submissions store is unreadable or invalid. Refusing to replace it with an empty file.',
  'Snapshot submissions in-memory state is invalid. Refusing destructive persistence.',
  'isValidRawBillingCatalog(',
  'loadLatestBillingCatalogBackupStrict(',
  'no structurally valid backup is available. Refusing default bootstrap.',
  'Password reset email delivery is not configured. Refusing to expose reset code through server logs.',
]) {
  if (!source.includes(token)) throw new Error(`Persistence integrity verification failed: ${token}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('PERSISTENCE_INTEGRITY_PATCH_OK');
