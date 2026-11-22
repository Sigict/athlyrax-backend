// One-time wording correction of the demonstration club at production start (owner decision 22-11-2026): removes the
// word "synthetic" from the twelve generated set-description / session-note phrases (website module, byte-identical
// copy: capability-engine/src/utils/demoWordingCorrection.js). Same safety as the Robustness repair: nothing written
// unless needed; byte-identical verified backup first; one atomic write (temporary file, flush, rename); read back;
// never stops the server. Rollback: copy the backup over tenants/demo-company/db.json.
import fs from 'node:fs';
import path from 'node:path';
import { correctDemoWording, demoWordingCorrectionPending } from '../capability-engine/src/utils/demoWordingCorrection.js';

export function correctDemoWordingStorage({ storageRoot, backupRoot, logger = console, fsModule = fs, now = () => new Date() } = {}) {
  if (!storageRoot || !backupRoot) throw new Error('correctDemoWordingStorage requires storageRoot and backupRoot');
  const dbPath = path.resolve(storageRoot, 'tenants', 'demo-company', 'db.json');
  if (!fsModule.existsSync(dbPath)) return { changed: false, reason: 'missing-demo-db' };
  let original; let current;
  try { original = fsModule.readFileSync(dbPath); current = JSON.parse(original.toString('utf8')); } catch { return { changed: false, reason: 'unreadable-demo-db' }; }
  if (!demoWordingCorrectionPending(current)) return { changed: false, reason: 'already-applied-or-not-demo' };
  const result = correctDemoWording(current);
  const backupDir = path.resolve(backupRoot, 'demo-wording-correction'); fsModule.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `demo-company-before-wording-correction-${now().toISOString().replace(/[:.]/g, '-')}.json`);
  fsModule.copyFileSync(dbPath, backupPath);
  if (!fsModule.readFileSync(backupPath).equals(original)) throw new Error('demo backup verification failed; nothing written');
  const revision = Number(current?.__meta?.storageRevision || 0) + 1;
  const next = { ...result.db, __meta: { ...result.db.__meta, storageRevision: revision, storageUpdatedAt: now().toISOString() } };
  const tmp = `${dbPath}.tmp-wording-${process.pid}-${Date.now()}`;
  try { const fd = fsModule.openSync(tmp, 'w'); try { fsModule.writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, 'utf8'); fsModule.fsyncSync(fd); } finally { fsModule.closeSync(fd); } fsModule.renameSync(tmp, dbPath); }
  catch (error) { try { fsModule.rmSync(tmp, { force: true }); } catch {} throw error; }
  if (demoWordingCorrectionPending(JSON.parse(fsModule.readFileSync(dbPath, 'utf8')))) throw new Error('wording correction verification failed after write; restore from ' + backupPath);
  logger.log?.(`[demo-wording] corrected ${result.sets} set descriptions and ${result.sessions} session notes (backup ${backupPath})`);
  return { changed: true, backupPath, sets: result.sets, sessions: result.sessions, revision };
}
export function runDemoWordingCorrectionAtStart(options = {}) {
  const logger = options.logger || console;
  try { const r = correctDemoWordingStorage(options); if (!r.changed) logger.log?.(`[demo-wording] not applied: ${r.reason}`); return r; }
  catch (error) { logger.error?.(`[demo-wording] FAILED, demo club left unchanged: ${error?.message || error}`); return { changed: false, reason: 'failed', error: String(error?.message || error) }; }
}
