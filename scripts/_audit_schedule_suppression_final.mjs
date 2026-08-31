import fs from 'node:fs';
const source = fs.readFileSync('index.js', 'utf8').replace(/\r\n/g, '\n');
const lines = source.split('\n');
function printFunction(name, nextName) {
  const startToken = `function ${name}`;
  const start = lines.findIndex((line) => line.includes(startToken));
  if (start < 0) throw new Error(`missing ${name}`);
  let end = lines.length;
  if (nextName) {
    const next = lines.findIndex((line, index) => index > start && line.includes(`function ${nextName}`));
    if (next > start) end = next;
  } else {
    end = Math.min(lines.length, start + 220);
  }
  console.log(`${name}_START line=${start + 1}`);
  console.log(lines.slice(start, end).map((value, offset) => `${start + offset + 1}: ${value}`).join('\n'));
  console.log(`${name}_END`);
}
printFunction('getScheduleOccurrenceIdentityParts', 'getScheduleOccurrenceIdentityKey');
printFunction('getScheduleOccurrenceIdentityKey', 'normalizeScheduleOccurrenceSuppressionEntry');
printFunction('normalizeScheduleOccurrenceSuppressionEntry', 'mergeScheduleOccurrenceSuppressionLists');
printFunction('mergeScheduleOccurrenceSuppressionLists', 'applyScheduleOccurrenceSuppressionsToDbShape');
printFunction('applyScheduleOccurrenceSuppressionsToDbShape', null);
