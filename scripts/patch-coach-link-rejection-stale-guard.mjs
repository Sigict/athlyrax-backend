import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('ATHLYRAX_COACH_LINK_WORKFLOW_V1') || !source.includes('ATHLYRAX_COACH_LINK_LIFECYCLE_V1')) {
  throw new Error('Coach-link workflow and lifecycle must run before rejection stale-guard normalization.');
}

const rejectStart = source.indexOf("app.post('/coach/swimmer-links/:requestId/reject'");
const disconnectStart = source.indexOf("app.post('/swimmer/coach/disconnect'", rejectStart);
if (rejectStart < 0 || disconnectStart < 0) throw new Error('Coach-link reject route bounds missing.');

let rejectSource = source.slice(rejectStart, disconnectStart);
const marker = 'ATHLYRAX_COACH_LINK_REJECTION_STALE_GUARD';

if (!rejectSource.includes('rejectionMatchesCurrent')) {
  const compactOld = `\t\t\tif (swimmerIndex >= 0) {\n\t\t\t\trows[swimmerIndex] = { ...rows[swimmerIndex], coachConnected: false, coachLinkStatus: 'none', coachReplyAt: rejectedAt, coachApprovalAt: '', shareMode: 'Feedback link only' };\n\t\t\t\twriteDbSnapshotIfPossible(sourcePaths.dbPath, sourcePaths.snapshotDir);\n\t\t\t\twriteAtomicJsonFile(sourcePaths.dbPath, { ...sourceDb, swimmers: rows });\n\t\t\t}`;

  const compactSafe = `\t\t\tif (swimmerIndex >= 0) {\n\t\t\t\t// ${marker}\n\t\t\t\tconst currentSourceRow = rows[swimmerIndex] && typeof rows[swimmerIndex] === 'object' ? rows[swimmerIndex] : {};\n\t\t\t\tconst rejectionMatchesCurrent = String(currentSourceRow?.coachLinkRequestId || '').trim() === requestId\n\t\t\t\t\t&& normalizeTenantId(currentSourceRow?.coachTargetTenantId) === actorTenantId\n\t\t\t\t\t&& String(currentSourceRow?.coachLinkStatus || '').trim().toLowerCase() === 'pending';\n\t\t\t\tif (rejectionMatchesCurrent) {\n\t\t\t\t\trows[swimmerIndex] = {\n\t\t\t\t\t\t...currentSourceRow,\n\t\t\t\t\t\tcoachConnected: false, coachLinkStatus: 'none', coachEmail: '', coachCode: '', coachPhase: '',\n\t\t\t\t\t\tcoachRequestAt: '', coachReplyAt: rejectedAt, coachApprovalAt: '', coachLinkRequestId: '', coachTargetTenantId: '', shareMode: 'Feedback link only',\n\t\t\t\t\t};\n\t\t\t\t\twriteDbSnapshotIfPossible(sourcePaths.dbPath, sourcePaths.snapshotDir);\n\t\t\t\t\twriteAtomicJsonFile(sourcePaths.dbPath, { ...sourceDb, swimmers: rows });\n\t\t\t\t}\n\t\t\t}`;

  if (!rejectSource.includes(compactOld)) throw new Error('Current compact coach-link rejection write block not found.');
  rejectSource = rejectSource.replace(compactOld, compactSafe);
}

for (const token of [
  marker,
  'rejectionMatchesCurrent',
  "String(currentSourceRow?.coachLinkRequestId || '').trim() === requestId",
  'normalizeTenantId(currentSourceRow?.coachTargetTenantId) === actorTenantId',
  "String(currentSourceRow?.coachLinkStatus || '').trim().toLowerCase() === 'pending'",
]) if (!rejectSource.includes(token)) throw new Error(`Coach-link rejection stale guard missing: ${token}`);

source = source.slice(0, rejectStart) + rejectSource + source.slice(disconnectStart);
fs.writeFileSync(indexPath, source, 'utf8');
console.log('COACH_LINK_REJECTION_STALE_GUARD_OK');
