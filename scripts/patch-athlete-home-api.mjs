import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const indexPath = path.join(root, 'index.js');
const projectionPath = path.join(root, 'athlete-home-projection.mjs');
const marker = 'ATHLYRAX_SCOPED_ATHLETE_HOME_API_V1';

if (!fs.existsSync(indexPath)) throw new Error('index.js is missing.');
if (!fs.existsSync(projectionPath)) throw new Error('athlete-home-projection.mjs is missing.');

let source = fs.readFileSync(indexPath, 'utf8');
const importLine = "import { buildAthleteHomeProjection } from './athlete-home-projection.mjs';";
if (!source.includes(importLine)) {
  const importMarker = "import helmet from 'helmet';";
  if (!source.includes(importMarker)) throw new Error('Could not locate helmet import for athlete-home projection import.');
  source = source.replace(importMarker, `${importMarker}\n${importLine}`);
}

if (!source.includes("app.get('/swimmer/athlete-home'")) {
  const dbMarker = '// Serve db.json at /db';
  if (!source.includes(dbMarker)) throw new Error('Could not locate /db route marker for athlete-home insertion.');
  const route = `// ${marker}\napp.get('/swimmer/athlete-home', requireStrictAuth, requireSwimmerRole, (req, res) => {\n\tconst paths = resolveStoragePathsForRequest(req);\n\tif (paths?.error) {\n\t\tres.status(Number(paths.errorStatus || 403)).json({ error: String(paths.error || 'Tenant scope denied.') });\n\t\treturn;\n\t}\n\tensureStorageLayout(paths);\n\tfs.readFile(paths.dbPath, 'utf8', (err, data) => {\n\t\tif (err) {\n\t\t\tres.status(500).json({ error: 'Could not read athlete data.' });\n\t\t\treturn;\n\t\t}\n\t\ttry {\n\t\t\tconst db = JSON.parse(String(data || '{}'));\n\t\t\tconst authUser = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};\n\t\t\tconst projection = buildAthleteHomeProjection(db, authUser);\n\t\t\tif (!projection) {\n\t\t\t\tres.status(404).json({ error: 'Athlete profile not found.' });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tres.status(200).json({ ok: true, ...projection });\n\t\t} catch (error) {\n\t\t\tres.status(500).json({ error: 'Could not build athlete home.', details: error instanceof Error ? error.message : 'Unknown error' });\n\t\t}\n\t});\n});\n\n`;
  source = source.replace(dbMarker, `${route}${dbMarker}`);
}

if (!source.includes(marker)) {
  const routeToken = "app.get('/swimmer/athlete-home', requireStrictAuth, requireSwimmerRole";
  if (!source.includes(routeToken)) throw new Error('Athlete-home route exists but cannot be verified.');
  source = source.replace(routeToken, `// ${marker}\n${routeToken}`);
}

for (const required of [
  importLine,
  marker,
  "app.get('/swimmer/athlete-home', requireStrictAuth, requireSwimmerRole",
  'resolveStoragePathsForRequest(req)',
  'buildAthleteHomeProjection(db, authUser)',
]) {
  if (!source.includes(required)) throw new Error(`Athlete-home production transform missing required token: ${required}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_SCOPED_ATHLETE_HOME_API_OK');
