import { attendanceBelongsToSwimmer } from './attendanceIdentity.js';
import {
  hasPositiveAttendanceEvidence,
  hasExplicitDeliveredTrainingVolume,
  resolveDeliveredTrainingVolume,
} from './trainingGraphEvidence.js';
import { getCanonicalTrainingSessions } from './canonicalTrainingSessionLinks.js';

const text = value => String(value ?? '').trim();
const rows = value => Array.isArray(value) ? value : [];
const bounded = value => Math.max(0, Math.min(1, value));

function revisionTime(row) {
  for (const value of [row?.updatedAt, row?.savedAt, row?.modifiedAt, row?.recordedAt, row?.createdAt, row?.timestamp]) {
    const t = new Date(String(value || '')).getTime();
    if (Number.isFinite(t)) return t;
  }
  return Number.NaN;
}

// Per-swimmer, per-session RECORDED delivered fraction (training exposure,
// never capability). Without recorded metres it is null; whether completion
// is then assumed is decided by resolveSwimmerSetCompletion.
export function attendanceDeliveredFraction(row) {
  if (!hasPositiveAttendanceEvidence(row)) return 0;
  if (!hasExplicitDeliveredTrainingVolume(row)) return null;
  const delivered = Math.max(0, Number(resolveDeliveredTrainingVolume(row)) || 0);
  const total = Number(row?.volumeTotal ?? row?.totalVolume ?? row?.plannedVolume ?? row?.volumePlanned);
  if (!(total > 0)) return null;
  return bounded(delivered / total);
}

// Completion of one programmed set for one swimmer (owner rule): a swimmer
// marked Present for a completed session is taken to have completed the
// programmed sets unless delivery was recorded differently. The basis keeps
// the distinct meanings separate:
//   recorded  - metres recorded for the swimmer (a recorded 0 stays 0)
//   assumed   - attended, no metres recorded: programmed metres assumed completed
//   absent    - recorded absent: 0
//   unknown   - no attendance record, or Partial without recorded metres
// Callers exclude sessions after the as-of date before calling this.
export function resolveSwimmerSetCompletion(setRow, plannedMetres, attendance) {
  const prescribed = Math.max(0, Number(plannedMetres) || 0);
  if (attendance?.attended === false) return { prescribed, completed: 0, basis: 'absent' };
  // A measured set-level delivery is a recorded value for that set.
  const setMeasured = hasExplicitDeliveredTrainingVolume(setRow);
  const setVolume = setMeasured
    ? Math.min(prescribed, Math.max(0, Number(resolveDeliveredTrainingVolume(setRow)) || 0))
    : prescribed;
  // A set-level recorded number is already the amount completed. Applying
  // the session's completion fraction to it AGAIN double-reduces delivery.
  // The session fraction is only the fallback when this set has no recorded
  // completed distance of its own.
  if (setMeasured) return { prescribed, completed: setVolume, basis: 'recorded' };
  if (Number.isFinite(attendance?.fraction)) return { prescribed, completed: prescribed * attendance.fraction, basis: 'recorded' };
  if (attendance?.attended === true && attendance?.partial !== true) return { prescribed, completed: prescribed, basis: 'assumed' };
  return { prescribed, completed: null, basis: 'unknown' };
}

// Completed metres of one set for totals: recorded or attendance-assumed;
// unknown completion contributes nothing.
export function deliveredSetMetresFromRecordedAttendance(setRow, plannedMetres, attendance) {
  return resolveSwimmerSetCompletion(setRow, plannedMetres, attendance).completed ?? 0;
}

// True when delivery was actually recorded (metres or a recorded absence).
export function deliveryRecordedForAttendance(setRow, attendance) {
  const { basis } = resolveSwimmerSetCompletion(setRow, 0, attendance);
  return basis === 'recorded' || basis === 'absent';
}

// True when completion is assumed from attendance (no recorded metres).
export function deliveryAssumedForAttendance(setRow, attendance) {
  return resolveSwimmerSetCompletion(setRow, 0, attendance).basis === 'assumed';
}

export function buildSwimmerScheduleDeliveryRatios(db = {}, swimmerId = '') {
  const bySchedule = new Map();
  const sessions = getCanonicalTrainingSessions(db);
  const sessionToSchedule = new Map(sessions.map(row => [
    text(row?.id), text(row?.scheduleId || row?.trainingScheduleId),
  ]));
  rows(db?.attendance).forEach((row, index) => {
    if (!attendanceBelongsToSwimmer(row, swimmerId)) return;
    const scheduleId = text(row?.scheduleId || row?.trainingScheduleId)
      || sessionToSchedule.get(text(row?.sessionId || row?.trainingSessionId));
    if (!scheduleId) return;
    const stamp = revisionTime(row);
    const previous = bySchedule.get(scheduleId);
    const previousStamp = previous?.stamp ?? Number.NaN;
    const wins = !previous
      || (Number.isFinite(stamp) && (!Number.isFinite(previousStamp) || stamp > previousStamp))
      || (stamp === previousStamp && index > previous.index)
      || (!Number.isFinite(stamp) && !Number.isFinite(previousStamp) && index > previous.index);
    if (wins) bySchedule.set(scheduleId, {row,index,stamp});
  });
  return new Map([...bySchedule.entries()].map(([scheduleId,{row}]) => [
    scheduleId,
    {
      fraction: attendanceDeliveredFraction(row),
      attended: hasPositiveAttendanceEvidence(row),
      // Partial attendance without recorded metres: completion unknown.
      partial: /partial/i.test(String(row?.status || row?.attendanceStatus || row?.completionStatus || '')),
      // A missing volume must not silently become an assumed 62% completion.
      volumeRecorded: hasExplicitDeliveredTrainingVolume(row)
        && Number(row?.volumeTotal ?? row?.totalVolume ?? row?.plannedVolume ?? row?.volumePlanned) > 0,
    },
  ]));
}
