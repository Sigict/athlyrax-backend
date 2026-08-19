import fs from 'node:fs';

const path = 'index.js';
const raw = fs.readFileSync(path, 'utf8');
let source = raw.replace(/\r\n/g, '\n');
let changed = false;

const canonicalOnly = "\t\t\tif (collection === 'schedule' && rowId) blockedScheduleIds.add(rowId);";
const anyBlockedSource = "\t\t\tif (rowId) blockedScheduleIds.add(rowId);";
if (source.includes(canonicalOnly)) {
  source = source.replace(canonicalOnly, anyBlockedSource);
  changed = true;
}
if (!source.includes(anyBlockedSource)) throw new Error('Blocked Schedule-id cascade guard missing.');

const getAnchor = "\t\t\tlet responsePayload = data;\n\t\t\tconst role = String(req.auth?.role || '').trim().toLowerCase();";
const getGuard = `\t\t\tlet responsePayload = data;\n\t\t\ttry {\n\t\t\t\tconst persistedShape = JSON.parse(String(data || '{}'));\n\t\t\t\tconst persistedSuppressions = Array.isArray(persistedShape?.__meta?.scheduleOccurrenceSuppressions)\n\t\t\t\t\t? persistedShape.__meta.scheduleOccurrenceSuppressions\n\t\t\t\t\t: [];\n\t\t\t\tconst readFiltered = applyScheduleOccurrenceSuppressionsToDbShape(persistedShape, persistedSuppressions);\n\t\t\t\tresponsePayload = JSON.stringify(readFiltered.dbShape);\n\t\t\t} catch {\n\t\t\t\t// Invalid db.json is handled by the storage safety layer; preserve the original response here.\n\t\t\t}\n\t\t\tconst role = String(req.auth?.role || '').trim().toLowerCase();`;
if (!source.includes('const readFiltered = applyScheduleOccurrenceSuppressionsToDbShape(persistedShape, persistedSuppressions);')) {
  if (!source.includes(getAnchor)) throw new Error('GET /db response anchor missing.');
  source = source.replace(getAnchor, getGuard);
  changed = true;
}

const swimmerRawParse = "\t\t\t\t\tconst parsed = JSON.parse(String(data || '{}'));";
const swimmerFilteredParse = "\t\t\t\t\tconst parsed = JSON.parse(String(responsePayload || '{}'));";
if (source.includes(swimmerRawParse)) {
  source = source.replace(swimmerRawParse, swimmerFilteredParse);
  changed = true;
}
if (!source.includes(swimmerFilteredParse)) throw new Error('Swimmer GET parse must use filtered response payload.');

const blockedOld = '\t\t\tblockedResurrections: filtered.blockedResurrections,';
const blockedNew = `\t\t\tblockedResurrections: [\n\t\t\t\t...(Array.isArray(filtered.blockedResurrections) ? filtered.blockedResurrections : []),\n\t\t\t\t...(Array.isArray(occurrenceFiltered.blockedResurrections) ? occurrenceFiltered.blockedResurrections : []),\n\t\t\t],`;
if (source.includes(blockedOld)) {
  source = source.replace(blockedOld, blockedNew);
  changed = true;
}
if (!source.includes('...(Array.isArray(occurrenceFiltered.blockedResurrections) ? occurrenceFiltered.blockedResurrections : [])')) {
  throw new Error('Semantic blocked-resurrection reporting missing.');
}

const crlfSource = source.replace(/\n/g, '\r\n');
if (changed || raw !== crlfSource) fs.writeFileSync(path, crlfSource);
console.log(changed ? 'FINAL_SCHEDULE_OCCURRENCE_SERVER_GUARD_PATCHED' : 'FINAL_SCHEDULE_OCCURRENCE_SERVER_GUARD_FORMAT_VERIFIED');
