import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('ATHLYRAX_COACH_LINK_INTEGRITY_V1')) {
  throw new Error('Coach-link integrity patch must run before ownership hardening.');
}

const marker = '// ATHLYRAX_COACH_LINK_TENANT_OWNERSHIP_V1';
if (!source.includes(marker)) {
  const approvedOld = `\t\tconst approvedRow = {\n\t\t\t...sourceRows[sourceIndex],\n\t\t\tpathway: 'club',`;
  const approvedNew = `\t\tconst approvedRow = {\n\t\t\t...sourceRows[sourceIndex],\n\t\t\ttenantId: actorTenantId,\n\t\t\tpathway: 'club',`;
  if (!source.includes(approvedNew)) {
    if (!source.includes(approvedOld)) throw new Error('Accepted swimmer ownership anchor not found.');
    source = source.replace(approvedOld, approvedNew);
  }

  const restoredOld = `\t\tconst restoredRow = {\n\t\t\t...currentRow,\n\t\t\tpathway: 'individual',`;
  const restoredNew = `\t\tconst restoredRow = {\n\t\t\t...currentRow,\n\t\t\ttenantId: sourceTenantId,\n\t\t\tpathway: 'individual',`;
  if (!source.includes(restoredNew)) {
    if (!source.includes(restoredOld)) throw new Error('Restored swimmer ownership anchor not found.');
    source = source.replace(restoredOld, restoredNew);
  }

  const restoredLinkOld = `\t\t\tcoachApprovalAt: '',\n\t\t\tcoachLinkSourceTenantId: '',\n\t\t\tcoachTargetTenantId: '',`;
  const restoredLinkNew = `\t\t\tcoachApprovalAt: '',\n\t\t\tcoachLinkRequestId: '',\n\t\t\tcoachLinkSourceTenantId: '',\n\t\t\tcoachTargetTenantId: '',`;
  if (!source.includes(restoredLinkNew)) {
    if (!source.includes(restoredLinkOld)) throw new Error('Restored swimmer coach-link cleanup anchor not found.');
    source = source.replace(restoredLinkOld, restoredLinkNew);
  }

  const pendingClearOld = `\t\t\t\tcoachApprovalAt: '',\n\t\t\t\tshareMode: 'Feedback link only',`;
  const pendingClearNew = `\t\t\t\tcoachApprovalAt: '',\n\t\t\t\tcoachLinkRequestId: '',\n\t\t\t\tcoachTargetTenantId: '',\n\t\t\t\tshareMode: 'Feedback link only',`;
  const disconnectStart = source.indexOf("app.post('/swimmer/coach/disconnect'");
  const dbStart = source.indexOf('// Serve db.json at /db', disconnectStart);
  if (disconnectStart < 0 || dbStart < 0) throw new Error('Disconnect route bounds missing for ownership cleanup.');
  let disconnectSource = source.slice(disconnectStart, dbStart);
  if (!disconnectSource.includes("coachLinkRequestId: '',\n\t\t\t\tcoachTargetTenantId: ''")) {
    if (!disconnectSource.includes(pendingClearOld)) throw new Error('Pending disconnect link cleanup anchor not found.');
    disconnectSource = disconnectSource.replace(pendingClearOld, pendingClearNew);
    source = source.slice(0, disconnectStart) + disconnectSource + source.slice(dbStart);
  }

  source = `${marker}\n${source}`;
}

for (const required of [
  'ATHLYRAX_COACH_LINK_TENANT_OWNERSHIP_V1',
  'tenantId: actorTenantId',
  'tenantId: sourceTenantId',
  "coachLinkRequestId: ''",
]) if (!source.includes(required)) throw new Error(`Coach-link tenant ownership hardening missing: ${required}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('COACH_LINK_TENANT_OWNERSHIP_PATCH_OK');
