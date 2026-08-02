import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runStorageSafetyCheck } from './storage-safety-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

try {
  runStorageSafetyCheck({
    repoRoot,
    requireFiles: String(
      process.env.ATHLYRAX_CHECK_REQUIRE_FILES
        ?? (String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? 'true' : 'false'),
    ).toLowerCase() !== 'false',
    createDirectories: true,
    linkStorage: false,
  });
} catch (error) {
  console.error('ATHLYRAX_STORAGE_SAFETY_CHECK_FAILED');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
