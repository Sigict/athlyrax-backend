import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('ATHLYRAX_COACH_LINK_TRANSACTIONAL_COMMIT_V1')) {
  throw new Error('Coach-link transaction integrity must run before rollback-safety hardening.');
}

const marker = '// ATHLYRAX_COACH_LINK_REVISION_SAFE_ROLLBACK';
const importLine = `import { runWithDatabaseRollbackAuthorization } from './scripts/data-safety-preload.mjs';`;
if (!source.includes(importLine)) {
  const importAnchor = `import Stripe from 'stripe';`;
  if (!source.includes(importAnchor)) throw new Error('Coach-link rollback data-safety import anchor missing.');
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

if (!source.includes(marker)) {
  const helperAnchor = `function readCoachLinkDbStrict(storagePaths, label) {`;
  const helperIndex = source.indexOf(helperAnchor);
  if (helperIndex < 0) throw new Error('Coach-link strict DB helper anchor missing.');
  const helper = `${marker}\nfunction writeCoachLinkRollbackDb(storagePaths, previousDb) {\n\tif (!storagePaths?.dbPath) throw new Error('Coach-link rollback storage path is missing.');\n\tif (!previousDb || typeof previousDb !== 'object' || Array.isArray(previousDb)) throw new Error('Coach-link rollback previous database is invalid.');\n\treturn runWithDatabaseRollbackAuthorization(storagePaths.dbPath, previousDb, () => {\n\t\twriteAtomicJsonFile(storagePaths.dbPath, previousDb);\n\t});\n}\n\n`;
  source = source.slice(0, helperIndex) + helper + source.slice(helperIndex);
}

const workflowStart = source.indexOf('// ATHLYRAX_COACH_LINK_WORKFLOW_V1');
const workflowEnd = source.indexOf('// Serve db.json at /db', workflowStart);
if (workflowStart < 0 || workflowEnd < 0) throw new Error('Coach-link workflow bounds missing for rollback conversion.');
let workflow = source.slice(workflowStart, workflowEnd);

const replacements = [
  [`writeAtomicJsonFile(targetPaths.dbPath, targetDb);`, `writeCoachLinkRollbackDb(targetPaths, targetDb);`],
  [`writeAtomicJsonFile(sourcePaths.dbPath, sourceDb);`, `writeCoachLinkRollbackDb(sourcePaths, sourceDb);`],
  [`writeAtomicJsonFile(currentPaths.dbPath, currentDb);`, `writeCoachLinkRollbackDb(currentPaths, currentDb);`],
  [`writeAtomicJsonFile(pendingTargetPaths.dbPath, pendingTargetRollback);`, `writeCoachLinkRollbackDb(pendingTargetPaths, pendingTargetRollback);`],
];
let replacementCount = 0;
for (const [unsafe, safe] of replacements) {
  const count = workflow.split(unsafe).length - 1;
  if (count > 0) {
    workflow = workflow.replaceAll(unsafe, safe);
    replacementCount += count;
  }
}
if (replacementCount < 5) {
  throw new Error(`Coach-link rollback conversion found only ${replacementCount} rollback writes; expected at least five.`);
}
source = source.slice(0, workflowStart) + workflow + source.slice(workflowEnd);

for (const required of [
  'ATHLYRAX_COACH_LINK_REVISION_SAFE_ROLLBACK',
  'runWithDatabaseRollbackAuthorization(storagePaths.dbPath, previousDb',
  'writeCoachLinkRollbackDb(targetPaths, targetDb)',
  'writeCoachLinkRollbackDb(sourcePaths, sourceDb)',
  'writeCoachLinkRollbackDb(currentPaths, currentDb)',
  'writeCoachLinkRollbackDb(pendingTargetPaths, pendingTargetRollback)',
]) if (!source.includes(required)) throw new Error(`Coach-link rollback safety missing: ${required}`);

const finalWorkflow = source.slice(source.indexOf('// ATHLYRAX_COACH_LINK_WORKFLOW_V1'), source.indexOf('// Serve db.json at /db'));
for (const forbidden of [
  'writeAtomicJsonFile(targetPaths.dbPath, targetDb);',
  'writeAtomicJsonFile(sourcePaths.dbPath, sourceDb);',
  'writeAtomicJsonFile(currentPaths.dbPath, currentDb);',
  'writeAtomicJsonFile(pendingTargetPaths.dbPath, pendingTargetRollback);',
]) if (finalWorkflow.includes(forbidden)) throw new Error(`Unsafe ordinary coach-link rollback remains: ${forbidden}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('COACH_LINK_ROLLBACK_SAFETY_OK');
