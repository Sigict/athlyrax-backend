import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const existingAnchor = `\tconst previousCoachLinkStatus = String(existingRow?.coachLinkStatus || 'none').trim() || 'none';\n\tconst previousCoachConnected = Boolean(existingRow?.coachConnected);`;
const authorityBlock = `\tconst previousCoachLinkStatus = String(existingRow?.coachLinkStatus || 'none').trim() || 'none';\n\tconst previousCoachConnected = Boolean(existingRow?.coachConnected);\n\t// ATHLYRAX_SWIMMER_CANNOT_SELF_APPROVE_COACH_LINK\n\tconst requestedCoachLinkStatus = String(sanitizedSync.payload.coachLinkStatus || 'none').trim() || 'none';\n\tif (requestedCoachLinkStatus === 'approved' && previousCoachLinkStatus !== 'approved') {\n\t\tappendAuthAuditEvent({\n\t\t\taction: 'swimmer_profile_sync_rejected',\n\t\t\treq,\n\t\t\tstatus: 'blocked',\n\t\t\treason: 'swimmer_cannot_self_approve_coach_link',\n\t\t\tdetails: { previousCoachLinkStatus, requestedCoachLinkStatus },\n\t\t});\n\t\tres.status(403).json({ error: 'Coach connections become approved only through coach-side acceptance.' });\n\t\treturn;\n\t}\n\tconst serverCoachLinkApproved = previousCoachLinkStatus === 'approved';\n\tconst nextCoachLinkStatus = serverCoachLinkApproved\n\t\t? 'approved'\n\t\t: (requestedCoachLinkStatus === 'pending' ? 'pending' : 'none');`;

if (!source.includes('ATHLYRAX_SWIMMER_CANNOT_SELF_APPROVE_COACH_LINK')) {
  if (!source.includes(existingAnchor)) throw new Error('Swimmer sync authority anchor was not found.');
  source = source.replace(existingAnchor, authorityBlock);
}

const oldFields = `\t\tpathway: sanitizedSync.payload.pathway,\n\t\tcoachConnected: sanitizedSync.payload.coachConnected,\n\t\tcoachLinkStatus: sanitizedSync.payload.coachLinkStatus,\n\t\tcoachEmail: sanitizedSync.payload.coachEmail || String(existingRow?.coachEmail || ''),\n\t\tcoachCode: sanitizedSync.payload.coachCode || String(existingRow?.coachCode || ''),\n\t\tcoachPhase: sanitizedSync.payload.coachPhase || String(existingRow?.coachPhase || ''),\n\t\tcoachRequestAt: sanitizedSync.payload.coachRequestAt || String(existingRow?.coachRequestAt || ''),\n\t\tcoachReplyAt: sanitizedSync.payload.coachReplyAt || String(existingRow?.coachReplyAt || ''),\n\t\tcoachApprovalAt: sanitizedSync.payload.coachApprovalAt || String(existingRow?.coachApprovalAt || ''),\n\t\tshareMode: sanitizedSync.payload.shareMode || String(existingRow?.shareMode || ''),`;
const newFields = `\t\tpathway: serverCoachLinkApproved ? 'club' : sanitizedSync.payload.pathway,\n\t\tcoachConnected: serverCoachLinkApproved ? previousCoachConnected : false,\n\t\tcoachLinkStatus: nextCoachLinkStatus,\n\t\tcoachEmail: serverCoachLinkApproved\n\t\t\t? String(existingRow?.coachEmail || '')\n\t\t\t: (sanitizedSync.payload.coachEmail || String(existingRow?.coachEmail || '')),\n\t\tcoachCode: serverCoachLinkApproved\n\t\t\t? String(existingRow?.coachCode || '')\n\t\t\t: (sanitizedSync.payload.coachCode || String(existingRow?.coachCode || '')),\n\t\tcoachPhase: String(existingRow?.coachPhase || ''),\n\t\tcoachRequestAt: serverCoachLinkApproved\n\t\t\t? String(existingRow?.coachRequestAt || '')\n\t\t\t: (sanitizedSync.payload.coachRequestAt || String(existingRow?.coachRequestAt || '')),\n\t\tcoachReplyAt: String(existingRow?.coachReplyAt || ''),\n\t\tcoachApprovalAt: String(existingRow?.coachApprovalAt || ''),\n\t\tshareMode: serverCoachLinkApproved\n\t\t\t? (String(existingRow?.shareMode || '').trim() || 'Shared AthlyraX data')\n\t\t\t: (sanitizedSync.payload.shareMode || String(existingRow?.shareMode || '')),`;

if (!source.includes(newFields)) {
  if (!source.includes(oldFields)) throw new Error('Swimmer sync coach authority fields were not found.');
  source = source.replace(oldFields, newFields);
}

for (const token of [
  'ATHLYRAX_SWIMMER_CANNOT_SELF_APPROVE_COACH_LINK',
  'swimmer_cannot_self_approve_coach_link',
  'Coach connections become approved only through coach-side acceptance.',
  'coachPhase: String(existingRow?.coachPhase || \'\')',
  'coachApprovalAt: String(existingRow?.coachApprovalAt || \'\')',
]) if (!source.includes(token)) throw new Error(`Swimmer coach authority hardening missing: ${token}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('SWIMMER_COACH_AUTHORITY_PATCH_OK');
