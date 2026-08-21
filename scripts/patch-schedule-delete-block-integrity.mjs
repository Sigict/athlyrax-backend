import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_SCHEDULE_DELETE_BLOCK_INTEGRITY_V1';
if (!source.includes("app.post('/db/schedule-delete'")) {
  throw new Error('Server-authoritative Schedule deletion route must exist before block-integrity hardening.');
}

if (!source.includes(marker)) {
  const oldBlockSelection = `\t\tconst linkedBlockIds = new Set(\n\t\t\tblockRows\n\t\t\t\t.filter((row) => {\n\t\t\t\t\tif (linkedSessionIds.has(textId(row?.sessionId || row?.trainingSessionId))) return true;\n\t\t\t\t\tif (linkedSetIds.has(textId(row?.setId))) return true;\n\t\t\t\t\treturn (Array.isArray(row?.setIds) ? row.setIds : []).some((id) => linkedSetIds.has(textId(id)));\n\t\t\t\t})\n\t\t\t\t.map((row) => textId(row?.id))\n\t\t\t\t.filter(Boolean),\n\t\t);`;

  const newBlockSelection = `${marker}\n\t\tconst setSessionById = new Map(\n\t\t\tsetRows\n\t\t\t\t.map((row) => [textId(row?.id), textId(row?.sessionId || row?.trainingSessionId)])\n\t\t\t\t.filter(([setId]) => Boolean(setId)),\n\t\t);\n\t\tconst removedBlockIds = new Set();\n\t\tconst nextBlocks = blockRows.flatMap((row) => {\n\t\t\tconst blockId = textId(row?.id);\n\t\t\tconst ownerSessionId = textId(row?.sessionId || row?.trainingSessionId);\n\t\t\tconst ownerDeleted = Boolean(ownerSessionId && linkedSessionIds.has(ownerSessionId));\n\t\t\tconst singularSetId = textId(row?.setId);\n\t\t\tconst singularRemoved = Boolean(singularSetId && linkedSetIds.has(singularSetId));\n\t\t\tconst originalSetIds = (Array.isArray(row?.setIds) ? row.setIds : []).map(textId).filter(Boolean);\n\t\t\tconst remainingSetIds = originalSetIds.filter((id) => !linkedSetIds.has(id));\n\n\t\t\tif (ownerDeleted && remainingSetIds.length === 0 && (!singularSetId || singularRemoved)) {\n\t\t\t\tif (blockId) removedBlockIds.add(blockId);\n\t\t\t\treturn [];\n\t\t\t}\n\n\t\t\tconst changedSetIds = remainingSetIds.length !== originalSetIds.length;\n\t\t\tif (!ownerDeleted && !singularRemoved && !changedSetIds) return [row];\n\n\t\t\tconst remainingOwnerIds = Array.from(new Set(\n\t\t\t\tremainingSetIds\n\t\t\t\t\t.map((setId) => setSessionById.get(setId) || '')\n\t\t\t\t\t.filter((sessionId) => sessionId && !linkedSessionIds.has(sessionId)),\n\t\t\t));\n\t\t\tconst reassignedSessionId = ownerDeleted && remainingOwnerIds.length === 1 ? remainingOwnerIds[0] : '';\n\t\t\treturn [{\n\t\t\t\t...row,\n\t\t\t\t...(Array.isArray(row?.setIds) ? { setIds: remainingSetIds } : {}),\n\t\t\t\t...(singularRemoved ? { setId: '' } : {}),\n\t\t\t\t...(ownerDeleted && Object.prototype.hasOwnProperty.call(row, 'sessionId') ? { sessionId: reassignedSessionId } : {}),\n\t\t\t\t...(ownerDeleted && Object.prototype.hasOwnProperty.call(row, 'trainingSessionId') ? { trainingSessionId: reassignedSessionId } : {}),\n\t\t\t\tupdatedAt: now,\n\t\t\t}];\n\t\t});`;

  if (!source.includes(oldBlockSelection)) {
    throw new Error('Could not locate unsafe whole-block Schedule deletion logic.');
  }
  source = source.replace(oldBlockSelection, newBlockSelection);

  source = source.replace(
    "...Array.from(linkedBlockIds).map((id) => ({ collection: 'trainingSetBlocks', id, deletedAt: now, deletedBy: 'server-authoritative-schedule-delete' })),",
    "...Array.from(removedBlockIds).map((id) => ({ collection: 'trainingSetBlocks', id, deletedAt: now, deletedBy: 'server-authoritative-schedule-delete' })),",
  );
  source = source.replace(
    "trainingSetBlocks: blockRows.filter((row) => !linkedBlockIds.has(textId(row?.id))),",
    'trainingSetBlocks: nextBlocks,',
  );
  source = source.replace(
    "\t\tconst persistedSets = Array.isArray(persisted?.trainingSessionSets) ? persisted.trainingSessionSets : [];",
    "\t\tconst persistedSets = Array.isArray(persisted?.trainingSessionSets) ? persisted.trainingSessionSets : [];\n\t\tconst persistedBlocks = Array.isArray(persisted?.trainingSetBlocks) ? persisted.trainingSetBlocks : [];",
  );
  source = source.replace(
    "\t\tconst remainingSetIds = persistedSets.map((row) => textId(row?.id)).filter((id) => linkedSetIds.has(id));",
    "\t\tconst remainingSetIds = persistedSets.map((row) => textId(row?.id)).filter((id) => linkedSetIds.has(id));\n\t\tconst remainingBlockIds = persistedBlocks.map((row) => textId(row?.id)).filter((id) => removedBlockIds.has(id));\n\t\tconst staleBlockSetReferences = persistedBlocks.flatMap((row) => {\n\t\t\tconst referenced = [textId(row?.setId), ...(Array.isArray(row?.setIds) ? row.setIds.map(textId) : [])].filter(Boolean);\n\t\t\tconst stale = referenced.filter((id) => linkedSetIds.has(id));\n\t\t\treturn stale.length > 0 ? [{ blockId: textId(row?.id), setIds: stale }] : [];\n\t\t});\n\t\tconst staleBlockOwnerReferences = persistedBlocks\n\t\t\t.filter((row) => linkedSessionIds.has(textId(row?.sessionId || row?.trainingSessionId)))\n\t\t\t.map((row) => textId(row?.id));",
  );
  source = source.replace(
    'if (remainingScheduleIds.length || remainingLegacyIds.length || remainingSessionIds.length || remainingSetIds.length) {',
    'if (remainingScheduleIds.length || remainingLegacyIds.length || remainingSessionIds.length || remainingSetIds.length || remainingBlockIds.length || staleBlockSetReferences.length || staleBlockOwnerReferences.length) {',
  );
  source = source.replace(
    "\t\t\t\tremainingSetIds,\n\t\t\t};",
    "\t\t\t\tremainingSetIds,\n\t\t\t\tremainingBlockIds,\n\t\t\t\tstaleBlockSetReferences,\n\t\t\t\tstaleBlockOwnerReferences,\n\t\t\t};",
  );
  source = source.replace(
    'removedTrainingSetBlockCount: linkedBlockIds.size,',
    'removedTrainingSetBlockCount: removedBlockIds.size,',
  );
}

for (const required of [
  marker,
  'const nextBlocks = blockRows.flatMap((row) => {',
  'const removedBlockIds = new Set();',
  'trainingSetBlocks: nextBlocks,',
  'staleBlockSetReferences',
  'staleBlockOwnerReferences',
  'removedTrainingSetBlockCount: removedBlockIds.size,',
]) {
  if (!source.includes(required)) throw new Error(`Schedule delete block-integrity invariant missing: ${required}`);
}

for (const forbidden of [
  'trainingSetBlocks: blockRows.filter((row) => !linkedBlockIds.has(textId(row?.id)))',
  'removedTrainingSetBlockCount: linkedBlockIds.size',
]) {
  if (source.includes(forbidden)) throw new Error(`Unsafe Schedule delete block behavior remains: ${forbidden}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_SCHEDULE_DELETE_BLOCK_INTEGRITY_OK');
