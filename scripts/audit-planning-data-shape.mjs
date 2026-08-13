#!/usr/bin/env node
/**
 * Read-only audit of the planning data shape in a tenant db.json.
 *
 * Reports:
 *   - Coach ID format mix (legacy numeric vs `coach_xxx`) and orphan counts
 *   - Timetable duplicate rows by natural key (weekday, start, end, squads, venue)
 *   - Schedule -> timetable / coach / squad reference orphans
 *   - Attendance -> schedule linkage integrity
 *   - Presence of legacy singular `timetable[]` shape vs canonical `timetables[]+timetableSlots[]`
 *   - Denormalised squadNames in schedule rows (stale-data risk)
 *
 * Does NOT modify anything. Prints a machine-readable line at the end so
 * CI can grep for pass/fail.
 *
 * Usage:  node scripts/audit-planning-data-shape.mjs [path-to-db.json]
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DB = path.resolve(process.argv[2] || 'storage/db.json');

function load(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`FATAL: db.json not found at ${filePath}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function classifyCoachId(id) {
  const s = String(id || '').trim();
  if (!s) return 'empty';
  if (/^coach_[a-z0-9]+$/i.test(s)) return 'prefixed';
  if (/^\d+$/.test(s)) return 'numeric';
  return 'other';
}

function natKeyTimetable(row) {
  return [
    row?.weekdayNum ?? row?.weekdayNumber ?? row?.dayNumber ?? '',
    String(row?.startTime || '').trim(),
    String(row?.endTime || '').trim(),
    [...(row?.squadIds || [])].map(String).sort().join(','),
    String(row?.venueId || '').trim(),
  ].join('|');
}

function natKeySchedule(row) {
  return [
    String(row?.scheduleDate || '').slice(0, 10),
    String(row?.startTime || '').trim(),
    String(row?.endTime || '').trim(),
    [...(row?.squadIds || [])].map(String).sort().join(','),
    String(row?.venueId || '').trim(),
  ].join('|');
}

function tallyDupes(rows, keyFn) {
  const counts = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let dupSets = 0;
  let excessRows = 0;
  for (const c of counts.values()) if (c > 1) { dupSets++; excessRows += c - 1; }
  return { totalRows: rows.length, uniqueKeys: counts.size, dupSets, excessRows };
}

function main() {
  const db = load(DEFAULT_DB);
  const report = { source: DEFAULT_DB, issues: [] };

  const coaches = Array.isArray(db.coaches) ? db.coaches : [];
  const squads = Array.isArray(db.squads) ? db.squads : [];
  const timetable = Array.isArray(db.timetable) ? db.timetable : [];        // legacy singular
  const timetables = Array.isArray(db.timetables) ? db.timetables : [];     // canonical headers
  const timetableSlots = Array.isArray(db.timetableSlots) ? db.timetableSlots : [];
  const schedule = Array.isArray(db.schedule) ? db.schedule : [];
  const attendance = Array.isArray(db.attendance) ? db.attendance : [];

  // ---------- Shape ----------
  console.log('\n=== SHAPE ===');
  console.log(`  timetable (legacy singular):   ${timetable.length} rows`);
  console.log(`  timetables (canonical hdr):    ${timetables.length} rows`);
  console.log(`  timetableSlots (canonical):    ${timetableSlots.length} rows`);
  console.log(`  schedule:                      ${schedule.length} rows`);
  console.log(`  attendance:                    ${attendance.length} rows`);
  console.log(`  coaches:                       ${coaches.length} rows`);
  console.log(`  squads:                        ${squads.length} rows`);
  if (timetable.length > 0 && timetableSlots.length === 0) {
    report.issues.push('LEGACY_SHAPE: timetable[] present but timetableSlots[] absent — canonical migration incomplete.');
  }

  // ---------- Coach ID format audit ----------
  console.log('\n=== COACH ID FORMAT ===');
  const coachIdClass = { numeric: 0, prefixed: 0, other: 0, empty: 0 };
  for (const c of coaches) coachIdClass[classifyCoachId(c.id)]++;
  console.log(`  coaches[].id distribution: ${JSON.stringify(coachIdClass)}`);

  const coachIdSet = new Set(coaches.map((c) => String(c.id || '').trim()));
  const gatherCoachRefs = (rows) => {
    const refs = new Set();
    for (const r of rows) for (const cid of (r.coachIds || [])) if (cid) refs.add(String(cid));
    return refs;
  };
  const schedCoachRefs = gatherCoachRefs(schedule);
  const timetableCoachRefs = gatherCoachRefs(timetable);
  const slotCoachRefs = gatherCoachRefs(timetableSlots);

  const schedOrphan = [...schedCoachRefs].filter((c) => !coachIdSet.has(c));
  const timetableOrphan = [...timetableCoachRefs].filter((c) => !coachIdSet.has(c));
  const slotOrphan = [...slotCoachRefs].filter((c) => !coachIdSet.has(c));

  console.log(`  schedule coach refs:   ${schedCoachRefs.size} unique, ${schedOrphan.length} orphan (not in coaches[])`);
  console.log(`  timetable coach refs:  ${timetableCoachRefs.size} unique, ${timetableOrphan.length} orphan`);
  console.log(`  slots coach refs:      ${slotCoachRefs.size} unique, ${slotOrphan.length} orphan`);
  if (schedOrphan.length > 0) {
    report.issues.push(`COACH_ID_ORPHAN_SCHEDULE: ${schedOrphan.length} of ${schedCoachRefs.size} schedule coach references do not exist in coaches[].`);
  }
  if (timetableOrphan.length > 0) {
    report.issues.push(`COACH_ID_ORPHAN_TIMETABLE: ${timetableOrphan.length} of ${timetableCoachRefs.size} timetable coach references do not exist in coaches[].`);
  }
  // Format mismatch detection
  const refFormats = new Set([...schedCoachRefs, ...timetableCoachRefs, ...slotCoachRefs].map(classifyCoachId));
  const coachFormats = new Set(coaches.map((c) => classifyCoachId(c.id)));
  const formatIntersect = [...refFormats].filter((f) => coachFormats.has(f));
  console.log(`  reference formats: ${JSON.stringify([...refFormats])}`);
  console.log(`  coach record formats: ${JSON.stringify([...coachFormats])}`);
  if (refFormats.size > 1 || formatIntersect.length === 0) {
    report.issues.push(`COACH_ID_FORMAT_DRIFT: References use formats ${JSON.stringify([...refFormats])} but coach records use ${JSON.stringify([...coachFormats])}.`);
  }

  // ---------- Duplicate detection ----------
  console.log('\n=== DUPLICATES BY NATURAL KEY ===');
  if (timetable.length > 0) {
    const t = tallyDupes(timetable, natKeyTimetable);
    console.log(`  timetable[] (legacy):    ${t.totalRows} rows -> ${t.uniqueKeys} unique keys, ${t.dupSets} dup-sets, ${t.excessRows} excess rows`);
    if (t.excessRows > 0) report.issues.push(`TIMETABLE_DUPLICATES: ${t.excessRows} excess rows across ${t.dupSets} duplicate key sets in legacy timetable[].`);
  }
  if (timetableSlots.length > 0) {
    const t = tallyDupes(timetableSlots, natKeyTimetable);
    console.log(`  timetableSlots:          ${t.totalRows} rows -> ${t.uniqueKeys} unique keys, ${t.dupSets} dup-sets, ${t.excessRows} excess rows`);
    if (t.excessRows > 0) report.issues.push(`TIMETABLE_SLOT_DUPLICATES: ${t.excessRows} excess rows in timetableSlots[].`);
  }
  const s = tallyDupes(schedule, natKeySchedule);
  console.log(`  schedule:                ${s.totalRows} rows -> ${s.uniqueKeys} unique keys, ${s.dupSets} dup-sets, ${s.excessRows} excess rows`);
  if (s.excessRows > 0) report.issues.push(`SCHEDULE_DUPLICATES: ${s.excessRows} excess rows in schedule[].`);

  // ---------- Schedule reference orphans ----------
  console.log('\n=== SCHEDULE REFERENCE INTEGRITY ===');
  const squadIdSet = new Set(squads.map((s) => String(s.id || '').trim()));
  const timetableIdSet = new Set([
    ...timetable.map((r) => String(r.id || '').trim()),
    ...timetables.map((r) => String(r.id || '').trim()),
    ...timetableSlots.map((r) => String(r.id || '').trim()),
  ].filter(Boolean));
  const scheduleTimetableRefs = new Set(schedule.map((r) => String(r.timetableId || '').trim()).filter(Boolean));
  const scheduleSquadRefs = new Set();
  for (const r of schedule) for (const s of (r.squadIds || [])) if (s) scheduleSquadRefs.add(String(s));
  const orphanSchedSquad = [...scheduleSquadRefs].filter((s) => !squadIdSet.has(s));
  const orphanSchedTimetable = [...scheduleTimetableRefs].filter((t) => !timetableIdSet.has(t));
  console.log(`  schedule -> squad orphans:      ${orphanSchedSquad.length} / ${scheduleSquadRefs.size}`);
  console.log(`  schedule -> timetable orphans:  ${orphanSchedTimetable.length} / ${scheduleTimetableRefs.size}`);
  if (orphanSchedSquad.length > 0) report.issues.push(`SCHEDULE_SQUAD_ORPHAN: ${orphanSchedSquad.length} schedule rows reference non-existent squads.`);
  if (orphanSchedTimetable.length > 0) report.issues.push(`SCHEDULE_TIMETABLE_ORPHAN: ${orphanSchedTimetable.length} schedule rows reference non-existent timetable ids.`);

  // ---------- Attendance linkage ----------
  console.log('\n=== ATTENDANCE LINKAGE ===');
  const scheduleIdSet = new Set(schedule.map((r) => String(r.id || '').trim()));
  const attMissingSchedId = attendance.filter((a) => !String(a.scheduleId || '').trim()).length;
  const attWithScheduleId = attendance.filter((a) => String(a.scheduleId || '').trim());
  const attOrphanSched = attWithScheduleId.filter((a) => !scheduleIdSet.has(String(a.scheduleId))).length;
  const attPointsAtTimetable = attendance.filter((a) => {
    const sid = String(a.scheduleId || '').trim();
    return sid && timetableIdSet.has(sid) && !scheduleIdSet.has(sid);
  }).length;
  console.log(`  attendance total:                       ${attendance.length}`);
  console.log(`  missing scheduleId:                     ${attMissingSchedId}`);
  console.log(`  scheduleId not in schedule[]:           ${attOrphanSched}`);
  console.log(`  scheduleId incorrectly = timetableId:   ${attPointsAtTimetable}`);
  if (attMissingSchedId > 0) report.issues.push(`ATTENDANCE_MISSING_SCHEDULE_ID: ${attMissingSchedId} attendance rows have no scheduleId.`);
  if (attOrphanSched > 0) report.issues.push(`ATTENDANCE_ORPHAN_SCHEDULE: ${attOrphanSched} attendance rows point at non-existent schedule ids.`);
  if (attPointsAtTimetable > 0) report.issues.push(`ATTENDANCE_POINTS_AT_TIMETABLE: ${attPointsAtTimetable} attendance rows use a timetable id as scheduleId.`);

  // ---------- Denormalised squadNames ----------
  console.log('\n=== DENORMALISED squadNames IN SCHEDULE ===');
  const withSquadNames = schedule.filter((r) => Array.isArray(r.squadNames) && r.squadNames.length > 0).length;
  const withStaleSquadNames = schedule.filter((r) => {
    const names = Array.isArray(r.squadNames) ? r.squadNames : [];
    const ids = Array.isArray(r.squadIds) ? r.squadIds : [];
    if (names.length === 0) return false;
    const actualNames = ids.map((sid) => {
      const row = squads.find((sr) => String(sr.id) === String(sid));
      return String(row?.name || '').trim();
    }).filter(Boolean);
    if (actualNames.length !== names.length) return true;
    return actualNames.some((n, i) => n !== String(names[i] || '').trim());
  }).length;
  console.log(`  schedule rows carrying squadNames[]:    ${withSquadNames} / ${schedule.length}`);
  console.log(`  schedule rows with STALE squadNames:    ${withStaleSquadNames}`);
  if (withSquadNames > 0) report.issues.push(`SCHEDULE_DENORMALISED_SQUADNAMES: ${withSquadNames} schedule rows carry squadNames[]; ${withStaleSquadNames} are stale.`);

  // ---------- Tombstones (Phase B4 fix acceptance) ----------
  console.log('\n=== TOMBSTONE SUPPORT ===');
  const tombstones = Array.isArray(db.__tombstones) ? db.__tombstones : null;
  if (tombstones == null) {
    console.log(`  __tombstones: MISSING`);
    report.issues.push(`TOMBSTONES_MISSING: db has no __tombstones[] — deletion protection not installed.`);
  } else {
    console.log(`  __tombstones: ${tombstones.length} entries`);
  }

  // ---------- Final summary ----------
  console.log('\n=== SUMMARY ===');
  if (report.issues.length === 0) {
    console.log('OK  ATHLYRAX_PLANNING_DATA_SHAPE_OK');
    process.exit(0);
  }
  for (const issue of report.issues) console.log('  ISSUE:', issue);
  console.log(`FAIL  ATHLYRAX_PLANNING_DATA_SHAPE_ISSUES=${report.issues.length}`);
  process.exit(1);
}

main();
