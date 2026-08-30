import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

function replaceRequired(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`${label} anchor was not found.`);
  source = source.replace(needle, replacement);
}

const identityAnchor = `const CANONICAL_TENANT_BY_USERNAME = Object.freeze({\n\t'demo.coach': 'demo-company',\n});`;
const identityReplacement = `${identityAnchor}\n// ATHLYRAX_PUBLIC_DEMO_CANONICAL_IDENTITY\nconst PUBLIC_DEMO_USERNAME = 'demo.coach';\nconst PUBLIC_DEMO_TENANT_ID = 'demo-company';\nfunction enforcePublicDemoCanonicalIdentity(value) {\n\tif (!value || typeof value !== 'object') return value;\n\tconst username = String(value?.username || value?.sub || '').trim().toLowerCase();\n\tif (username !== PUBLIC_DEMO_USERNAME) return value;\n\treturn {\n\t\t...value,\n\t\tusername: PUBLIC_DEMO_USERNAME,\n\t\tsub: value?.sub ? PUBLIC_DEMO_USERNAME : value?.sub,\n\t\trole: 'head-coach',\n\t\ttenantId: PUBLIC_DEMO_TENANT_ID,\n\t\tclubId: PUBLIC_DEMO_TENANT_ID,\n\t};\n}`;
replaceRequired(identityAnchor, identityReplacement, 'Public demo identity guard');

replaceRequired(
  `\treq.auth = token ? verifyAuthToken(token) : null;\n\treq.cookies = cookies;`,
  `\treq.auth = token ? enforcePublicDemoCanonicalIdentity(verifyAuthToken(token)) : null;\n\treq.cookies = cookies;`,
  'Authenticated request public demo canonical identity',
);

replaceRequired(
  `function buildAuthUserPayload(user) {\n\tconst normalizedUser = user && typeof user === 'object' ? user : {};`,
  `function buildAuthUserPayload(user) {\n\tconst normalizedUser = enforcePublicDemoCanonicalIdentity(user && typeof user === 'object' ? user : {});`,
  'Public auth payload public demo canonical identity',
);

for (const token of [
  'ATHLYRAX_PUBLIC_DEMO_CANONICAL_IDENTITY',
  "const PUBLIC_DEMO_USERNAME = 'demo.coach';",
  "role: 'head-coach'",
  'enforcePublicDemoCanonicalIdentity(verifyAuthToken(token))',
  'const normalizedUser = enforcePublicDemoCanonicalIdentity(',
]) {
  if (!source.includes(token)) throw new Error(`Public demo canonical identity verification failed: ${token}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('PUBLIC_DEMO_CANONICAL_IDENTITY_OK');
