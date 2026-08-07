import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('ATHLYRAX_COACH_LINK_UNAMBIGUOUS_ROUTING_V1')) {
  throw new Error('Coach-link routing patch must run before reconnect hardening.');
}

const marker = '// ATHLYRAX_COACH_LINK_RECONNECT_V1';
if (!source.includes(marker)) {
  const conflictOld = `\t\tif (existingTargetIndex >= 0 && String(currentTargetRows[existingTargetIndex]?.coachLinkStatus || '').trim().toLowerCase() !== 'approved') {\n\t\t\tres.status(409).json({ error: 'Coach tenant already contains a conflicting swimmer binding.' });\n\t\t\treturn;\n\t\t}`;
  const conflictNew = `\t\tif (existingTargetIndex >= 0) {\n\t\t\tconst existingTargetStatus = String(currentTargetRows[existingTargetIndex]?.coachLinkStatus || '').trim().toLowerCase();\n\t\t\tif (existingTargetStatus !== 'approved' && existingTargetStatus !== 'disconnected') {\n\t\t\t\tres.status(409).json({ error: 'Coach tenant already contains a conflicting swimmer binding.' });\n\t\t\t\treturn;\n\t\t\t}\n\t\t}`;
  if (!source.includes(conflictNew)) {
    if (!source.includes(conflictOld)) throw new Error('Reconnect conflict anchor not found.');
    source = source.replace(conflictOld, conflictNew);
  }

  const capacityOld = `\t\tif (existingTargetIndex < 0) {\n\t\t\tconst { limits } = resolveTenantPlanLimits(actorTenantId);`;
  const capacityNew = `\t\tconst acceptanceAddsActiveSwimmer = existingTargetIndex < 0 || currentTargetRows[existingTargetIndex]?.active === false;\n\t\tif (acceptanceAddsActiveSwimmer) {\n\t\t\tconst { limits } = resolveTenantPlanLimits(actorTenantId);`;
  if (!source.includes('acceptanceAddsActiveSwimmer')) {
    if (!source.includes(capacityOld)) throw new Error('Reconnect capacity anchor not found.');
    source = source.replace(capacityOld, capacityNew);
  }

  const approvedActiveOld = `\t\t\ttenantId: actorTenantId,\n\t\t\tpathway: 'club',\n\t\t\tcoachConnected: true,`;
  const approvedActiveNew = `\t\t\ttenantId: actorTenantId,\n\t\t\tactive: true,\n\t\t\tpathway: 'club',\n\t\t\tcoachConnected: true,`;
  if (!source.includes(approvedActiveNew)) {
    if (!source.includes(approvedActiveOld)) throw new Error('Accepted swimmer active-state anchor not found.');
    source = source.replace(approvedActiveOld, approvedActiveNew);
  }

  const restoredActiveOld = `\t\t\ttenantId: sourceTenantId,\n\t\t\tpathway: 'individual',\n\t\t\tcoachConnected: false,`;
  const restoredActiveNew = `\t\t\ttenantId: sourceTenantId,\n\t\t\tactive: true,\n\t\t\tpathway: 'individual',\n\t\t\tcoachConnected: false,`;
  if (!source.includes(restoredActiveNew)) {
    if (!source.includes(restoredActiveOld)) throw new Error('Restored swimmer active-state anchor not found.');
    source = source.replace(restoredActiveOld, restoredActiveNew);
  }

  const archiveOld = `\t\t\tarchiveRows[currentIndex] = {\n\t\t\t\t...currentRow,\n\t\t\t\tcoachConnected: false,\n\t\t\t\tcoachLinkStatus: 'disconnected',`;
  const archiveNew = `\t\t\tarchiveRows[currentIndex] = {\n\t\t\t\t...currentRow,\n\t\t\t\tactive: false,\n\t\t\t\tcoachConnected: false,\n\t\t\t\tcoachLinkStatus: 'disconnected',`;
  if (!source.includes(archiveNew)) {
    if (!source.includes(archiveOld)) throw new Error('Disconnected archive active-state anchor not found.');
    source = source.replace(archiveOld, archiveNew);
  }

  source = `${marker}\n${source}`;
}

for (const required of [
  'ATHLYRAX_COACH_LINK_RECONNECT_V1',
  "existingTargetStatus !== 'approved' && existingTargetStatus !== 'disconnected'",
  'acceptanceAddsActiveSwimmer',
  "existingTargetIndex < 0 || currentTargetRows[existingTargetIndex]?.active === false",
  'tenantId: actorTenantId,\n\t\t\tactive: true',
  'tenantId: sourceTenantId,\n\t\t\tactive: true',
  "active: false,\n\t\t\t\tcoachConnected: false,\n\t\t\t\tcoachLinkStatus: 'disconnected'",
]) if (!source.includes(required)) throw new Error(`Coach-link reconnect hardening missing: ${required}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('COACH_LINK_RECONNECT_PATCH_OK');
