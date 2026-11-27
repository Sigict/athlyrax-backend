// AthlyraX Training radar: a score is set DEMAND and verified delivery,
// with optional swimmer-specific recorded execution. It is never the
// percentage of the programme's metres assigned to an axis, and never a
// substitute for measured Capability or Competition.
//
// Calibration is deliberately versioned, explicit and bounded. The initial
// coach-review coefficients are engineering defaults, NOT validated physiological
// norms or Olympic capability comparisons. Owner-approved calibration can
// override them in db.trainingDemandCalibration, without changing this engine.
import { TRAINING_AXES, buildTrainingAxisInputLedger } from './trainingSetAxisInputLedger.js';
import { robustnessScoreFromLoss, ROBUSTNESS_MAX_SE_PCT } from './robustnessOfEfficiency.js';

export const TRAINING_DEMAND_SCORING_VERSION='training-demand-v8-per-axis-focused-metres';
// Training scale (owner decisions 26-10-2026): 100 = a world-record-level
// training load, the top of published elite weekly volumes (peak weeks of
// ~60-70 km: high-level French swimmers, Frontiers in Physiology 2023;
// averages ~29-58 km: Hellard et al. 2019, Pollock et al. 2019). An average
// elite week (~40 km) scores about 76; above 100 up to the 120 radar cap.
export const WORLD_CLASS_WEEKLY_METRES_REFERENCE=70000;
export const TRAINING_VOLUME_FACTOR_CAP=1;
// Training scores are capped at 100 = world-class training on that quality.
export const TRAINING_SCORE_CAP=100;

