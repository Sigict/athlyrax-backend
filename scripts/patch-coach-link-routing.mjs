import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('ATHLYRAX_COACH_LINK_TENANT_OWNERSHIP_V1')) {
  throw new Error('Coach-link tenant ownership patch must run before routing hardening.');
}

const marker = '// ATHLYRAX_COACH_LINK_UNAMBIGUOUS_ROUTING_V1';
if (!source.includes(marker)) {
  const oldLookup = `function findCoachAccountByEmail(email) {\n\tconst target = String(email || '').trim().toLowerCase();\n\tif (!target) return null;\n\treturn authUsers.find((row) => {\n\t\tconst role = String(row?.role || '').trim().toLowerCase();\n\t\tif (role !== 'head-coach' && role !== 'assistant-coach') return false;\n\t\tif (row?.isApproved === false) return false;\n\t\treturn String(row?.email || '').trim().toLowerCase() === target;\n\t}) || null;\n}`;
  const newLookup = `function findCoachAccountsByEmail(email) {\n\t// ATHLYRAX_COACH_LINK_APPROVED_COACH_EMAIL_MATCHES_ONLY\n\tconst target = String(email || '').trim().toLowerCase();\n\tif (!target) return [];\n\treturn authUsers.filter((row) => {\n\t\tconst role = String(row?.role || '').trim().toLowerCase();\n\t\tif (role !== 'head-coach' && role !== 'assistant-coach') return false;\n\t\tif (row?.isApproved === false) return false;\n\t\treturn String(row?.email || '').trim().toLowerCase() === target;\n\t});\n}`;
  if (!source.includes(newLookup)) {
    if (!source.includes(oldLookup)) throw new Error('Coach email lookup routing anchor not found.');
    source = source.replace(oldLookup, newLookup);
  }

  const oldUse = `\tconst swimmerUser = findAuthUser(String(req.auth?.username || '').trim());\n\tconst coachUser = findCoachAccountByEmail(coachEmail);`;
  const newUse = `\tconst swimmerUser = findAuthUser(String(req.auth?.username || '').trim());\n\tconst coachMatches = findCoachAccountsByEmail(coachEmail);\n\tif (coachMatches.length > 1) {\n\t\tres.status(409).json({ error: 'More than one approved coach account uses that email. Ask the coach for a unique account email before connecting.' });\n\t\treturn;\n\t}\n\tconst coachUser = coachMatches[0] || null;`;
  if (!source.includes(newUse)) {
    if (!source.includes(oldUse)) throw new Error('Coach email request routing anchor not found.');
    source = source.replace(oldUse, newUse);
  }

  source = `${marker}\n${source}`;
}

for (const required of [
  'ATHLYRAX_COACH_LINK_UNAMBIGUOUS_ROUTING_V1',
  'ATHLYRAX_COACH_LINK_APPROVED_COACH_EMAIL_MATCHES_ONLY',
  'coachMatches.length > 1',
  'More than one approved coach account uses that email.',
]) if (!source.includes(required)) throw new Error(`Coach-link routing hardening missing: ${required}`);

if (source.includes('findCoachAccountByEmail(')) throw new Error('First-match coach email routing remains.');

fs.writeFileSync(indexPath, source, 'utf8');
console.log('COACH_LINK_ROUTING_PATCH_OK');
