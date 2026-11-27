// Canonical evidence ledger for the Training scoring engine.
// Every valid set is an input to EVERY axis; this does not mean every set
// strongly targets every axis or that presence alone earns an arbitrary score.
// Planned demands and swimmer performance remain separate, auditable facts.
import { plannedAxisStimulus } from './plannedTrainingAxisExposure.js';
import { assessRetentionEvidence, sendOffSeconds, strokeCountOrigin } from './robustnessOfEfficiency.js';
import { recordedRepValues } from './recordedSetAverages.js';
import { resolveCanonicalTrainingEnergy } from './canonicalTrainingEnergyAuthority.js';

export const TRAINING_AXES=Object.freeze([
  'technical_control','efficiency','robustness_of_efficiency','aerobic_capacity',
  'anaerobic_capacity','power_speed_expression','adaptability','durability',
]);
const arr=x=>Array.isArray(x)?x:[];
const value=x=>String(x??'').trim();
const num=x=>value(x)===''?null:Number.isFinite(Number(x))?Number(x):null;
const nonneg=x=>Number.isFinite(x)&&x>=0;
function seconds(raw){
  const s=value(raw);
  if(!s)return null;
  const parts=s.split(':');
  if(parts.length>3 || !parts.every(part=>part.trim()!==''&&Number.isFinite(Number(part))))return null;
  const n=parts.reduce((acc,part)=>acc*60+Number(part),0);
  return n>0&&Number.isFinite(n)?n:null;
}
function coefficientOfVariation(values){
  if(values.length<2)return null;
  const mean=values.reduce((s,v)=>s+v,0)/values.length;
  if(!(mean>0))return null;
  const variance=values.reduce((s,v)=>s+(v-mean)**2,0)/values.length;
  return 100*Math.sqrt(variance)/mean;
}

