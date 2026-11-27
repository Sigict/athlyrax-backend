import { resolveCanonicalTrainingEnergy } from './canonicalTrainingEnergyAuthority.js';
// Read-only, deterministic interpretation of the prescribed TRAINING PLAN.
// The output is programmed exposure, never a swimmer's measured capability.
// All weights below represent explicit set intent or lower-weight coach
// session context. Generic repetitions are NOT proof of maintained efficiency.
const AXES = [
  'technical_control','efficiency','robustness_of_efficiency','aerobic_capacity',
  'anaerobic_capacity','power_speed_expression','adaptability','durability',
];
const plain = value => String(value ?? '').trim().toLowerCase();
const number = value => {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0,n) : 0;
};
const dateOf = row => String(row?.scheduleDate || row?.date || '').slice(0,10);
const daySpan = (a,b) => Math.round((Date.parse(b+'T12:00:00Z') - Date.parse(a+'T12:00:00Z')) / 86400000);

// Planned STIMULUS classifier, version 2 (structural). For each prescribed set
// it states which axes the set is designed to stimulate and the rule that
// decided it. It describes the prescription, never the swimmer's measured
// capability (that is the capability engine's job, from recorded results).
//
// Rules and their documented basis:
//  ENERGY    Energy-system code from the Training Planner (EN1/EN2/A1/A2
//            aerobic; EN3 aerobic + anaerobic; LT/B/C/RG anaerobic; LP
//            anaerobic + speed; SP speed). See docs/formula-register; EN2/EN3
//            are mapped differently in plannerAutomaticFocus.js (unresolved).
//  DUR-S1    Durability: a repeated set whose structure allows the documented
//            first-break / late-set evaluation (>= 6 repetitions: the
//            Durability band "break >= rep 6 = High", S11, and the engine's
//            Durability measurement requirement) at an intensity above easy
//            aerobic and with accumulating load (energy EN2/A2, EN3, LT, LP,
//            B/C/RG codes), not a warm-up or warm-down. Warm-ups, EN1 builds,
//            recovery swims and pure speed sets (SP: prescribed with recovery
//            to keep maximal speed) never qualify; repetition count alone
//            never does.
//  EFF-S1    Efficiency: the set prescribes a target stroke count per
//            repetition (stroke economy is part of the prescription).
//  EFF-S2    Efficiency training EXPOSURE (not measured efficiency): repeated
//            technical-control or explicitly pace-controlled work. A recorded
//            stroke count is not required to recognise its TRAINING INTENT.
//            A plain aerobic set/energy code or session-wide focus is not enough.
//  ADAPT-S2  Adaptability exposure: explicit mixed-skill/transition prescriptions
//            (kick-to-skills, underwater-to-surface breakout, transfers).
//            Choice stroke alone does NOT prove that a transition was trained.
//  ROE-S1    Robustness of Efficiency STIMULUS (intent, not a measured outcome):
//            >= 4 repetitions (the engine's minimum for a retention comparison)
//            at an intensity above easy aerobic, not a warm-up/down, not kick or
//            drill (no arm-stroke cycle to retain). A prescribed
//            target stroke count is NOT required (owner review 21-11-2026): the set
//            structure establishes the stimulus; whether stroke length was actually
//            retained is measured separately from recorded results
//            (robustnessOfEfficiency.js) and never inferred from the plan.
//  TC-S1     Technical Control: Drill modality or a technical energy code.
//  TEXT      The written prescription states the objective (e.g. "kick",
//            "threshold control", "IM"). Kept as the coach's prescribed
//            technical objective; session focus labels are not used.
// No fractional weights: a set counts fully toward every axis it targets.
const LOAD_CODES = /^(en2|en3|lt|lp|b1|b2|c1|c2|c3|rg|a2)$/;
const WARM_PHASES = /^(warm ?up|warm ?down|swim ?down|cool ?down|recovery)$/;
const repetitionCount = (row) => Math.max(0, number(row.reps)) * Math.max(1, number(row.rounds) || 1);
const targetStrokeCountOf = (row) => number(row.targetStrokeCount ?? row.targetStrokes);

