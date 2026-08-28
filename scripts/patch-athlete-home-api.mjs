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

const dbMarker = '// Serve db.json at /db';
if (!source.includes(dbMarker)) throw new Error('Could not locate /db route marker for athlete-home insertion.');

const route = `// ${marker}\napp.get('/swimmer/athlete-home', requireStrictAuth, requireSwimmerRole, (req, res) => {\n\tconst paths = resolveStoragePathsForRequest(req);\n\tif (paths?.error) {\n\t\tres.status(Number(paths.errorStatus || 403)).json({ error: String(paths.error || 'Tenant scope denied.') });\n\t\treturn;\n\t}\n\tensureStorageLayout(paths);\n\tconst db = readJsonFile(paths.dbPath);\n\tif (!db || typeof db !== 'object' || Array.isArray(db)) {\n\t\tres.status(503).json({ error: 'Athlete data is temporarily unavailable.' });\n\t\treturn;\n\t}\n\tconst authUser = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};\n\tconst projection = buildAthleteHomeProjection(db, authUser);\n\tif (!projection) {\n\t\tres.status(404).json({ error: 'Athlete profile not found.' });\n\t\treturn;\n\t}\n\tres.status(200).json({ ok: true, ...projection });\n});\n\n`;

const existingRouteStart = source.indexOf("app.get('/swimmer/athlete-home'");
if (existingRouteStart >= 0) {
  let replacementStart = existingRouteStart;
  const markerStart = source.lastIndexOf(`// ${marker}`, existingRouteStart);
  if (markerStart >= 0 && existingRouteStart - markerStart < 100) replacementStart = markerStart;
  const dbMarkerIndex = source.indexOf(dbMarker, existingRouteStart);
  if (dbMarkerIndex < 0) throw new Error('Existing athlete-home route has no following /db marker.');
  source = source.slice(0, replacementStart) + route + source.slice(dbMarkerIndex);
} else {
  source = source.replace(dbMarker, `${route}${dbMarker}`);
}

for (const required of [
  importLine,
  marker,
  "app.get('/swimmer/athlete-home', requireStrictAuth, requireSwimmerRole",
  'resolveStoragePathsForRequest(req)',
  'const db = readJsonFile(paths.dbPath);',
  'buildAthleteHomeProjection(db, authUser)',
]) {
  if (!source.includes(required)) throw new Error(`Athlete-home production transform missing required token: ${required}`);
}
if (source.includes("fs.readFile(paths.dbPath, 'utf8'")) {
  throw new Error('Legacy asynchronous athlete-home database read remains.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_SCOPED_ATHLETE_HOME_API_OK');
