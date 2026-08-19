import fs from 'node:fs';

const path = 'scripts/patch-operational-integrity.mjs';
let source = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const startToken = "replaceRequired(\n  `\\t\\twriteAtomicJsonFile(storagePaths.backupPath, nextBackup);";
const start = source.indexOf(startToken);
const endToken = "\nreplaceRequired(\n  `\\t\\t\\t\\tstaleWriteIgnored: result.staleWriteIgnored === true,";
const end = source.indexOf(endToken, start);
if (start < 0 || end <= start) throw new Error('Planner backup post-commit patch block not found.');

const replacement = `const plannerBackupOldReturn = \`\\t\\twriteAtomicJsonFile(storagePaths.backupPath, nextBackup);\\n\\n\\t\\treturn {\\n\\t\\t\\trecoveredTargets: merged.recoveredTargets,\\n\\t\\t\\trecoveredFixtureIds: merged.recoveredFixtureIds,\\n\\t\\t\\tstaleWriteIgnored: false,\\n\\t\\t\\tblockedResurrections: filtered.blockedResurrections,\\n\\t\\t\\ttombstoneCount: mergedTombstones.length,\\n\\t\\t};\`;
const plannerBackupOccurrenceReturn = \`\\t\\twriteAtomicJsonFile(storagePaths.backupPath, nextBackup);\\n\\n\\t\\treturn {\\n\\t\\t\\trecoveredTargets: merged.recoveredTargets,\\n\\t\\t\\trecoveredFixtureIds: merged.recoveredFixtureIds,\\n\\t\\t\\tstaleWriteIgnored: false,\\n\\t\\t\\tblockedResurrections: [\\n\\t\\t\\t\\t...(Array.isArray(filtered.blockedResurrections) ? filtered.blockedResurrections : []),\\n\\t\\t\\t\\t...(Array.isArray(occurrenceFiltered.blockedResurrections) ? occurrenceFiltered.blockedResurrections : []),\\n\\t\\t\\t],\\n\\t\\t\\ttombstoneCount: mergedTombstones.length,\\n\\t\\t};\`;
const plannerBackupNewOld = \`\\t\\tlet plannerBackupSaved = true;\\n\\t\\ttry {\\n\\t\\t\\twriteAtomicJsonFile(storagePaths.backupPath, nextBackup);\\n\\t\\t} catch (backupError) {\\n\\t\\t\\tplannerBackupSaved = false;\\n\\t\\t\\tconsole.error('[planner-backup] Database was saved but derived planner backup refresh failed:', backupError instanceof Error ? backupError.message : String(backupError));\\n\\t\\t}\\n\\n\\t\\treturn {\\n\\t\\t\\trecoveredTargets: merged.recoveredTargets,\\n\\t\\t\\trecoveredFixtureIds: merged.recoveredFixtureIds,\\n\\t\\t\\tstaleWriteIgnored: false,\\n\\t\\t\\tblockedResurrections: filtered.blockedResurrections,\\n\\t\\t\\ttombstoneCount: mergedTombstones.length,\\n\\t\\t\\tplannerBackupSaved,\\n\\t\\t};\`;
const plannerBackupNewOccurrence = \`\\t\\tlet plannerBackupSaved = true;\\n\\t\\ttry {\\n\\t\\t\\twriteAtomicJsonFile(storagePaths.backupPath, nextBackup);\\n\\t\\t} catch (backupError) {\\n\\t\\t\\tplannerBackupSaved = false;\\n\\t\\t\\tconsole.error('[planner-backup] Database was saved but derived planner backup refresh failed:', backupError instanceof Error ? backupError.message : String(backupError));\\n\\t\\t}\\n\\n\\t\\treturn {\\n\\t\\t\\trecoveredTargets: merged.recoveredTargets,\\n\\t\\t\\trecoveredFixtureIds: merged.recoveredFixtureIds,\\n\\t\\t\\tstaleWriteIgnored: false,\\n\\t\\t\\tblockedResurrections: [\\n\\t\\t\\t\\t...(Array.isArray(filtered.blockedResurrections) ? filtered.blockedResurrections : []),\\n\\t\\t\\t\\t...(Array.isArray(occurrenceFiltered.blockedResurrections) ? occurrenceFiltered.blockedResurrections : []),\\n\\t\\t\\t],\\n\\t\\t\\ttombstoneCount: mergedTombstones.length,\\n\\t\\t\\tplannerBackupSaved,\\n\\t\\t};\`;
if (!source.includes('plannerBackupSaved = true')) {
  if (source.includes(plannerBackupOccurrenceReturn)) {
    source = source.replace(plannerBackupOccurrenceReturn, plannerBackupNewOccurrence);
  } else if (source.includes(plannerBackupOldReturn)) {
    source = source.replace(plannerBackupOldReturn, plannerBackupNewOld);
  } else {
    throw new Error('Planner backup post-commit handling anchor was not found.');
  }
}`;

source = source.slice(0, start) + replacement + source.slice(end);
fs.writeFileSync(path, source);
console.log('OPERATIONAL_OCCURRENCE_ANCHOR_PATCHED');
