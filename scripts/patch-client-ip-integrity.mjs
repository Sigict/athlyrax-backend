import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_PROXY_OBSERVED_CLIENT_IP';
if (!source.includes(marker)) {
  const oldFunction = `function resolveClientKey(req) {\n\tconst forwarded = String(req.headers?.['x-forwarded-for'] || '').trim();\n\tif (forwarded) {\n\t\treturn forwarded.split(',')[0].trim();\n\t}\n\treturn String(req.socket?.remoteAddress || req.ip || 'unknown').trim() || 'unknown';\n}`;
  const safeFunction = `function resolveClientKey(req) {\n\t${marker}\n\tconst forwarded = String(req.headers?.['x-forwarded-for'] || '').trim();\n\tif (forwarded) {\n\t\tconst chain = forwarded.split(',').map((value) => String(value || '').trim()).filter(Boolean);\n\t\tif (chain.length > 0) return chain[chain.length - 1];\n\t}\n\treturn String(req.socket?.remoteAddress || req.ip || 'unknown').trim() || 'unknown';\n}`;
  if (!source.includes(oldFunction)) throw new Error('Client IP resolution anchor was not found.');
  source = source.replace(oldFunction, safeFunction);
}

if (!source.includes(marker) || !source.includes('return chain[chain.length - 1];')) {
  throw new Error('Proxy-observed client IP hardening is missing.');
}
if (source.includes("return forwarded.split(',')[0].trim();")) {
  throw new Error('Spoofable leftmost X-Forwarded-For selection remains.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('CLIENT_IP_INTEGRITY_OK');
