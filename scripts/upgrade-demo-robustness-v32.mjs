// One-time Robustness of Efficiency v3.2 repair of the synthetic Demo Coach club, run at production start before the
// server accepts requests (owner approval required for the release that contains it).
//
// What it changes (website module capability-engine/src/utils/demoRobustnessV32Upgrade.js, byte-identical copy):
//   1. the 144 manifest records whose saved energy code contradicts the demo programme;
//   2. synthetic stroke counts regenerated with the documented demonstration model.
// Coach-entered, imported, device and unlabelled measurements, times, attendance and sessions are never changed.
//
// Safety:
//   - one-time: markers in __meta.demoSeed (programmeEnergyRepairVersion, strokeModelV2Version); nothing is written
//     when both are present, when the club file is missing or unreadable, or when it is not the synthetic demo club;
//   - backup first: the file is copied byte-for-byte to <backupRoot>/demo-robustness-v32/ and the copy is verified;
//   - atomic: the repaired club is written to a temporary file in the same folder, flushed, then renamed over the
//     original, so the club is either entirely old or entirely repaired; a failure removes the temporary file and
//     leaves the original untouched;
//   - verified: the written file is read back and must carry both markers;
//   - rollback: copy the backup file back over tenants/demo-company/db.json (see the release procedure).
import fs from 'node:fs';
import path from 'node:path';
import { upgradeDemoRobustnessV32, demoRobustnessV32Pending } from '../capability-engine/src/utils/demoRobustnessV32Upgrade.js';

const TENANT_ID = 'demo-company';

export function upgradeDemoRobustnessV32Storage({ storageRoot, backupRoot, logger = console, fsModule = fs, now = () => new Date() } = {}) {
  if (!storageRoot) throw new Error('upgradeDemoRobustnessV32Storage requires storageRoot');
  if (!backupRoot) throw new Error('upgradeDemoRobustnessV32Storage requires backupRoot');
  const dbPath = path.resolve(storageRoot, 'tenants', TENANT_ID, 'db.json');
  if (!fsModule.existsSync(dbPath)) return { changed: false, reason: 'missing-demo-db', dbPath };
  let original; let current;
  try { original = fsModule.readFileSync(dbPath); current = JSON.parse(original.toString('utf8')); }
  catch (error) { return { changed: false, reason: 'unreadable-demo-db', dbPath, error: String(error?.message || error) }; }
  if (!demoRobustnessV32Pending(current)) return { changed: false, reason: 'already-applied-or-not-demo', dbPath };
  const result = upgradeDemoRobustnessV32(current);
  if (!result.changed) return { changed: false, reason: result.reason, dbPath };

  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.resolve(backupRoot, 'demo-robustness-v32');
  fsModule.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `demo-company-before-robustness-v32-${stamp}.json`);
  fsModule.copyFileSync(dbPath, backupPath);
  if (!fsModule.readFileSync(backupPath).equals(original)) throw new Error('demo backup verification failed; nothing written');

  const previousRevision = Number(current?.__meta?.storageRevision || 0);
  const next = { ...result.db, __meta: { ...result.db.__meta, storageRevision: previousRevision + 1, storageUpdatedAt: now().toISOString(),
    demoSeed: { ...result.db.__meta.demoSeed, robustnessV32UpgradedAt: now().toISOString(), robustnessV32Backup: path.basename(backupPath), source: 'production-start-one-time-upgrade' } } };
  const tmp = `${dbPath}.tmp-robustness-v32-${process.pid}-${Date.now()}`;
  try {
    const fd = fsModule.openSync(tmp, 'w');
    try { fsModule.writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, 'utf8'); fsModule.fsyncSync(fd); } finally { fsModule.closeSync(fd); }
    fsModule.renameSync(tmp, dbPath);
  } catch (error) {
    try { fsModule.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
  const written = JSON.parse(fsModule.readFileSync(dbPath, 'utf8'));
  if (demoRobustnessV32Pending(written)) throw new Error('demo repair verification failed after write; restore from ' + backupPath);
  const summary = { energyRepaired: result.energyRepaired, stroke: result.stroke, revision: previousRevision + 1 };
  logger.log?.(`[demo-robustness-v32] Demo club repaired once (backup ${backupPath}): ${JSON.stringify(summary)}`);
  return { changed: true, reason: 'applied', dbPath, backupPath, ...summary };
}