// The world-class reference week (~70 km) with the published intensity mix
// of elite swimmers (about 75 % easy, 18 % moderate, 7 % hard; Gonzalez-Rave
// et al. 2021). Each Training axis is scored against what this week
// delivers on that same axis, so the reference week scores 100 on every
// axis. The published mix covers intensity only: technique / drill work is
// not specified, so technique axes are relative to a week without drill sets.
const REFERENCE_WEEK=Object.freeze([
  [26,'20x100 Aerobic','EN1',20,100,'1:30'],
  [10,'12x100 Threshold','EN2',12,100,'1:25'],
  [1,'6x100 Threshold','EN2',6,100,'1:25'],
  [5,'6x100 Race Pace','EN3',6,100,'2:00'],
  [8,'10x25 Sprint','SP',10,25,'1:00'],
]);
// The world-class reference week is computed with the SAME training model (energy attribution, attribution mode and
// demand coefficients) as the swimmer's programme, so the reference week always scores 100 under any calibration.
const referenceCache=new Map();
const modelKey=(model)=>model?JSON.stringify([model.attributionMode||'original',model.energyAttribution||null,model.coefficients||null]):'original';
export function worldClassReferenceAxisDemand(model=null){
  const key=modelKey(model);
  const hit=referenceCache.get(key);
  if(hit)return hit.demand;
  const sets=[];let n=0;
  for(const [count,setName,energy,reps,distance,sendOff] of REFERENCE_WEEK){
    for(let i=0;i<count;i+=1){
      const date=`2026-01-0${(n%7)+1}`;
      sets.push({id:`world-class-ref-${n++}`,date,scheduleDate:date,setName,energy,reps,distance,sendOff,stroke:'Free',plannedVolume:reps*distance});
    }
  }
  const raw=scoreTrainingDemand({plannedLedger:buildTrainingAxisInputLedger(sets,{useRecordedResults:false}),
    startDate:'2026-01-01',endDate:'2026-01-07',referenceAxisDemand:null,calibration:model?{model:{...model}}:{}});
  const demand=Object.freeze(Object.fromEntries(TRAINING_AXES.map(axis=>[axis,raw.details[axis].rawDemand])));
  const focus=Math.max(0,...TRAINING_AXES.map(axis=>raw.details[axis].focusedMetres||0));
  if(referenceCache.size>32)referenceCache.clear();
  referenceCache.set(key,{demand,focus});
  return demand;
}
// Focused metres of the world-class week on its largest axis (aerobic): the
// size reference. Intensity (send-off density, energy) is part of it, so a
// tighter send-off makes the same metres count for more.
export function worldClassReferenceWeeklyFocus(model=null){
  worldClassReferenceAxisDemand(model);
  return referenceCache.get(modelKey(model)).focus;
}
const DEFAULTS=Object.freeze({
  background:0.10,
  focusLift:0.57,
  repetitionLift:0.06,
  densityLift:0.05,
  intensityLift:0.10,
  variationLift:0.07,
  resultInfluence:0.20,
});
const clamp=(v,min=0,max=1)=>Math.max(min,Math.min(max,v));
const number=(v,f=0)=>v!==null&&v!==undefined&&String(v).trim()!==''&&Number.isFinite(Number(v))?Number(v):f;
const clean=(v)=>String(v??'').trim().toLowerCase();
const span=(s)=> {
 const parts=clean(s).split(':');
 if(parts.length>2||!parts.every(x=>x!==''&&Number.isFinite(Number(x))))return null;
 const n=parts.reduce((a,b)=>a*60+Number(b),0);
 return Number.isFinite(n)&&n>=0?n:null;
};
const ENERGY=Object.freeze({
  // A plain aerobic code is not technique, efficiency or robustness work on its
  // own (planned-set rules TC-S1 / EFF-S1 / ROE-S1 need drills or stroke targets).
  en1:{aerobic_capacity:1},a1:{aerobic_capacity:1},
  en2:{aerobic_capacity:.9,anaerobic_capacity:.2},
  a2:{aerobic_capacity:.8,anaerobic_capacity:.3},
  en3:{aerobic_capacity:.65,anaerobic_capacity:.75,durability:.45},
  lt:{anaerobic_capacity:1,aerobic_capacity:.35,durability:.65},
  lp:{anaerobic_capacity:.95,power_speed_expression:.65,durability:.4},
  sp:{power_speed_expression:1,technical_control:.3},
  speed:{power_speed_expression:1},sprint:{power_speed_expression:1},
  b1:{anaerobic_capacity:.9,durability:.5},b2:{anaerobic_capacity:1,durability:.5},
  c1:{anaerobic_capacity:.9},c2:{anaerobic_capacity:.9},c3:{anaerobic_capacity:1},
  rg:{anaerobic_capacity:.9,power_speed_expression:.3},
  tech:{technical_control:1,efficiency:.35},
  technical:{technical_control:1,efficiency:.35},
  drill:{technical_control:1},
});
// Original working attribution and coefficients (comparison and rollback baseline for the calibration console).
export const ORIGINAL_ENERGY_ATTRIBUTION=ENERGY;
export const ORIGINAL_TRAINING_COEFFICIENTS=DEFAULTS;
// Training model carried by calibration.model (Final Model C): energy attribution table, attribution mode
// ('original' = the v8 rule; 'scaled' = the set's repetition/intensity stimulus and an energy-derived objective are
// distributed by the attribution coefficient instead of acting as an on/off switch) and demand coefficients.
const energyTable=(calibration)=>calibration?.model?.energyAttribution||ENERGY;
const scaledAttribution=(calibration)=>calibration?.model?.attributionMode==='scaled';
// Intensity-weighted training load (Mujika et al., 1995, competitive swimmers):
// metres are multiplied by 1, 2, 3, 5 and 8 for the five intensity zones
// (aerobic below threshold, threshold, above threshold / VO2, lactate,
// sprint). Planner codes map to those zones; technique/drill and unknown
// codes count as zone 1.
const INTENSITY_ZONE_WEIGHT=Object.freeze({en1:1,a1:1,en2:2,a2:2,en3:3,lt:5,lp:5,b1:5,b2:5,c1:5,c2:5,c3:5,rg:5,sp:8,sprint:8,speed:8,power:8});
export const intensityZoneWeight=(energy)=>INTENSITY_ZONE_WEIGHT[clean(energy)]||1;
function coefficient(calibration={},axis){
 const override=calibration?.axes?.[axis] || {};
 const base=calibration?.defaults || {};
 const model=calibration?.model?.coefficients || {};
 return Object.fromEntries(Object.keys(DEFAULTS).map(k=>[
   k,clamp(number(override[k]??base[k]??model[k]??DEFAULTS[k],DEFAULTS[k]))
 ]));
}
const entryKey=e=>`${e.date}|${e.setId}`;
const qOf=(axis,m={},energy='')=>{
 const valid=x=>typeof x==='number'&&Number.isFinite(x);
 const stable=cv=>valid(cv)?clamp(1-cv/12):null;
 const fatigue=f=>valid(f)?clamp(0.5-f*2.5):null;
 const pairedChange=m.earlyToLateSpeedPerStrokeFraction;
 switch(axis){
   case 'technical_control': return stable(m.strokeCountCvPercent)??stable(m.cycleCountCvPercent)??stable(m.timeCvPercent);
   case 'efficiency': return valid(pairedChange)?clamp(.5+pairedChange*3):null;
   // Same measurement and curve as Capability Robustness (robustnessOfEfficiency.js): distance-per-cycle loss from
   // the early to the late repetitions, deadbanded by stroke-count resolution; pace is Durability, not read here.
   case 'robustness_of_efficiency':
     // One set's quality only when the set is valid Robustness evidence (comparable pace, measured counts, known demand)
   // and its own stroke-count precision is within the provisional limit (robustnessOfEfficiency.js).
     return m.dpcRetention?.eligible&&!m.dpcRetention.unclassified&&m.dpcRetention.quantSdPct<=ROBUSTNESS_MAX_SE_PCT
       ?clamp(robustnessScoreFromLoss(Math.max(0,m.dpcRetention.lossPct))/100):null;
   case 'aerobic_capacity': return /^(en1|en2|en3|a1|a2)$/.test(energy)?stable(m.timeCvPercent):null;
   case 'anaerobic_capacity': return /^(en3|lt|lp|b1|b2|c1|c2|c3|rg)$/.test(energy)?stable(m.timeCvPercent):null;
   case 'power_speed_expression': return /^(sp|speed|sprint|lp|rg)$/.test(energy)?stable(m.timeCvPercent):null;
   case 'adaptability': return null; // Movement transfer requires a paired comparable transfer protocol.
   case 'durability': return number(m.timedRepetitions)>=3?fatigue(m.lateVsFirstTimeFraction):null;
   default:return null;
 }
};
function demand(e,axis,c,calibration={}){
 // Send-off measures start-to-start interval, not swimming duration.
 // Prefer actual repetition time, then the explicit prescribed target.
 // Missing target/results must not generate estimated swimming times.
 const sendOff=span(e.sendOff);
 const observed=number(e.measured?.meanSeconds,NaN);
 const target=span(e.targetTime);
 const swimSeconds=Number.isFinite(observed)&&observed>0?observed:target;
 const inferredRest=sendOff!==null&&swimSeconds!==null&&swimSeconds>0
   ? sendOff-swimSeconds:null;
 const explicitRest=span(e.rest);
 const rest=inferredRest!==null&&inferredRest>=0?inferredRest
   :(inferredRest===null?explicitRest:null);
 // Unknown or impossible timing (send-off faster than the repetition) keeps
 // the neutral recovery used before send-offs were read; it is not treated
 // as zero rest and no swimming time is estimated.
 const recovery=rest===null?.5:clamp(1-rest/60);
 const reps=Math.max(0,number(e.repetitions))*Math.max(1,number(e.rounds,1));
 const repetition=clamp((reps-1)/11);
 const name=clean(e.setName),stroke=clean(e.stroke);
 // Variation is an explicit change-of-task prescription, never a generic
 // "Swim" substring, a timed set, or a SPECIFIC phase label on its own.
 const variation=axis==='adaptability'&&(
   e.axes?.[axis]?.explicitTarget
   ||/\b(?:im|individual medley|mixed strokes?|stroke change|transition|transfer|variable pace|kick to swim)\b/.test(name)
   ||/^(im|medley)$/.test(stroke)
 )?1:0;
 const code=clean(e.energy);
 const explicit=e.axes?.[axis]?.explicitTarget===true?1:0;
 const energy=energyTable(calibration)[code]?.[axis]||0;
 // Density is meaningful for sustained EN and threshold stimulus; it is
 // not a generic reward on technical, speed or adaptability axes. A long
 // send-off does not establish sprint speed or recovery quality on its own.
 const densityRelevant=/^(en1|en2|en3|a1|a2|lt|b1|b2|c1|c2|c3)$/.test(code)
   && (axis==='aerobic_capacity'||axis==='anaerobic_capacity'||axis==='durability');
 const density=densityRelevant&&repetition>0?recovery*repetition*energy:0;
 // The prescribed system remains the stimulus reference. Missing timing
 // contributes no inferred density; it does not change the declared system.
 // A set only adds demand to the axes it actually trains (energy system,
 // explicit objective or prescribed variation). Repetitions alone never make
 // a set count toward Adaptability, Technical Control or any other axis.
 const targeted=energy>0||explicit>0||variation>0;
 if(!targeted)return c.background;
 if(scaledAttribution(calibration)){
   // Final Model C: the set's repetition and intensity stimulus is distributed to an axis in proportion to the
   // energy-system attribution (an explicit objective or a prescribed variation keeps the full lift), so the attribution
   // table separates Anaerobic from Power & Speed instead of acting as an on/off switch. An objective that comes only from
   // the energy code carries the attribution weight; an objective stated in the set itself keeps the full focus lift.
   const share=energy>0?energy:(explicit>0||variation>0?1:0);
   const energyOnly=explicit>0&&energy>0&&(e.axes?.[axis]?.reasons||[]).every?.(r=>/^ENERGY/.test(String(r)))!==false;
   const focus=explicit*(energyOnly?energy:1);
   return clamp(c.background+c.focusLift*focus+share*(c.repetitionLift*repetition+c.intensityLift)
       +c.densityLift*density+c.variationLift*variation);
 }
 return clamp(c.background+c.focusLift*explicit+c.repetitionLift*repetition
     +c.densityLift*density+c.intensityLift*energy+c.variationLift*variation);
}
// Whether a ledger set trains an axis (energy system, explicit objective or
// prescribed variation). Used for scores, evidence counts and record IDs.
export const trainingSetTrainsAxis=(e,axis,calibration={})=>targetsAxis(e,axis,calibration);
function targetsAxis(e,axis,calibration={}){
 const code=clean(e.energy),name=clean(e.setName),stroke=clean(e.stroke);
 if((energyTable(calibration)[code]?.[axis]||0)>0||e.axes?.[axis]?.explicitTarget===true)return true;
 return axis==='adaptability'&&(/\b(?:im|individual medley|mixed strokes?|stroke change|transition|transfer|variable pace|kick to swim)\b/.test(name)||/^(im|medley)$/.test(stroke));
}

