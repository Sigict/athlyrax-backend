// AthlyraX capability engine v0.2 (EXPERIMENTAL, isolated branch) - versioned calibration table.
// JavaScript port of the research reference src/candidate/calibration.py (Candidate Calibration v0.2).
// LOCKED = carried from the owner-approved specification/code; PROVISIONAL = research choice awaiting real-swimmer data.
export const CALIBRATION_VERSION = 'Candidate Calibration v0.2 (research, 2026-11-26)';
export const APP_CALIBRATION_VERSION = 'AthlyraX experimental calibration v0.2-app.1 (isolated branch; not owner-approved)';

export const PARAMS = {
  // LOCKED
  recencyWeights: [[14, 1.0], [28, 0.75], [56, 0.5], [1e9, 0.25]],
  sourceWeights: { training: 0.30, testing: 0.50, competition: 0.20 },
  speedReferenceSex: 'male',
  pushOffAllowanceM: 5.0,
  speedOutlierRatio: 1.10,
  smallestWorthwhileChangePct: 0.4,
  referenceWeekMetres: { EN1: 52000, EN2: 12600, EN3: 3000, SP: 2000, LP: 0, LT: 0, PROLONGED: 52000 },
  // PROVISIONAL
  fadeIndexSlope: 10.0,
  dpsLossIndexSlope: 10.0,
  adaptabilityIndexSlope: 10.0,
  durabilityIndexSlopePerKm: 20.0,
  durabilityMinMinutes: 20.0,
  adaptabilityPairWindowDays: 14,
  adaptabilityMinSendoffChangePct: 5.0,
  dpsModelMinObs: 8,
  dpsModelMinSpeedRange: 0.05,
  onsetMinThresholdPct: 1.0,
  plateauMinObs: 3,
  robustnessMinCyclesPerRep: 15,
  plateauMinSpanDays: 42,
  technicalRatingScale: [1, 5],
  coachObservationWeight: 0.5,          // reference value; the app port does NOT score informal observations (Book 3 p. 293)
  loadReducedRatio: 0.8,
  loadIncreasedRatio: 1.2,
  adaptabilityMinChangeContinuousPct: 2.0,
  csMaxDateGapDays: 28,
  csDprimePlausibleMaxM: 60.0,
  referenceMaxAgeDays: 56,
  expressionMethod: 'recency_mean',
  sourceWeighting: 'locked',
  adaptabilityMethod: 'continuous',
  durabilityBasis: 'excess',
  technicalAggregation: 'equal_kind',
  // App port (intentional departure A-1): informal coach observations are context only.
  scoreInformalCoachObservations: false,
};

export function recencyWeight(ageDays) {
  for (const [limit, w] of PARAMS.recencyWeights) if (ageDays <= limit) return w;
  return 0.25;
}
export function linearIndex(lossPct, slope) {
  if (lossPct === null || lossPct === undefined) return null;
  return Math.max(0, Math.min(100, 100 - slope * Math.max(0, lossPct)));
}
export function linearIndexRaw(lossPct, slope) {
  if (lossPct === null || lossPct === undefined) return null;
  return 100 - slope * lossPct;
}
