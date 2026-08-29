import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const indexPath = path.join(root, 'index.js');
const helperPath = path.join(root, 'athlete-capability-projection.mjs');
const importLine = "import { buildAthleteCapabilityProjection } from './athlete-capability-projection.mjs';";
const projectionImport = "import { buildAthleteHomeProjection } from './athlete-home-projection.mjs';";
const marker = 'ATHLYRAX_ATHLETE_CAPABILITY_HOME_V1';

if (!fs.existsSync(indexPath)) throw new Error('index.js is missing.');
if (!fs.existsSync(helperPath)) throw new Error('athlete-capability-projection.mjs is missing.');

let source = fs.readFileSync(indexPath, 'utf8');
if (!source.includes(importLine)) {
  if (!source.includes(projectionImport)) throw new Error('Athlete-home projection import is missing.');
  source = source.replace(projectionImport, `${projectionImport}\n${importLine}`);
}

if (!source.includes(marker)) {
  const mergeLine = '\t\tconst projection = mergeAthleteHomeProjections(projections);';
  if (!source.includes(mergeLine)) throw new Error('Athlete-home projection merge point is missing.');
  source = source.replace(
    mergeLine,
    `${mergeLine}\n\t\t// ${marker}\n\t\tconst capabilityProjection = buildAthleteCapabilityProjection(snapshotSubmissions, authUser);\n\t\tif (capabilityProjection.integratedProfile) {\n\t\t\tprojection.integratedProfile = capabilityProjection.integratedProfile;\n\t\t\tprojection.disciplines = capabilityProjection.disciplines;\n\t\t}`,
  );
}

for (const required of [
  importLine,
  marker,
  'buildAthleteCapabilityProjection(snapshotSubmissions, authUser)',
  'projection.integratedProfile = capabilityProjection.integratedProfile',
  'projection.disciplines = capabilityProjection.disciplines',
]) {
  if (!source.includes(required)) throw new Error(`Athlete capability transform missing required token: ${required}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_ATHLETE_CAPABILITY_HOME_OK');
