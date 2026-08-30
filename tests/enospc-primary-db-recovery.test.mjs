import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('primary DB ENOSPC recovery prunes only recoverable artifacts and retries once', () => {
  const source = fs.readFileSync(new URL('../scripts/patch-enospc-primary-db-recovery.mjs', import.meta.url), 'utf8');
  for (const required of [
    'ATHLYRAX_ENOSPC_PRIMARY_DB_RECOVERY_V1',
    "=== 'ENOSPC'",
    'reclaimRecoverableStorageForDbWrite(storagePaths)',
    'pruneOldestFiles(storagePaths.snapshotDir, 2)',
    'pruneOldestFiles(AUTH_AUDIT_BACKUP_DIR, 3)',
    'pruneOldestFiles(BILLING_CATALOG_BACKUP_DIR, 3)',
    'writeAtomicJsonFile(storagePaths.dbPath, ownershipStampedBody)',
  ]) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(source, /unlinkSync\(storagePaths\.dbPath\)/);
  assert.doesNotMatch(source, /unlinkSync\(storagePaths\.backupPath\)/);
  assert.doesNotMatch(source, /unlinkSync\(AUTH_USERS_PATH\)/);
});
