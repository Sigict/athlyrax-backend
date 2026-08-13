#!/usr/bin/env node
/**
 * Coach ID reconciliation for a tenant db.json.
 *
 * Problem:
 *   coaches[].id values are legacy short numeric strings ("2", "4", "21").
 *   schedule[].coachIds and timetable[].coachIds contain a mix of legacy numeric
 *   IDs AND freshly-generated "coach_xxxx" prefixed IDs. The prefixed IDs have
 *   no matching coach record, so every UI lookup renders "Coach not found".
 *
 * Fix strategy:
 *   Best-effort remap each orphan "coach_xxxx" reference to a real coach by
 *   matching on any auxiliary signal we can find. The most reliable signal in
 *   this codebase is the co-occurrence of "coach_xxxx" IDs with legacy numeric
 *   IDs in the SAME timetable row's coachIds[] — if a legacy row survived and
 *   the client also stamped a new prefixed ID for the same human coach, the two
 *   would appear together. That's rare but useful.
 *
 *   For the remaining truly orphan prefixed IDs, we cannot invent a mapping
 *   safely from data alone (there is no name/email trail from the reference).
 *   These are reported as UNRESOLVED and require human review.
 *
 * The script has TWO modes:
 *   --dry-run  (default)  read-only, prints a report, writes nothing.
 *   --apply --out=path.json    writes a new db.json to `path` with the remaps
 *                              applied. Never overwrites the source file
 *                              unless --write-in-place is also passed.
 *
 * Usage:
 *   node scripts/reconcile-coach-ids.mjs [db.json] [--apply --out=path]
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
const coaches = Array.isArray(db.coaches) ? db.coaches : [];

const coachIdSet = new Set(coaches.map((c) => String(c.id || '').trim()));

// ---------------------------------------------------------------------------
// HUMAN-REVIEWED OVERRIDES: once the owner has looked at
// `coach-id-context-report.mjs` output and identified which real coach each
// unresolved `coach_xxx` corresponds to, drop the mapping here. Anything in
// this table wins over the automatic natural-key duplicate-pair heuristic.
// Set values to a real `coaches[].id` string.
// ---------------------------------------------------------------------------
const OVERRIDES = {
  // 'coach_46jay9nh': '22',
  // 'coach_hxyoub2y': '17',
};

function isPrefixed(id) { return /^coach_[a-z0-9]+$/i.test(String(id || '')); }
function isNumeric(id)  { return /^\d+$/.test(String(id || '')); }

// Pass 1: co-occurrence remap using timetable[] rows that contain BOTH a
// prefixed ID and a numeric ID that resolves to a real coach.
const cooccurrenceRemap = new Map(); // prefixed -> numeric

function harvestCooccurrence(rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const ids = Array.isArray(row?.coachIds) ? row.coachIds.map(String) : [];
    if (ids.length < 2) continue;
    const prefixed = ids.filter(isPrefixed);
    const numeric  = ids.filter((id) => isNumeric(id) && coachIdSet.has(id));
    if (prefixed.length === 1 && numeric.length === 1) {
      const [p] = prefixed, [n] = numeric;
      const prior = cooccurrenceRemap.get(p);
      if (!prior) cooccurrenceRemap.set(p, n);
      else if (prior !== n) cooccurrenceRemap.set(p, `AMBIGUOUS:${prior},${n}`);
    }
  }
}
harvestCooccurrence(db.timetable);
harvestCooccurrence(db.timetableSlots);
harvestCooccurrence(db.schedule);

// Pass 2: duplicate-pair remap. Timetable[] contains natural-key duplicates.
// If duplicate A has coachIds [numericID] and duplicate B has coachIds
// [prefixedID], and they share the same (weekday, start, end, squads, venue),
// treat prefixedID as an alias of numericID. This is the strongest data
// signal available for the client-driven half-migration situation.
function natKey(row) {
  return [
    row?.weekdayNum ?? row?.weekdayNumber ?? row?.dayNumber ?? '',
    String(row?.startTime || '').trim(),
    String(row?.endTime || '').trim(),
    [...(row?.squadIds || [])].map(String).sort().join(','),
    String(row?.venueId || '').trim(),
  ].join('|');
}
function harvestFromDuplicatePairs(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const k = natKey(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const numericSet = new Set();
    const prefixedSet = new Set();
    for (const row of members) {
      for (const cid of (row?.coachIds || [])) {
        const s = String(cid || '').trim();
        if (isPrefixed(s)) prefixedSet.add(s);
        else if (isNumeric(s) && coachIdSet.has(s)) numericSet.add(s);
      }
    }
    if (numericSet.size === 1 && prefixedSet.size === 1) {
      const [n] = numericSet;
      const [p] = prefixedSet;
      const prior = cooccurrenceRemap.get(p);
      if (!prior) cooccurrenceRemap.set(p, n);
      else if (prior !== n && !String(prior).startsWith('AMBIGUOUS')) {
        cooccurrenceRemap.set(p, `AMBIGUOUS:${prior},${n}`);
      }
    }
  }
}
harvestFromDuplicatePairs(db.timetable);
harvestFromDuplicatePairs(db.timetableSlots);

const cleanRemap = new Map();
const ambiguous = new Map();
for (const [k, v] of cooccurrenceRemap.entries()) {
  if (String(v).startsWith('AMBIGUOUS')) ambiguous.set(k, v);
  else cleanRemap.set(k, v);
}

// Pass 3: apply human overrides. These win over heuristic-derived mappings.
let overrideCount = 0;
for (const [prefixed, realId] of Object.entries(OVERRIDES)) {
  if (!isPrefixed(prefixed)) continue;
  const target = String(realId || '').trim();
  if (!target || !coachIdSet.has(target)) {
    console.warn(`OVERRIDES: '${prefixed}' -> '${realId}' is invalid (target coach does not exist in coaches[]).`);
    continue;
  }
  cleanRemap.set(prefixed, target);
  ambiguous.delete(prefixed);
  overrideCount += 1;
}
if (overrideCount > 0) console.log(`Applied ${overrideCount} human overrides from OVERRIDES table.`);

// Gather every prefixed reference across the DB
const allPrefixedRefs = new Set();
function scanCoachRefs(rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const cid of (row?.coachIds || [])) {
      if (isPrefixed(cid)) allPrefixedRefs.add(String(cid));
    }
  }
}
scanCoachRefs(db.timetable);
scanCoachRefs(db.timetableSlots);
scanCoachRefs(db.schedule);

const unresolved = new Set();
for (const p of allPrefixedRefs) if (!cleanRemap.has(p) && !ambiguous.has(p)) unresolved.add(p);

console.log('=== COACH ID RECONCILIATION ' + (apply ? '(APPLY)' : '(DRY-RUN)') + ' ===');
console.log(`source: ${source}`);
console.log(`coaches[].id (real, numeric):     ${coachIdSet.size}`);
console.log(`prefixed refs found:              ${allPrefixedRefs.size}`);
console.log(`clean 1:1 remaps discovered:      ${cleanRemap.size}`);
console.log(`ambiguous (multiple candidates):  ${ambiguous.size}`);
console.log(`UNRESOLVED (no signal):           ${unresolved.size}`);

if (cleanRemap.size > 0) {
  console.log('\n-- CLEAN REMAPS --');
  for (const [k, v] of cleanRemap.entries()) console.log(`  ${k}  ->  ${v}`);
}
if (ambiguous.size > 0) {
  console.log('\n-- AMBIGUOUS (needs human decision) --');
  for (const [k, v] of ambiguous.entries()) console.log(`  ${k}  ->  ${v}`);
}
if (unresolved.size > 0) {
  console.log('\n-- UNRESOLVED (no legacy co-occurrence) --');
  for (const p of unresolved) console.log(`  ${p}`);
}

// Compute what changes would look like
let rowsChanged = 0;
function projectRemap(rows, out) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const ids = Array.isArray(row?.coachIds) ? row.coachIds : [];
    let anyChange = false;
    const nextIds = [];
    const seen = new Set();
    for (const cid of ids) {
      const s = String(cid || '').trim();
      const remap = cleanRemap.get(s);
      const nextId = remap && !String(remap).startsWith('AMBIGUOUS') ? remap : s;
      if (nextId !== s) anyChange = true;
      if (!seen.has(nextId)) {
        seen.add(nextId);
        nextIds.push(nextId);
      } else {
        anyChange = true;
      }
    }
    if (!anyChange) return row;
    rowsChanged += 1;
    return { ...row, coachIds: nextIds };
  });
}

console.log('\n=== PROJECTED CHANGES ===');
const projected = {
  ...db,
  timetable: projectRemap(db.timetable),
  timetableSlots: projectRemap(db.timetableSlots),
  schedule: projectRemap(db.schedule),
};
console.log(`rows that would be rewritten (coachIds column): ${rowsChanged}`);

if (!apply) {
  console.log('\nDry-run only. Re-run with --apply --out=/path/to/output.json to persist.');
  console.log('This never mutates the source db.json unless --write-in-place is also passed.');
  process.exit(unresolved.size === 0 && ambiguous.size === 0 ? 0 : 1);
}

if (apply) {
  if (writeInPlace) {
    console.log(`Applying in place: ${source}`);
  } else {
    console.log(`Writing reconciled output to: ${outPath}`);
  }
  fs.writeFileSync(outPath, JSON.stringify(projected, null, 2) + '\n');
  process.exit(0);
}
