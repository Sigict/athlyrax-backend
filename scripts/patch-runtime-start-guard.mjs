import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_CANONICAL_STORAGE_RUNTIME_GUARD';
const appAnchor = 'const app = express();';
const markerIndex = source.indexOf(marker);
const appIndex = source.indexOf(appAnchor, markerIndex);
if (markerIndex < 0 || appIndex < 0) {
  throw new Error('Canonical runtime guard block not found; refusing to patch production startup behavior.');
}

const replacement = `${marker}\nconst athlyraxRuntimeIsProduction = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';\nif (process.env.RENDER_SERVICE_ID && !athlyraxRuntimeIsProduction) {\n\tthrow new Error('Render runtime requires NODE_ENV=production. Refusing unsafe development/default mode.');\n}\nif (athlyraxRuntimeIsProduction && String(process.env.ATHLYRAX_SAFE_START_ENFORCED || '').trim().toLowerCase() !== 'true') {\n\tthrow new Error('Production backend entrypoint must be launched through the guarded production-start/safe-start path. Direct index.js startup is refused.');\n}\n\n${appAnchor}`;

source = source.slice(0, markerIndex) + replacement + source.slice(appIndex + appAnchor.length);

for (const forbidden of [
  'runtimeLegacyMigration = migrateLegacyStorageIfNeeded({',
  'restoreBundledDemoTenantIfNeeded({',
  'finalizeLegacyStorageMigration({',
  'runStorageSafetyCheck({ repoRoot: __dirname, requireFiles: true, createDirectories: true })',
]) {
  const start = source.indexOf(marker);
  const end = source.indexOf(appAnchor, start);
  const guardBlock = source.slice(start, end);
  if (guardBlock.includes(forbidden)) throw new Error(`Runtime startup mutation remains: ${forbidden}`);
}

for (const required of [
  marker,
  'ATHLYRAX_SAFE_START_ENFORCED',
  'Production backend entrypoint must be launched through the guarded production-start/safe-start path.',
  'Direct index.js startup is refused.',
]) {
  if (!source.includes(required)) throw new Error(`Runtime start guard verification failed: ${required}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('RUNTIME_START_GUARD_OK');
