import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_PRODUCTION_CORS_FRONTEND_ORIGINS';
if (!source.includes(marker)) {
  const unsafe = `function parseAllowedOrigins() {\n\tconst raw = String(process.env.ALLOWED_ORIGINS || '').trim();\n\tif (!raw) return new Set(DEFAULT_ALLOWED_ORIGINS);\n\treturn new Set(\n\t\traw\n\t\t\t.split(',')\n\t\t\t.map((value) => String(value || '').trim())\n\t\t\t.filter(Boolean)\n\t);\n}`;
  const safe = `function parseAllowedOrigins() {\n\t${marker}\n\tconst requiredProductionOrigins = IS_PRODUCTION\n\t\t? ['https://athlyrax.com', 'https://www.athlyrax.com']\n\t\t: [];\n\tconst raw = String(process.env.ALLOWED_ORIGINS || '').trim();\n\tconst configuredOrigins = raw\n\t\t? raw.split(',').map((value) => String(value || '').trim()).filter(Boolean)\n\t\t: DEFAULT_ALLOWED_ORIGINS;\n\treturn new Set([...configuredOrigins, ...requiredProductionOrigins]);\n}`;
  if (!source.includes(unsafe)) throw new Error('CORS allowed-origin parser anchor was not found.');
  source = source.replace(unsafe, safe);
}

for (const token of [
  'ATHLYRAX_PRODUCTION_CORS_FRONTEND_ORIGINS',
  "'https://athlyrax.com'",
  "'https://www.athlyrax.com'",
  'return new Set([...configuredOrigins, ...requiredProductionOrigins]);',
]) if (!source.includes(token)) throw new Error(`Production CORS hardening missing: ${token}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('PRODUCTION_CORS_ORIGINS_OK');