export function plannedAxisStimulus(row = {}) {
  const name = plain([row.setName,row.name,row.title,row.instructions,row.structure,row.actualSet].filter(Boolean).join(' '));
  const energy = plain(resolveCanonicalTrainingEnergy(row).energySystem);
  const modality = plain(row.modality);
  const setPhase = plain(row.setPhase || row.phase);
  const weights = Object.fromEntries(AXES.map(axis=>[axis,0]));
  const reasons = Object.fromEntries(AXES.map(axis=>[axis,[]]));
  const target = (axis, rule) => { weights[axis] = 1; reasons[axis].push(rule); };
  const code = energy ? energy.toUpperCase() : 'no energy code';

  // ENERGY: the Training Planner's energy-system code.
  if (/^(en1|en2|a1|a2)$/.test(energy)) target('aerobic_capacity', `ENERGY ${code}`);
  if (/^(en3)$/.test(energy)) { target('aerobic_capacity', `ENERGY ${code}`); target('anaerobic_capacity', `ENERGY ${code}`); }
  if (/^(lt|b1|b2|c1|c2|c3|rg)$/.test(energy)) target('anaerobic_capacity', `ENERGY ${code}`);
  if (/^(lp)$/.test(energy)) { target('anaerobic_capacity', `ENERGY ${code}`); target('power_speed_expression', `ENERGY ${code}`); }
  if (/^(sp|sprint|speed|power)$/.test(energy)) target('power_speed_expression', `ENERGY ${code}`);
  if (/^(tech|technical|skill|drill)$/.test(energy)) target('technical_control', `TC-S1 energy ${code}`);
  if (modality === 'drill') target('technical_control', 'TC-S1 Drill modality');

  // Structural rules from the set's repetitions, intensity and phase.
  const reps = repetitionCount(row);
  const underLoad = LOAD_CODES.test(energy);
  const warm = WARM_PHASES.test(setPhase);
  if (reps >= 6 && underLoad && !warm) target('durability', `DUR-S1 ${reps} repetitions at ${code}`);
  const strokeTarget = targetStrokeCountOf(row);
  if (strokeTarget > 0) target('efficiency', `EFF-S1 target ${strokeTarget} strokes per repetition`);
  // Explicitly programmed control of technique or pace across a repeated set
  // is an Efficiency STIMULUS, not proof that a swimmer was economical.
  // Require an actual set objective; do not infer it from aerobic metres or
  // a generic session "Efficiency" focus.
  if (reps >= 4 && !warm
    && /\b(?:technical aerobic|technical control|threshold control|pace control|race pace(?: quality)?|controlled pace|hold pace|maintain pace|stroke economy)\b/.test(name)) {
    target('efficiency', `EFF-S2 ${reps} repetitions of explicit technique/pace control`);
  }
  // Kick and drill sets have no full arm-stroke cycle whose length could be retained (the same exclusion as the
  // measurement in robustnessOfEfficiency.js), so they are not a Robustness of Efficiency stimulus.
  const noArmStrokeCycle = modality === 'drill' || /\b(?:kick|drill)\b/.test(`${name} ${plain(row.stroke)}`);
  if (reps >= 4 && underLoad && !warm && !noArmStrokeCycle) target('robustness_of_efficiency', strokeTarget > 0
    ? `ROE-S1 ${reps} repetitions at ${code}, target ${strokeTarget} strokes prescribed`
    : `ROE-S1 ${reps} repetitions at ${code}`);

  // TEXT: the prescribed technical objective written in the set itself.
  if (/\b(technical|technique|skills?|drills?|kick|pull|scull|streamline|breakout|turns?|stroke control)\b/.test(name)) target('technical_control', 'TEXT technique objective');
  if (/\b(efficien\w*|economy|stroke count|stroke rate|dps|distance per stroke|stroke length|easy speed)\b/.test(name)) target('efficiency', 'TEXT stroke-economy objective');
  if (/\b(repeatability|consisten\w*|hold (?:form|technique|pace|stroke)|maintain\w*|fatigue resist\w*|pace control|threshold control|race pace quality|technical aerobic)\b/.test(name)) target('robustness_of_efficiency', 'TEXT maintain-under-load objective');
  if (/\b(aerobic|endurance|en1|en2|threshold|distance work)\b/.test(name)) target('aerobic_capacity', 'TEXT aerobic objective');
  if (/\b(anaerobic|lactate|threshold|race pace|broken pace)\b/.test(name)) target('anaerobic_capacity', 'TEXT anaerobic objective');
  if (/\b(sprint|speed|power|starts?|explosive)\b/.test(name)) target('power_speed_expression', 'TEXT speed objective');
  if (/\b(skill transfer|change of stroke|stroke change|variable pace|mixed stroke|transition|adaptability|individual medley)\b/.test(name) || /\bim\b/.test(name) || plain(row.stroke) === 'im') target('adaptability', 'TEXT changing-demand objective');
  // These compound set labels prescribe a motor-task transition, even in
  // freestyle without recorded stroke cycles. Plain "speed" or "choice"
  // does not establish adaptability on its own.
  if (/\b(?:kick\s*(?:\/|and|to|-)\s*skills?|power\s*\/\s*breakout|underwater\s*(?:to|into|\/)\s*(?:surface|swim)|kick\s*to\s*swim|turn\s*to\s*breakout)\b/.test(name)) {
    target('adaptability', 'ADAPT-S2 explicit transition between prescribed motor tasks');
  }
  if (/\b(durability|fatigue|sustain\w*|late[- ]set|first[- ]break)\b/.test(name)) target('durability', 'TEXT durability objective');
  return { weights, reasons: Object.fromEntries(AXES.map(axis=>[axis,[...new Set(reasons[axis])]])) };
}

