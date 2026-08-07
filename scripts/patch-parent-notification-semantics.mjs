import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_PARENT_NOTIFICATION_ONLY';
if (!source.includes(marker)) {
  const unsafe = `\tconst age = ageFromDob(dob);\n\tif (linkStatus === 'approved' && Number.isFinite(age) && age < 18) {\n\t\tif (!parent1) issues.push('Under-18 approvals require parent email 1.');\n\t\tif (!parent1Consent) issues.push('Under-18 approvals require parent 1 consent.');\n\t\tif (parent2 && !parent2Consent) issues.push('Parent 2 consent is required when parent email 2 is provided.');\n\t}`;
  const safe = `\t${marker}\n\t// Parent emails are optional notification destinations. They are not an\n\t// approval authority and consent flags must not control coach-link state.\n\tconst age = ageFromDob(dob);\n\tif (Number.isFinite(age) && age < 18) {\n\t\tif (source?.parent1 && !parent1) issues.push('Parent email 1 is invalid.');\n\t\tif (source?.parent2 && !parent2) issues.push('Parent email 2 is invalid.');\n\t}`;
  if (!source.includes(unsafe)) throw new Error('Under-18 parent-approval anchor was not found.');
  source = source.replace(unsafe, safe);
}

for (const forbidden of [
  'Under-18 approvals require parent email 1.',
  'Under-18 approvals require parent 1 consent.',
  'Parent 2 consent is required when parent email 2 is provided.',
]) if (source.includes(forbidden)) throw new Error(`Parent approval requirement still remains: ${forbidden}`);
for (const required of ['ATHLYRAX_PARENT_NOTIFICATION_ONLY', 'Parent email 1 is invalid.', 'Parent email 2 is invalid.']) {
  if (!source.includes(required)) throw new Error(`Parent notification semantic hardening missing: ${required}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('PARENT_NOTIFICATION_SEMANTICS_OK');
