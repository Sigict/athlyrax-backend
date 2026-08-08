import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const existingAnchor = `\tconst previousCoachLinkStatus = String(existingRow?.coachLinkStatus || 'none').trim() || 'none';\n\tconst previousCoachConnected = Boolean(existingRow?.coachConnected);`;
const authorityBlock = `\tconst previousCoachLinkStatus = String(existingRow?.coachLinkStatus || 'none').trim() || 'none';\n\tconst previousCoachConnected = Boolean(existingRow?.coachConnected);\n\t// ATHLYRAX_SWIMMER_PROFILE_SYNC_COACH_LINK_NON_AUTHORITATIVE\n\t// Coach-link lifecycle state is changed only by the dedicated request/decision/disconnect routes.\n\tconst serverCoachLinkApproved = previousCoachLinkStatus === 'approved';\n\tconst serverCoachLinkActive = previousCoachLinkStatus === 'pending' || serverCoachLinkApproved;\n\tconst nextCoachLinkStatus = previousCoachLinkStatus;`;

if (!source.includes('ATHLYRAX_SWIMMER_PROFILE_SYNC_COACH_LINK_NON_AUTHORITATIVE')) {
  if (!source.includes(existingAnchor)) throw new Error('Swimmer sync authority anchor was not found.');
  source = source.replace(existingAnchor, authorityBlock);
}

const oldFields = `\t\tpathway: sanitizedSync.payload.pathway,\n\t\tcoachConnected: sanitizedSync.payload.coachConnected,\n\t\tcoachLinkStatus: sanitizedSync.payload.coachLinkStatus,\n\t\tcoachEmail: sanitizedSync.payload.coachEmail || String(existingRow?.coachEmail || ''),\n\t\tcoachCode: sanitizedSync.payload.coachCode || String(existingRow?.coachCode || ''),\n\t\tcoachPhase: sanitizedSync.payload.coachPhase || String(existingRow?.coachPhase || ''),\n\t\tcoachRequestAt: sanitizedSync.payload.coachRequestAt || String(existingRow?.coachRequestAt || ''),\n\t\tcoachReplyAt: sanitizedSync.payload.coachReplyAt || String(existingRow?.coachReplyAt || ''),\n\t\tcoachApprovalAt: sanitizedSync.payload.coachApprovalAt || String(existingRow?.coachApprovalAt || ''),\n\t\tshareMode: sanitizedSync.payload.shareMode || String(existingRow?.shareMode || ''),`;
const previousAuthorityFields = `\t\tpathway: serverCoachLinkApproved ? 'club' : sanitizedSync.payload.pathway,\n\t\tcoachConnected: serverCoachLinkApproved ? previousCoachConnected : false,\n\t\tcoachLinkStatus: nextCoachLinkStatus,\n\t\tcoachEmail: serverCoachLinkApproved\n\t\t\t? String(existingRow?.coachEmail || '')\n\t\t\t: (sanitizedSync.payload.coachEmail || String(existingRow?.coachEmail || '')),\n\t\tcoachCode: serverCoachLinkApproved\n\t\t\t? String(existingRow?.coachCode || '')\n\t\t\t: (sanitizedSync.payload.coachCode || String(existingRow?.coachCode || '')),\n\t\tcoachPhase: String(existingRow?.coachPhase || ''),\n\t\tcoachRequestAt: serverCoachLinkApproved\n\t\t\t? String(existingRow?.coachRequestAt || '')\n\t\t\t: (sanitizedSync.payload.coachRequestAt || String(existingRow?.coachRequestAt || '')),\n\t\tcoachReplyAt: String(existingRow?.coachReplyAt || ''),\n\t\tcoachApprovalAt: String(existingRow?.coachApprovalAt || ''),\n\t\tshareMode: serverCoachLinkApproved\n\t\t\t? (String(existingRow?.shareMode || '').trim() || 'Shared AthlyraX data')\n\t\t\t: (sanitizedSync.payload.shareMode || String(existingRow?.shareMode || '')),`;
const newFields = `\t\tpathway: serverCoachLinkActive ? 'club' : sanitizedSync.payload.pathway,\n\t\tcoachConnected: previousCoachConnected,\n\t\tcoachLinkStatus: nextCoachLinkStatus,\n\t\tcoachEmail: String(existingRow?.coachEmail || ''),\n\t\tcoachCode: String(existingRow?.coachCode || ''),\n\t\tcoachPhase: String(existingRow?.coachPhase || ''),\n\t\tcoachRequestAt: String(existingRow?.coachRequestAt || ''),\n\t\tcoachReplyAt: String(existingRow?.coachReplyAt || ''),\n\t\tcoachApprovalAt: String(existingRow?.coachApprovalAt || ''),\n\t\tshareMode: String(existingRow?.shareMode || ''),`;

// Replace any stale authoritative-field variant wherever it remains. Do not skip
// this just because a previously hardened copy of the block exists elsewhere.
if (source.includes(previousAuthorityFields)) source = source.replaceAll(previousAuthorityFields, newFields);
if (source.includes(oldFields)) source = source.replaceAll(oldFields, newFields);
if (!source.includes(newFields)) throw new Error('Swimmer sync coach authority fields were not found.');

for (const token of [
  'ATHLYRAX_SWIMMER_PROFILE_SYNC_COACH_LINK_NON_AUTHORITATIVE',
  "const nextCoachLinkStatus = previousCoachLinkStatus;",
  "const serverCoachLinkActive = previousCoachLinkStatus === 'pending' || serverCoachLinkApproved;",
  "coachConnected: previousCoachConnected",
  "coachEmail: String(existingRow?.coachEmail || '')",
  "coachRequestAt: String(existingRow?.coachRequestAt || '')",
  "coachApprovalAt: String(existingRow?.coachApprovalAt || '')",
]) if (!source.includes(token)) throw new Error(`Swimmer coach authority hardening missing: ${token}`);

if (source.includes(oldFields) || source.includes(previousAuthorityFields)) {
  throw new Error('Generic swimmer profile sync still contains a stale coach-link write block.');
}

// These patterns identify writes from generic profile sync. A standalone
// coachLinkStatus value may still appear in validation/audit details and is not
// itself authoritative state mutation.
for (const forbidden of [
  "requestedCoachLinkStatus === 'pending'",
  "coachConnected: sanitizedSync.payload.coachConnected",
  "coachEmail: sanitizedSync.payload.coachEmail",
  "coachRequestAt: sanitizedSync.payload.coachRequestAt",
  "coachApprovalAt: sanitizedSync.payload.coachApprovalAt",
]) if (source.includes(forbidden)) throw new Error(`Generic swimmer profile sync still controls coach-link state: ${forbidden}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('SWIMMER_COACH_AUTHORITY_PATCH_OK');
