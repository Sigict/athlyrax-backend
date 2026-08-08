import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_ROUTE_SCOPED_JSON_BODY_LIMITS';
if (!source.includes(marker)) {
  const oldParser = `app.use(express.json({ limit: '25mb' }));`;
  const scopedParsers = `${marker}\n// Full club database replacement and swimmer evidence sync can legitimately be\n// larger than ordinary authentication/settings/snapshot requests. Keep their\n// existing ceiling while reducing the anonymous/general parser attack surface.\napp.use('/db', express.json({ limit: '25mb' }));\napp.use('/swimmer/profile/sync', express.json({ limit: '25mb' }));\napp.use(express.json({ limit: '5mb' }));`;
  if (!source.includes(oldParser)) throw new Error('Global JSON body-limit anchor was not found.');
  source = source.replace(oldParser, scopedParsers);
}

for (const token of [
  'ATHLYRAX_ROUTE_SCOPED_JSON_BODY_LIMITS',
  "app.use('/db', express.json({ limit: '25mb' }));",
  "app.use('/swimmer/profile/sync', express.json({ limit: '25mb' }));",
  "app.use(express.json({ limit: '5mb' }));",
]) if (!source.includes(token)) throw new Error(`Request body hardening missing: ${token}`);

if (source.includes(`app.use(express.json({ limit: '25mb' }));`)) {
  throw new Error('Unscoped 25 MB JSON parser remains.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('REQUEST_BODY_LIMITS_OK');