export function buildTrainingAxisInputLedger(rows=[],{swimmerId='',useRecordedResults=true}={}){
  const entries=[];
  for(const row of arr(rows)){
    const metres=num(row?.__ispDeliveredSetMetres??row?.plannedVolume??row?.totalVolume);
    if(!nonneg(metres)||metres===0)continue;
    if(row?.isTestSet===true||/^test$/i.test(value(row?.setType)))continue;
    const {weights,reasons}=plannedAxisStimulus(row);
    const result=useRecordedResults
      ? row?.__ispSwimmerResult??row?.resultsBySwimmer?.[swimmerId]??null
      : null;
    const reps=arr(result?.reps);
    // Read the same canonical recorded repetition fields as the Results
    // summary, including complete split-only repetitions. Never manufacture
    // a full rep from incomplete splits and never mix arm strokes with cycles.
    const observations=reps.map(rep=>{
      const recorded=recordedRepValues(rep,{expectedDistance:Math.max(0,num(row?.distance)??0)});
      const time=recorded.seconds;
      const strokeUnit=value(rep?.strokeCountUnit).toLowerCase();
      const unitIsCycles=strokeUnit.startsWith('cycle');
      const splits=arr(rep?.splits);
      const splitsAreCycles=splits.length>0&&splits.every(item=>
        value(item?.strokeCountUnit).toLowerCase().startsWith('cycle'));
      const measuredArmStrokes=unitIsCycles||splitsAreCycles ? null : recorded.cycles;
      // A recorded number of arm strokes must NOT be inferred from recorded
      // stroke cycles, including legacy cycle-labelled strokeCount fields.
      const explicitCycles=num(rep?.recordedOverallStrokeCycles??rep?.overallStrokeCycles
        ??rep?.strokeCycles??rep?.cycleCount??rep?.cycles);
      const splitDistance=num(splits[splits.length-1]?.distance);
      const completeSplits=splits.length>0&&
        (num(row?.distance)===null || (splitDistance!==null && splitDistance>=num(row.distance)));
      const splitCycles=completeSplits&&splits.every(item=>
        nonneg(num(item?.strokeCycles??item?.cycleCount??item?.cycles)))
        ? splits.reduce((sum,item)=>sum+num(item?.strokeCycles??item?.cycleCount??item?.cycles),0)
        : null;
      const cycles=nonneg(explicitCycles)?explicitCycles:
        (unitIsCycles||splitsAreCycles)&&nonneg(recorded.cycles)?recorded.cycles:splitCycles;
      return {
        time:time!==null&&time>0?time:null,
        stroke:nonneg(measuredArmStrokes)?measuredArmStrokes:null,
        cycles:nonneg(cycles)?cycles:null,
      };
    });
    const times=observations.map(rep=>rep.time).filter(t=>t!==null);
    const strokes=observations.map(rep=>rep.stroke).filter(n=>n!==null);
    const cycles=observations.map(rep=>rep.cycles).filter(n=>n!==null);
    // Retain comparable ordered repetitions so recorded RESULTS can update
    // training demand without importing unrelated race/test results.
    const firstLast=(values)=>{
      if(values.length<2 || !(values[0]>0))return null;
      return (values[values.length-1]-values[0])/values[0];
    };
    const paired=observations.filter(rep=>rep.time!==null);
    const efficiencyPairs=paired.filter(rep=>rep.stroke!==null);
    const efficiencyChanges=efficiencyPairs.length>=2
      ? firstLast(efficiencyPairs.map(rep=>1/(rep.time*rep.stroke))) : null;
    // Robustness of Efficiency: the same assessment as the Capability engine (robustnessOfEfficiency.js): stroke-length
    // retention at comparable pace, canonical energy code, recovery as work fraction. Pace is not part of it.
    const retention=reps.length?assessRetentionEvidence({source:'training',energy:row?.energy||row?.energySystem||'',stroke:value(row?.stroke),
      units:reps.map((rep,i)=>({count:observations[i].cycles!==null?observations[i].cycles:observations[i].stroke,
        unit:observations[i].cycles!==null?'cycles':'strokes',seconds:observations[i].time,origin:strokeCountOrigin(rep)})),
      sendOff:sendOffSeconds(row?.setTimeSeconds??row?.sendOff)}):null;
    const measured={
      dpcRetention:retention,
      timedRepetitions:times.length,
      strokeCountedRepetitions:strokes.length,
      cycleCountedRepetitions:cycles.length,
      meanSeconds:times.length?times.reduce((s,t)=>s+t,0)/times.length:null,
      timeCvPercent:coefficientOfVariation(times),
      strokeCountCvPercent:coefficientOfVariation(strokes),
      cycleCountCvPercent:coefficientOfVariation(cycles),
      lateVsFirstTimeFraction:firstLast(times),
      lateVsFirstStrokeFraction:firstLast(strokes),
      earlyToLateSpeedPerStrokeFraction:efficiencyChanges,
      efficiencyPairedRepetitions:efficiencyPairs.length,
    };
    entries.push({
      setId:value(row?.id),date:value(row?.scheduleDate??row?.date).slice(0,10),
      prescribedMetres:Math.max(0,num(row?.__ispPrescribedSetMetres??row?.plannedVolume??row?.totalVolume)??0),
      completedMetres:metres,
      energy:resolveCanonicalTrainingEnergy(row).energySystem,
      repetitions:num(row?.reps),rounds:num(row?.rounds),distance:num(row?.distance),
      sendOff:value(row?.sendOff??row?.sendOffTime),
      // Planner target pace is stored in seconds (targetPace).
      targetTime:value(row?.targetTime)||value(row?.targetPace),
      rest:value(row?.rest??row?.restTime),stroke:value(row?.stroke),
      setName:value(row?.setName??row?.name??row?.title),
      phase:value(row?.phase??row?.setPhase??row?.cyclePhase),
      modality:value(row?.modality),
      measured,
      // These are factual inputs to the eventual axis score. Target=0 means
      // not explicitly targeted, NOT zero effect; no measured data is invented.
      axes:Object.fromEntries(TRAINING_AXES.map(axis=>[axis,{
        included:true,completedMetres:metres,explicitTarget:weights[axis]>0,
        explicitTargetMetres:weights[axis]>0?metres:0,
        reasons:reasons[axis],resultsRecorded:times.length>0||strokes.length>0||cycles.length>0,
      }])),
    });
  }
  const perAxis=Object.fromEntries(TRAINING_AXES.map(axis=>[axis,{
    contributingSetCount:entries.length,
    completedMetres:entries.reduce((s,e)=>s+e.completedMetres,0),
    explicitlyTargetedSets:entries.filter(e=>e.axes[axis].explicitTarget).length,
    explicitlyTargetedMetres:entries.reduce((s,e)=>s+e.axes[axis].explicitTargetMetres,0),
    setsWithMeasuredResults:entries.filter(e=>e.axes[axis].resultsRecorded).length,
  }]));
  return {rows:entries,perAxis,calibratedScores:null,
    scoringStatus:'inputs-ready-axis-specific-calibration-not-authorised'};
}
