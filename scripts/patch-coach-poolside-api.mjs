import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const indexPath = path.join(root, 'index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
const importLine = "import { buildCoachPoolsideProjection } from './coach-poolside-projection.mjs';";
if (!source.includes(importLine)) {
  const anchor = "import Stripe from 'stripe';";
  if (!source.includes(anchor)) throw new Error('Coach Poolside import anchor is missing.');
  source = source.replace(anchor, anchor + '\n' + importLine);
}
const marker = '// ATHLYRAX_COACH_POOLSIDE_PROJECTION_V1';
if (!source.includes(marker)) {
  const anchor = '// Serve db.json at /db';
  if (!source.includes(anchor)) throw new Error('Coach Poolside route anchor is missing.');
  const route = `${marker}
app.get('/coach/poolside', requireStrictAuth, (req, res) => {
\tconst role = String(req.auth?.role || '').trim().toLowerCase();
\tif (!['software-owner', 'head-coach', 'assistant-coach', 'viewer'].includes(role)) {
\t\tres.status(403).json({ error: 'Coach account required.' });
\t\treturn;
\t}
\tconst tenantScope = resolveStoragePathsForRequest(req);
\tif (!tenantScope?.ok || !tenantScope?.storagePaths?.dbPath) {
\t\tres.status(Number(tenantScope?.status || tenantScope?.errorStatus || 403)).json(tenantScope?.body || { error: 'Tenant scope denied.' });
\t\treturn;
\t}
\tconst db = readJsonFile(tenantScope.storagePaths.dbPath);
\tif (!db || typeof db !== 'object' || Array.isArray(db)) {
\t\tres.status(503).json({ error: 'Coach Poolside data is temporarily unavailable.' });
\t\treturn;
\t}
\tres.status(200).json({ ok: true, ...buildCoachPoolsideProjection(db, { date: req.query?.date }) });
});

`;
  source = source.replace(anchor, route + anchor);
}
fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_COACH_POOLSIDE_PROJECTION_OK');
