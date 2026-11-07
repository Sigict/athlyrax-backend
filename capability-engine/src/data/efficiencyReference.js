// Efficiency reference settings, in one place so they are easy to change.
//
// PUSH_OFF_ALLOWANCE_METRES_PER_WALL: when a swim has no recorded underwater
// distance (coach entry or sensor), this many metres per wall (start and each
// turn) are treated as push-off / glide, not stroked, before distance per
// stroke is calculated. A recorded underwater distance always replaces it.
// Swims using it are labelled "estimated push-off". Owner decision 26-10-2026.
// A club can override it with db.efficiencyCalibration.pushOffMetresPerWall.
export const PUSH_OFF_ALLOWANCE_METRES_PER_WALL = 5;

export function resolvePushOffAllowance(db) {
  const configured = Number(db?.efficiencyCalibration?.pushOffMetresPerWall);
  return Number.isFinite(configured) && configured >= 0 && configured <= 15 ? configured : PUSH_OFF_ALLOWANCE_METRES_PER_WALL;
}
