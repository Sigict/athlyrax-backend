import fs from 'node:fs';

const path = 'index.js';
const raw = fs.readFileSync(path, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let source = raw.replace(/\r\n/g, '\n');

const dateHelper = `function getScheduleOccurrenceDate(row) {\n\treturn scheduleOccurrenceText(row?.scheduleDate || row?.rawDate || row?.date || row?.plannedDate).slice(0, 10);\n}\n`;
const dateWithTime = `${dateHelper}\nfunction getScheduleOccurrenceTime(value) {\n\tconst rawValue = scheduleOccurrenceText(value);\n\tconst match = rawValue.match(/^(\\d{1,2})[.:](\\d{2})(?::(\\d{2}))?$/);\n\tif (!match) return '';\n\tconst hour = Number(match[1]);\n\tconst minute = Number(match[2]);\n\tconst second = match[3] === undefined ? 0 : Number(match[3]);\n\tif (!Number.isInteger(hour) || hour < 0 || hour > 23) return '';\n\tif (!Number.isInteger(minute) || minute < 0 || minute > 59) return '';\n\tif (!Number.isInteger(second) || second < 0 || second > 59) return '';\n\treturn \`${'${String(hour).padStart(2, \'0\')}:${String(minute).padStart(2, \'0\')}'}\`;\n}\n`;
if (!source.includes(dateHelper)) throw new Error('Backend Schedule date helper anchor not found');
source = source.replace(dateHelper, dateWithTime);

const oldTimes = `\tconst startTime = scheduleOccurrenceText(row?.startTime);\n\tconst endTime = scheduleOccurrenceText(row?.endTime);`;
const newTimes = `\tconst startTime = getScheduleOccurrenceTime(row?.startTime);\n\tconst endTime = getScheduleOccurrenceTime(row?.endTime);`;
if (!source.includes(oldTimes)) throw new Error('Backend fingerprint time anchor not found');
source = source.replace(oldTimes, newTimes);

for (const token of [
  'function getScheduleOccurrenceTime(value)',
  'const startTime = getScheduleOccurrenceTime(row?.startTime);',
  'const endTime = getScheduleOccurrenceTime(row?.endTime);',
]) {
  if (!source.includes(token)) throw new Error(`Backend Schedule time safety token missing: ${token}`);
}

const output = eol === '\r\n' ? source.replace(/\n/g, '\r\n') : source;
fs.writeFileSync(path, output, 'utf8');
console.log('BACKEND_SCHEDULE_TIME_IDENTITY_SAFETY_OK');
