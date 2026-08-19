import fs from 'node:fs';

const path = 'index.js';
const raw = fs.readFileSync(path, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let source = raw.replace(/\r\n/g, '\n');
const oldText = `\tconst sessionTypeId = scheduleOccurrenceText(row?.sessionTypeId || row?.trainingTypeId || row?.sessionType || row?.type);\n\tif (!timetableId && !startTime && !endTime && !venueId && squadIds.length === 0 && !sessionTypeId) return null;`;
const newText = `\tconst sessionTypeId = scheduleOccurrenceText(row?.sessionTypeId || row?.trainingTypeId || row?.sessionType || row?.type);\n\tconst timeEvidenceCount = Number(Boolean(startTime)) + Number(Boolean(endTime));\n\tconst contextEvidenceCount = Number(Boolean(timetableId))\n\t\t+ Number(Boolean(venueId))\n\t\t+ Number(squadIds.length > 0)\n\t\t+ Number(Boolean(sessionTypeId));\n\tconst hasSafeFingerprintEvidence = timeEvidenceCount >= 2\n\t\t|| (timeEvidenceCount >= 1 && contextEvidenceCount >= 1);\n\tif (!hasSafeFingerprintEvidence) return null;`;
if (!source.includes(oldText)) throw new Error('Backend legacy fingerprint safety anchor not found');
source = source.replace(oldText, newText);
const output = eol === '\r\n' ? source.replace(/\n/g, '\r\n') : source;
fs.writeFileSync(path, output, 'utf8');
console.log('BACKEND_SCHEDULE_LEGACY_FINGERPRINT_SAFETY_OK');
