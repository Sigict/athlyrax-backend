#!/usr/bin/env node
/**
 * Coach ID orphan context report.
 *
 * For every `coach_xxx`-format id referenced by schedule/timetable/timetableSlots
 * that has no matching row in coaches[], print a "witness" table showing
 * everything we can learn about that coach from the surrounding data:
 *   - Every session context it appears in (weekday, time, venue, squad names,
 *     session-type name).
 *   - Every real coach (by name) it co-appears with on the same row.
 *   - The distinct schedule date ranges it covers.
 *   - The templates (timetable header ids) it belongs to.
 *
 * This gives a human enough information to look at each orphan and say
 * "that's Sam Jones — he does Monday 6am at Control Pool with the Otters".
 *
 * Usage:
 *   node scripts/coach-id-context-report.mjs [path-to-db.json] [--filter=coach_id]
 *   node scripts/coach-id-context-report.mjs storage/db.json --json > report.json
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
if (!fs.existsSync(source)) { console.error('not found', source); process.exit(2); }
const db = JSON.parse(fs.readFileSync(source, 'utf8'));

const coaches = Array.isArray(db.coaches) ? db.coaches : [];
const squads = Array.isArray(db.squads) ? db.squads : [];
const venues = Array.isArray(db.venues) ? db.venues : [];
const sessionTypes = Array.isArray(db.sessionTypes) ? db.sessionTypes : [];
const timetable = Array.isArray(db.timetable) ? db.timetable : [];
const timetableSlots = Array.isArray(db.timetableSlots) ? db.timetableSlots : [];
const timetables = Array.isArray(db.timetables) ? db.timetables : [];
const schedule = Array.isArray(db.schedule) ? db.schedule : [];

const coachById = new Map(coaches.filter((c) => c?.id != null).map((c) => [String(c.id), c]));
const squadById = new Map(squads.filter((s) => s?.id != null).map((s) => [String(s.id), s]));
const venueById = new Map(venues.filter((v) => v?.id != null).map((v) => [String(v.id), v]));
const stypeById = new Map(sessionTypes.filter((s) => s?.id != null).map((s) => [String(s.id), s]));
const timetableHdrById = new Map(timetables.filter((t) => t?.id != null).map((t) => [String(t.id), t]));

const filter = flags.get('filter');
const asJson = flags.has('json');
const isPrefixed = (id) => /^coach_[a-z0-9]+$/i.test(String(id || ''));
const coachName = (id) => {
  const c = coachById.get(String(id));
  if (!c) return null;
  return `${String(c.firstName || '').trim()} ${String(c.lastName || '').trim()}`.trim() || String(c.id);
};
const squadName = (id) => (squadById.get(String(id))?.name || String(id)).toString();
const venueName = (id) => (venueById.get(String(id))?.name || String(id || '')).toString();
const stypeName = (id) => (stypeById.get(String(id))?.name || String(id || '')).toString();
const templateName = (id) => {
  const t = timetableHdrById.get(String(id));
  return t?.name || t?.templateName || String(id || '');
};

// Gather orphan set
const allCoachRefs = new Set();
const collect = (rows, sourceLabel) => {
  for (const row of rows) {
    for (const cid of (row?.coachIds || [])) if (isPrefixed(cid)) allCoachRefs.add(String(cid));
  }
  return sourceLabel;
};
collect(schedule, 'schedule');
collect(timetable, 'timetable');
collect(timetableSlots, 'timetableSlots');

const orphans = [...allCoachRefs].filter((c) => !coachById.has(c));
if (orphans.length === 0) { console.log('No orphan coach_* references found.'); process.exit(0); }

const report = {};
for (const orphan of orphans) {
  if (filter && filter !== orphan) continue;
  const witnesses = { scheduleAppearances: 0, timetableAppearances: 0, slotAppearances: 0 };
  const contexts = new Set(); // stringified key -> "Mon 06:00-08:00 @ Control Pool / Otters (Swim)"
  const coCoachIds = new Set(); // other coachIds seen on same rows
  const templateIds = new Set();
  const dateRange = { first: null, last: null };

  const record = (row, kind) => {
    witnesses[kind + 'Appearances'] += 1;
    for (const other of (row?.coachIds || [])) {
      if (String(other) !== orphan && String(other).trim()) coCoachIds.add(String(other));
    }
    const days = row?.dayLabel || (row?.weekdayNum != null ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][Number(row.weekdayNum) - 1] : '');
    const key = [
      String(days || row?.scheduleDate || ''),
      `${String(row?.startTime || '')}-${String(row?.endTime || '')}`,
      venueName(row?.venueId),
      (Array.isArray(row?.squadIds) ? row.squadIds.map(squadName).join(',') : ''),
      stypeName(row?.sessionTypeId || row?.type),
    ].filter(Boolean).join(' | ');
    contexts.add(key);
    if (row?.timetableId) templateIds.add(String(row.timetableId));
    const date = String(row?.scheduleDate || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      if (!dateRange.first || date < dateRange.first) dateRange.first = date;
      if (!dateRange.last || date > dateRange.last) dateRange.last = date;
    }
  };
  for (const r of schedule) if ((r?.coachIds || []).includes(orphan)) record(r, 'schedule');
  for (const r of timetable) if ((r?.coachIds || []).includes(orphan)) record(r, 'timetable');
  for (const r of timetableSlots) if ((r?.coachIds || []).includes(orphan)) record(r, 'slot');

  const coCoachNames = [...coCoachIds].map((cid) => coachName(cid) || `<orphan ${cid}>`);
  report[orphan] = {
    appearances: witnesses,
    dateRangeOnSchedule: (dateRange.first || dateRange.last)
      ? `${dateRange.first || '?'} .. ${dateRange.last || '?'}`
      : null,
    templateIds: [...templateIds].map((tid) => `${tid}${timetableHdrById.get(tid) ? ` (${templateName(tid)})` : ''}`),
    coAppearingCoaches: coCoachNames,
    contextExamples: [...contexts].sort().slice(0, 5),
    contextExampleCount: contexts.size,
  };
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log('=== ORPHAN COACH ID CONTEXT REPORT ===');
console.log(`source: ${source}`);
console.log(`orphan coach_* references: ${Object.keys(report).length}\n`);
console.log('For each orphan below, look at the "context examples" and "co-appearing coaches"');
console.log('to identify which real coach in coaches[] this used to be. Then add the mapping to');
console.log('scripts/reconcile-coach-ids.mjs (constant OVERRIDES) as {"coach_xxx": "real_numeric_id"}.\n');

const rows = Object.entries(report).sort((a, b) => b[1].appearances.scheduleAppearances - a[1].appearances.scheduleAppearances);
for (const [orphan, info] of rows) {
  console.log('=====================================================');
  console.log(`ORPHAN: ${orphan}`);
  console.log(`  appearances: ${info.appearances.scheduleAppearances} schedule / ${info.appearances.timetableAppearances} timetable / ${info.appearances.slotAppearances} slots`);
  if (info.dateRangeOnSchedule) console.log(`  schedule dates covered: ${info.dateRangeOnSchedule}`);
  if (info.templateIds.length > 0) console.log(`  templates: ${info.templateIds.join(', ')}`);
  if (info.coAppearingCoaches.length > 0) console.log(`  co-coaches (already resolved): ${info.coAppearingCoaches.join(', ')}`);
  console.log(`  context patterns (${info.contextExampleCount} unique, showing first ${info.contextExamples.length}):`);
  for (const ctx of info.contextExamples) console.log(`    - ${ctx}`);
}

// Also print the list of real coaches for easy pairing.
console.log('\n=== REFERENCE: real coaches available for mapping ===');
for (const c of coaches.sort((a, b) => (String(a.firstName || '') + a.lastName).localeCompare(String(b.firstName || '') + b.lastName))) {
  const name = `${String(c.firstName || '').trim()} ${String(c.lastName || '').trim()}`.trim();
  const active = c.active === false ? ' (INACTIVE)' : '';
  const qual = c.qualification ? ` [${c.qualification}]` : '';
  console.log(`  id=${String(c.id).padEnd(6)} ${name}${qual}${active}`);
}

console.log('\nNext step: send me the mapping in the shape');
console.log('  { "coach_46jay9nh": "22", "coach_hxyoub2y": "17", ... }');
console.log('and I will add the OVERRIDES table to scripts/reconcile-coach-ids.mjs.');
