import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
const marker = '// ATHLYRAX_ATHLETE_TENANT_REGISTRY_V1';

if (!source.includes(marker)) {
  const acceptAnchor = `\t\tconst previousAuthUser = authUsers[swimmerUserIndex];\n\t\tauthUsers[swimmerUserIndex] = { ...previousAuthUser, tenantId: actorTenantId };`;
  const acceptReplacement = `\t\tconst previousAuthUser = authUsers[swimmerUserIndex];\n\t\t// ATHLYRAX_ATHLETE_TENANT_REGISTRY_V1\n\t\tconst actorAuthUser = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};\n\t\tlet nextAthleteTenantConnections = upsertAthleteTenantConnection(previousAuthUser?.athleteTenantConnections, {\n\t\t\ttenantId: sourceTenantId,\n\t\t\tclubId: String(sourceRows[sourceIndex]?.clubId || '').trim(),\n\t\t\tclubName: String(sourceRows[sourceIndex]?.clubName || sourceRows[sourceIndex]?.club || '').trim(),\n\t\t\tsquadId: String(sourceRows[sourceIndex]?.squadId || '').trim(),\n\t\t\tsquadName: String(sourceRows[sourceIndex]?.squadName || sourceRows[sourceIndex]?.squad || '').trim(),\n\t\t\tstatus: 'active',\n\t\t\tsource: 'coach-link-source',\n\t\t});\n\t\tnextAthleteTenantConnections = upsertAthleteTenantConnection(nextAthleteTenantConnections, {\n\t\t\ttenantId: actorTenantId,\n\t\t\tclubId: String(actorAuthUser?.clubId || actorTenantId).trim(),\n\t\t\tclubName: String(actorAuthUser?.swimClub || actorAuthUser?.teamName || '').trim(),\n\t\t\tstatus: 'active',\n\t\t\tsource: 'coach-link',\n\t\t\tcoachUsername: String(req.auth?.username || '').trim(),\n\t\t\tcoachEmail: String(requestRow?.coachEmail || '').trim(),\n\t\t\tapprovedAt,\n\t\t});\n\t\tauthUsers[swimmerUserIndex] = {\n\t\t\t...previousAuthUser,\n\t\t\ttenantId: actorTenantId,\n\t\t\tathleteTenantConnections: nextAthleteTenantConnections,\n\t\t};`;
  if (!source.includes(acceptAnchor)) throw new Error('Athlete tenant registry acceptance anchor not found.');
  source = source.replace(acceptAnchor, acceptReplacement);

  const disconnectAnchor = `\t\tconst previousAuthUser = authUsers[authUserIndex];\n\t\tauthUsers[authUserIndex] = { ...previousAuthUser, tenantId: sourceTenantId };`;
  const disconnectReplacement = `\t\tconst previousAuthUser = authUsers[authUserIndex];\n\t\tlet nextAthleteTenantConnections = deactivateAthleteTenantConnection(\n\t\t\tpreviousAuthUser?.athleteTenantConnections,\n\t\t\tcurrentTenantId,\n\t\t\tdisconnectedAt,\n\t\t);\n\t\tnextAthleteTenantConnections = upsertAthleteTenantConnection(nextAthleteTenantConnections, {\n\t\t\ttenantId: sourceTenantId,\n\t\t\tclubId: String(sourceRows[sourceIndex]?.clubId || '').trim(),\n\t\t\tclubName: String(sourceRows[sourceIndex]?.clubName || sourceRows[sourceIndex]?.club || '').trim(),\n\t\t\tsquadId: String(sourceRows[sourceIndex]?.squadId || '').trim(),\n\t\t\tsquadName: String(sourceRows[sourceIndex]?.squadName || sourceRows[sourceIndex]?.squad || '').trim(),\n\t\t\tstatus: 'active',\n\t\t\tsource: 'disconnect-restored-source',\n\t\t});\n\t\tauthUsers[authUserIndex] = {\n\t\t\t...previousAuthUser,\n\t\t\ttenantId: sourceTenantId,\n\t\t\tathleteTenantConnections: nextAthleteTenantConnections,\n\t\t};`;
  if (!source.includes(disconnectAnchor)) throw new Error('Athlete tenant registry disconnect anchor not found.');
  source = source.replace(disconnectAnchor, disconnectReplacement);
}

for (const token of [
  'ATHLYRAX_ATHLETE_TENANT_REGISTRY_V1',
  'upsertAthleteTenantConnection(previousAuthUser?.athleteTenantConnections',
  'deactivateAthleteTenantConnection(',
  'athleteTenantConnections: nextAthleteTenantConnections',
]) {
  if (!source.includes(token)) throw new Error(`Athlete tenant registry patch missing required token: ${token}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_ATHLETE_TENANT_REGISTRY_OK');