// Which axes a prescribed set targets (1 = targeted, 0 = not).
export function plannedAxisWeights(row = {}) {
  return plannedAxisStimulus(row).weights;
}

export function calculatePlannedAxisExposure(rows=[],axisKeys=AXES) {
  const keys=Array.isArray(axisKeys)?axisKeys:AXES;
  const scores=Object.fromEntries(keys.map(axis=>[axis,Number.NaN]));
  const counts=Object.fromEntries(keys.map(axis=>[axis,0]));
  const volumes=Object.fromEntries(keys.map(axis=>[axis,0]));
  const ids=Object.fromEntries(keys.map(axis=>[axis,[]]));
  const eligible=(Array.isArray(rows)?rows:[]).filter(row=>number(row.plannedVolume ?? row.totalVolume)>0);
  const days=[...new Set(eligible.map(dateOf).filter(Boolean))].sort();
  // Short windows can contain a genuine prescribed durability STIMULUS
  // (e.g. 10 x 100). That is NOT proof of measured athlete durability.
  // Longitudinal measurement sufficiency belongs to the capability engine,
  // not this plan/attendance-based Training Evidence allocator.
  for(const row of eligible){
    const volume=number(row.plannedVolume ?? row.totalVolume);
    const weights=plannedAxisWeights(row);
    // The set's full metres count toward each axis it targets (no splitting).
    for(const axis of keys.filter(axis=>(weights[axis]||0)>0)){
      volumes[axis]+=volume;
      counts[axis]+=1;
      if(row.id!==undefined && row.id!==null && String(row.id).trim())ids[axis].push(String(row.id));
    }
  }
  // Share (%) of all programmed metres that target each axis. Axes are not
  // scaled against each other (§19); shares may overlap and need not sum to 100.
  const totalProgrammedVolume=eligible.reduce((sum,row)=>sum+number(row.plannedVolume ?? row.totalVolume),0);
  for(const axis of keys){
    if(counts[axis]>0 && totalProgrammedVolume>0) scores[axis]=100*volumes[axis]/totalProgrammedVolume;
  }
  return {scores,counts,recordIds:ids,allocatedVolumeByAxis:volumes,
    totalAllocatedVolume:Object.values(volumes).reduce((s,v)=>s+v,0),
    totalProgrammedVolume,
    evaluatedSets:eligible.length,longitudinalDates:days.length};
}
