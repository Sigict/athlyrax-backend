/**
 * Versioned swimming calibration profile.
 * Controlled by the AthlyraX Formula Traceability / Calibration specifications.
 *
 * Important:
 * - stability calibration is a metric calibration, not an Olympic ranking;
 * - missing metrics are excluded and remaining valid weights are rescaled;
 * - evidence completeness belongs to confidence/validation, not capability quality.
 */
export const SWIMMING_STABILITY_CALIBRATION_VERSION = 'Swimming Stability Calibration v1.0';

export const SWIMMING_CV_STABILITY_ANCHORS = Object.freeze([
  [0, 100],
  [1, 95],
  [2, 90],
  [3, 85],
  [4, 75],
  [5, 65],
  [6, 55],
  [8, 40],
  [10, 25],
  [12, 10],
]);

export const OLYMPIC_CAPABILITY_REFERENCE = Object.freeze({
  id: 'olympic-level-reference',
  label: 'Olympic-level swimmer reference',
  axisScore: 100,
  interpretation: 'Comparison target for the AthlyraX capability radar; it does not alter athlete scores.',
});

export function olympicReferenceProfile(axisKeys = []) {
  return Object.fromEntries((Array.isArray(axisKeys) ? axisKeys : []).map((key) => [String(key), 100]));
}
