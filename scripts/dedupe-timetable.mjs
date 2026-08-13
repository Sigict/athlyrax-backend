#!/usr/bin/env node
/**
 * Timetable dedupe reconciliation.
 *
 * Problem:
 *   The legacy singular `timetable[]` collection has 133 excess rows across 67
 *   duplicate natural-key sets (weekday, start, end, squads, venue). These are
 *   physical copies of the same logical template that were introduced by
 *   multi-tab / coach-id-drift PUTs. The frontend's read-time merge (in
 *   `canonicalTimetable.js` and `scheduleDedupe.js`) hides them at render time
 *   but never cleans storage.
 *
 * Fix strategy:
 *   Group rows by natural key. For each group, keep the oldest by `createdAt`
 *   (falling back to whichever row appears first in the array). Union the
 *   `coachIds` and `squadIds` from every duplicate into the survivor. Emit a
 *   tombstone for each removed row so any stale client copy cannot resurrect
 *   the duplicate on next PUT.
 *
 * Modes:
 *   --dry-run  (default)  read-only report.
 *   --apply --out=path.json    writes a new db.json.
 *   --write-in-place    override --out and rewrite the source.
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flags = new Map();
let positional = [];
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags.set(k, v ?? true);
  } else positional.push(a);
}

const source = path.resolve(positional[0] || 'storage/db.json');
const apply = flags.has('apply');
const writeInPlace = flags.has('write-in-place');
const outPath = flags.get('out')
  ? path.resolve(flags.get('out'))
  : (writeInPlace ? source : path.resolve('./reconciled-db.json'));

if (!fs.existsSync(source)) {
  console.error('FATAL: db.json not found at', source);
  process.exit(2);
}

const db = JSON.parse(fs.readFileSync(source, 'utf8'));

function natKey(row) {
  return [
    row?.weekdayNum ?? row?.weekdayNumber ?? row?.dayNumber ?? '',
    String(row?.startTime || '').trim(),
    String(row?.endTime || '').trim(),
    [...(row?.squadIds || [])].map(String).sort().join(','),
    String(row?.venueId || '').trim(),
  ].join('|');
}

function dedupeCollection(rows, collectionName) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const k = natKey(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  const survivors = [];
  const removed = [];
  for (const [, members] of groups.entries()) {
    if (members.length === 1) { survivors.push(members[0]); continue; }
    // Pick oldest by createdAt; break ties by earliest position.
    const sorted = [...members].sort((a, b) => {
      const at = Date.parse(String(a?.createdAt || '')) || 0;
      const bt = Date.parse(String(b?.createdAt || '')) || 0;
      return at - bt;
    });
    const [keeper, ...rest] = sorted;
    // Union coachIds and squadIds from every row in the group
    const unionCoach = new Set([...(keeper.coachIds || [])].map(String));
    const unionSquad = new Set([...(keeper.squadIds || [])].map(String));
    for (const dup of rest) {
      for (const c of (dup.coachIds || [])) unionCoach.add(String(c));
      for (const s of (dup.squadIds || [])) unionSquad.add(String(s));
      removed.push({ collection: collectionName, id: String(dup.id || '').trim() });
    }
    survivors.push({
      ...keeper,
      coachIds: Array.from(unionCoach),
      squadIds: Array.from(unionSquad),
    });
  }
  return { survivors, removed };
}

const timetableResult = dedupeCollection(db.timetable, 'timetable');
const slotsResult = dedupeCollection(db.timetableSlots, 'timetableSlots');

console.log('=== TIMETABLE DEDUPE ' + (apply ? '(APPLY)' : '(DRY-RUN)') + ' ===');
console.log(`source: ${source}`);
console.log(`timetable[]:      ${(db.timetable || []).length} -> ${timetableResult.survivors.length}  (removed: ${timetableResult.removed.length})`);
console.log(`timetableSlots[]: ${(db.timetableSlots || []).length} -> ${slotsResult.survivors.length}  (removed: ${slotsResult.removed.length})`);

if (timetableResult.removed.length + slotsResult.removed.length === 0) {
  console.log('No duplicates found — nothing to do.');
  process.exit(0);
}

// Build tombstone list (union with any existing)
const now = new Date().toISOString();
const existing = Array.isArray(db.__tombstones) ? db.__tombstones : [];
const byKey = new Map();
for (const e of existing) {
  if (!e?.collection || !e?.id) continue;
  byKey.set(`${e.collection}|${e.id}`, e);
}
for (const r of [...timetableResult.removed, ...slotsResult.removed]) {
  if (!r.id) continue;
  byKey.set(`${r.collection}|${r.id}`, {
    collection: r.collection,
    id: r.id,
    deletedAt: now,
    deletedBy: 'reconciliation-script',
  });
}
const tombstones = Array.from(byKey.values());

const projected = {
  ...db,
  timetable: timetableResult.survivors,
  timetableSlots: slotsResult.survivors,
  __tombstones: tombstones,
  __meta: { ...(db.__meta || {}), updatedAt: now },
};

if (!apply) {
  console.log('\nDry-run only. Sample removed timetable ids:');
  for (const r of timetableResult.removed.slice(0, 10)) console.log(`  - ${r.id}`);
  console.log('Re-run with --apply --out=/path/to/output.json to persist.');
  process.exit(1);
}

fs.writeFileSync(outPath, JSON.stringify(projected, null, 2) + '\n');
console.log(`Written to: ${outPath}`);
