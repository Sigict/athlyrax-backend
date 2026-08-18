import fs from 'node:fs';

const path = 'scripts/patch-coach-link-integrity.mjs';
let source = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('  const putSafeBodyOld =');
const end = source.indexOf('\n\n  source = `${marker}', start);
if (start < 0 || end <= start) throw new Error('Coach-link generic DB PUT anchor block missing.');

const replacement = `  const putSafeBodyOld = \`\\t\\tconst safeBody = {\\n\\t\\t\\t...filtered.dbShape,\\n\\t\\t\\t__tombstones: mergedTombstones,\\n\\t\\t};\`;
  const putSafeBodyOccurrence = \`\\t\\tconst safeBody = {\\n\\t\\t\\t...occurrenceFiltered.dbShape,\\n\\t\\t\\t__tombstones: mergedTombstones,\\n\\t\\t\\t__meta: {\\n\\t\\t\\t\\t...(occurrenceFiltered.dbShape?.__meta || {}),\\n\\t\\t\\t\\tscheduleOccurrenceSuppressions: mergedScheduleOccurrenceSuppressions,\\n\\t\\t\\t},\\n\\t\\t};\`;
  const putSafeBodyNewOld = \`\\t\\t// ATHLYRAX_COACH_LINK_REQUESTS_PRESERVED_ON_GENERIC_DB_WRITE\\n\\t\\tconst safeBody = {\\n\\t\\t\\t...filtered.dbShape,\\n\\t\\t\\t__tombstones: mergedTombstones,\\n\\t\\t\\tcoachLinkRequests: Array.isArray(currentDb?.coachLinkRequests) ? currentDb.coachLinkRequests : [],\\n\\t\\t};\`;
  const putSafeBodyNewOccurrence = \`\\t\\t// ATHLYRAX_COACH_LINK_REQUESTS_PRESERVED_ON_GENERIC_DB_WRITE\\n\\t\\tconst safeBody = {\\n\\t\\t\\t...occurrenceFiltered.dbShape,\\n\\t\\t\\t__tombstones: mergedTombstones,\\n\\t\\t\\t__meta: {\\n\\t\\t\\t\\t...(occurrenceFiltered.dbShape?.__meta || {}),\\n\\t\\t\\t\\tscheduleOccurrenceSuppressions: mergedScheduleOccurrenceSuppressions,\\n\\t\\t\\t},\\n\\t\\t\\tcoachLinkRequests: Array.isArray(currentDb?.coachLinkRequests) ? currentDb.coachLinkRequests : [],\\n\\t\\t};\`;
  if (!source.includes('ATHLYRAX_COACH_LINK_REQUESTS_PRESERVED_ON_GENERIC_DB_WRITE')) {
    if (source.includes(putSafeBodyOccurrence)) {
      source = source.replace(putSafeBodyOccurrence, putSafeBodyNewOccurrence);
    } else if (source.includes(putSafeBodyOld)) {
      source = source.replace(putSafeBodyOld, putSafeBodyNewOld);
    } else {
      throw new Error('Generic DB PUT preservation anchor not found.');
    }
  }`;

source = source.slice(0, start) + replacement + source.slice(end);
fs.writeFileSync(path, source);
console.log('COACH_LINK_BUILD_ANCHOR_OCCURRENCE_GUARD_OK');
