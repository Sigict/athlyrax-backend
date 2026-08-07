import fs from 'node:fs';
import path from 'node:path';

export const ACTIVE_MIGRATION_TRANSACTION_FILE = '.athlyrax-migration-transaction-active.json';

export function activeMigrationTransactionPath(backupRoot) {
  const raw = String(backupRoot || '').trim();
  if (!raw) throw new Error('Safety backup root is required for migration transaction state.');
  return path.join(path.resolve(raw), ACTIVE_MIGRATION_TRANSACTION_FILE);
}

export function readActiveMigrationTransaction(backupRoot, fsModule = fs) {
  const journalPath = activeMigrationTransactionPath(backupRoot);
  if (!fsModule.existsSync(journalPath)) return null;
  let parsed = null;
  try { parsed = JSON.parse(fsModule.readFileSync(journalPath, 'utf8')); }
  catch {
    const error = new Error(`Active migration transaction journal is unreadable: ${journalPath}`);
    error.code = 'ATHLYRAX_MIGRATION_TRANSACTION_JOURNAL_INVALID';
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1 || parsed.active !== true) {
    const error = new Error(`Active migration transaction journal is invalid: ${journalPath}`);
    error.code = 'ATHLYRAX_MIGRATION_TRANSACTION_JOURNAL_INVALID';
    throw error;
  }
  return { ...parsed, journalPath };
}

export function assertNoActiveMigrationTransaction(backupRoot, fsModule = fs) {
  const active = readActiveMigrationTransaction(backupRoot, fsModule);
  if (!active) return;
  const error = new Error(`An interrupted storage migration transaction requires recovery before normal startup: ${active.journalPath}`);
  error.code = 'ATHLYRAX_MIGRATION_TRANSACTION_INCOMPLETE';
  throw error;
}