export function scoreTrainingDemand({
 plannedLedger,completedLedger=null,calibration={},startDate='',endDate='',
 referenceAxisDemand=undefined,
}={}){
 // null: raw demand only (used to build the world-class reference itself).
 const model=calibration?.model||null;
 const reference=referenceAxisDemand===null?null:(referenceAxisDemand||worldClassReferenceAxisDemand(model));
 const planned=Array.isArray(plannedLedger?.rows)?plannedLedger.rows:[];
 const delivered=completedLedger===null?planned:(Array.isArray(completedLedger?.rows)?completedLedger.rows:[]);
 const recorded=completedLedger!==null;
 const deliveredMap=new Map();
 for(const row of delivered){
   const key=entryKey(row);
   const arr=deliveredMap.get(key)||[];
   arr.push(row);
   deliveredMap.set(key,arr);
 }
 const scores=Object.fromEntries(TRAINING_AXES.map(a=>[a,Number.NaN]));
 const counts=Object.fromEntries(TRAINING_AXES.map(a=>[a,0]));
 const details=Object.fromEntries(TRAINING_AXES.map(a=>[a,{
   contributingSetCount:0,measuredSetCount:0,plannedDose:0,deliveredDose:0,
   recordedModifierSum:0,scoreBeforeRounding:null,
 }]));
 if(!planned.length)  return {scores,counts,details,version:TRAINING_DEMAND_SCORING_VERSION,
   status:'no-training',assumptions:'coach-review-calibration-not-validated'};
 const totalWeight=planned.reduce((s,e)=>s+Math.sqrt(Math.max(0,number(e.prescribedMetres))),0);
 if(!(totalWeight>0)) return {scores,counts,details,version:TRAINING_DEMAND_SCORING_VERSION,
   status:'no-training',assumptions:'coach-review-calibration-not-validated'};
 // Training is exposure to an actual training LOAD, not just the relative
 // mixture of set types. Scaling prescribed total metres against the selected
 // calendar window prevents two identical extra sets from leaving the same
 // score, and keeps a single day distinct from a 77-day cycle.
 // These reference values are owner-calibratable, not a physiological norm.
 const iso=s=>/^\d{4}-\d{2}-\d{2}$/.test(String(s||''))?String(s):'';
 const dates=planned.map(row=>iso(row.date)).filter(Boolean).sort();
 const first=iso(startDate)||dates[0]||'';
 const last=iso(endDate)||dates[dates.length-1]||'';
 const spanDays=first&&last&&last>=first
   ? Math.max(1,Math.round((Date.parse(last+'T12:00:00Z')-Date.parse(first+'T12:00:00Z'))/86400000)+1)
   : 1;
 const plannedTotalMetres=planned.reduce((sum,row)=>sum+Math.max(0,number(row.prescribedMetres)),0);
 let completedTotal=0;
 for(const axis of TRAINING_AXES){
   const c=coefficient(calibration,axis);
   let numerator=0;
   for(const row of planned){
     const perSet=deliveredMap.get(entryKey(row));
     const actual=perSet?.shift()||null;
     const prescribed=Math.max(0,number(row.prescribedMetres));
     const completed=actual?Math.max(0,number(actual.completedMetres)):0;
     if(!(prescribed>0))continue;
     const completion=clamp(completed/prescribed);
     const weight=Math.sqrt(prescribed);
     const programmeDemand=demand({...row,measured:actual?.measured??null},axis,c,calibration);
     details[axis].plannedDose+=programmeDemand*weight;
     if(completion>0){
       completedTotal+=axis===TRAINING_AXES[0]?completed:0;
       details[axis].completedSetCount=(details[axis].completedSetCount||0)+1;
       // Evidence = completed sets that actually train this axis.
       if(targetsAxis(row,axis,calibration)){details[axis].contributingSetCount++;counts[axis]++;}
       // Recorded results only adjust axes the set actually trains.
       const quality=targetsAxis(row,axis,calibration)?qOf(axis,actual?.measured,clean(actual?.energy)):null;
       const modified=quality===null?programmeDemand:
         clamp(programmeDemand*(1+c.resultInfluence*(quality-.5)*2));
       if(quality!==null){
         details[axis].measuredSetCount++;
         details[axis].recordedModifierSum+=(modified-programmeDemand)*weight*completion;
       }
       const dose=modified*weight*completion;
       numerator+=dose;
       details[axis].deliveredDose+=dose;
       // Focused metres: the part of the set's demand above the common
       // background, weighted by the metres actually swum.
       details[axis].focusedMetres=(details[axis].focusedMetres||0)+Math.max(0,modified-c.background)*completed*intensityZoneWeight(row.energy);
     }
   }
   if((details[axis].completedSetCount||0)>0){
     const configuredReference=number(calibration?.axes?.[axis]?.loadReferenceMetresPerWeek
       ??calibration?.loadReferenceMetresPerWeek??model?.weeklyReferenceMetres,WORLD_CLASS_WEEKLY_METRES_REFERENCE);
     const weeklyReference=Math.max(1,configuredReference);
     const referenceWindowMetres=weeklyReference*spanDays/7;
     const loadRatio=plannedTotalMetres/referenceWindowMetres;
     // One scale for every level (owner decisions 26-10-2026): this
     // programme's demand on the axis relative to the world-class reference
     // week's demand on the same axis, times a volume factor against the
     // world-class week (square root: diminishing returns; capped at 1).
     // Capped at 100 = world-class training on that quality.
     const loadMultiplier=Math.min(TRAINING_VOLUME_FACTOR_CAP,Math.sqrt(Math.max(0,loadRatio)));
     const rawDemand=numerator/totalWeight;
     details[axis].rawDemand=rawDemand;
     // With the reference: emphasis relative to the world-class week, on the
     // focused part of the demand only (every set carries the same background
     // demand on every axis, which would make any set look world-class on the
     // minor axes); the graph is scaled after the loop. Without it: raw
     // demand x volume.
     const background=c.background;
     const value=reference
       ? Math.max(0,rawDemand-background)/Math.max(1e-9,reference[axis]-background)
       : Math.max(0,rawDemand*loadMultiplier)*100;
     details[axis].background=background;
     details[axis].referenceAxisDemand=reference?reference[axis]:null;
     scores[axis]=reference?value:Math.round(value*10)/10;
     details[axis].scoreBeforeRounding=value;
     details[axis].loadRatio=loadRatio;
     details[axis].loadMultiplier=loadMultiplier;
     details[axis].calibrationReferenceWeeklyMetres=weeklyReference;
     details[axis].calendarDays=spanDays;
     details[axis].plannedTotalMetres=plannedTotalMetres;
   }
   // Because each input set contributes to every axis, evidence counts are
   // the count of completed contributing sets, never only "targeted" sets.
   // Avoid consuming the recorded rows with shift() on subsequent axes.
   for(const row of delivered){
     const list=deliveredMap.get(entryKey(row));
     if(list)list.length=0;
   }
   for(const row of delivered){
     const key=entryKey(row),list=deliveredMap.get(key)||[];
     list.push(row);
     deliveredMap.set(key,list);
   }
 }
// Size = volume, shape = emphasis (owner decision 26-10-2026): each axis'
 // emphasis is its demand relative to the world-class week on that axis; the
 // most emphasised axis takes the volume level (square root of the completed
 // weekly volume against the 70 km world-class week, at most 1) and the
 // others are in proportion. A four-session week therefore stays well inside the graph
 // whatever it emphasises; the world-class week scores 100 on every axis.
 // training-demand-v8: every axis on one common scale. An axis' score is the
 // square root (diminishing returns) of its focused metres - the demand above
 // the common background on the sets that train it, times the metres swum -
 // against the focused metres of the ~70 km world-class week on its largest
 // axis (aerobic), for the same number of days; capped at 100. So the
 // world-class week scores 100 on Aerobic and its real mix elsewhere; a
 // mostly aerobic session shows Aerobic largest; the same sprint set gives
 // the same Power score whatever else was swum; an axis no set trains is 0.
 if(reference){
   const scored=TRAINING_AXES.filter(axis=>Number.isFinite(scores[axis]));
   for(const axis of scored){
     const weekScale=details[axis].calibrationReferenceWeeklyMetres/WORLD_CLASS_WEEKLY_METRES_REFERENCE;
     // Never less than a whole world-class week: a single session or a short
     // window shows its share of a world-class week, so one big session does
     // not fill the graph (owner decision 04-11-2026).
     const referenceWindow=worldClassReferenceWeeklyFocus(model)*weekScale*Math.max(7,details[axis].calendarDays)/7;
     const focused=details[axis].focusedMetres||0;
     const ratio=focused/Math.max(1e-9,referenceWindow);
     details[axis].completedTotalMetres=completedTotal;
     details[axis].focusedRatioVsWorldClass=ratio;
     details[axis].emphasisVsWorldClass=scores[axis];
     const value=counts[axis]>0?Math.min(TRAINING_SCORE_CAP,100*Math.sqrt(Math.max(0,ratio))):0;
     details[axis].scoreBeforeRounding=value;
     scores[axis]=Math.round(value*10)/10;
   }
 }
 return {scores,counts,details,version:TRAINING_DEMAND_SCORING_VERSION,
   status:completedTotal>0?(recorded?'delivered-training-with-available-results':'planned-training'):'no-training',
   assumptions:'coach-review-calibration-not-validated',
   calibrationSource:calibration?.version||'default-coach-review'};
}
