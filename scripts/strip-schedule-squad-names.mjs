#!/usr/bin/env node
/**
 * Strip denormalised `squadNames` from schedule rows.
 *
 * Problem:
 *   3,443 schedule rows carry `squadNames: [...]` alongside `squadIds: [...]`.
 *   When a squad is renamed, the 21-row `squads` table updates and the 3,443
 *   `squadNames` copies do not. 314 rows are currently stale.
 *   Squad names should be resolved on render from squads[].name, never stored.
 *
 * Fix:
 *   Delete the `squadNames` field from every schedule row. Frontend rendering
 *   should already resolve names via squadIds -> squads[].name.
 *
 * Modes:
 *   --dry-run (default) / --apply --out=path / --write-in-place
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flags = new Map();
let positional = [];
for (const a of args) {
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags.set(k, v ?? true); }
  else positional.push(a);
}
const source = path.resolve(positional[0] || 'storage/db.json');
const apply = flags.has('apply');
const writeInPlace = flags.has('write-in-place');
const outPath = flags.get('out') ? path.resolve(flags.get('out')) : (writeInPlace ? source : path.resolve('./reconciled-db.json'));

if (!fs.existsSync(source)) { console.error('FATAL: not found', source); process.exit(2); }
const db = JSON.parse(fs.readFileSync(source, 'utf8'));

const schedule = Array.isArray(db.schedule) ? db.schedule : [];
const withField = schedule.filter((r) => Array.isArray(r?.squadNames) && r.squadNames.length > 0).length;

console.log('=== STRIP SCHEDULE squadNames ' + (apply ? '(APPLY)' : '(DRY-RUN)') + ' ===');
console.log(`source: ${source}`);
console.log(`schedule rows carrying squadNames: ${withField} / ${schedule.length}`);

if (withField === 0) {
  console.log('Nothing to strip.'); process.exit(0);
}

const nextSchedule = schedule.map((r) => {
  if (!r || !Array.isArray(r.squadNames)) return r;
  const { squadNames, ...rest } = r;
  return rest;
});

const projected = {
  ...db,
  schedule: nextSchedule,
  __meta: { ...(db.__meta || {}), updatedAt: new Date().toISOString() },
};

if (!apply) {
  console.log('Dry-run only. Re-run with --apply --out=/path/to/output.json to persist.');
  process.exit(1);
}

fs.writeFileSync(outPath, JSON.stringify(projected, null, 2) + '\n');
console.log(`Written to: ${outPath}`);
