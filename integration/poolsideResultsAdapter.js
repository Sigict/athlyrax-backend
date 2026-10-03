// Pure adapter: updates existing trainingSessionSets/resultsBySwimmer, never a competing results database.
import { classifyPoolsideImport } from './coreEvidenceContract.js';
const list=v=>Array.isArray(v)?v:[];
const text=v=>String(v??'').trim();
const parentId=row=>text(row.trainingSessionId||row.sessionId||row.parentSessionId);
export function applyPoolsideImportToTrainingResults(db,records,{organisationId}={}) {
 const sessions=list(db?.trainingSessions).map(s=>({...s,scheduleOccurrenceId:s.scheduleOccurrenceId||s.scheduleId}));
 const sets=list(db?.trainingSessionSets).map(s=>({...s,sessionId:parentId(s)}));
 const {ready,needsReview}=classifyPoolsideImport(records,{organisationId,swimmers:list(db?.swimmers),sessions,sets});
 const nextSets=list(db?.trainingSessionSets).map(s=>({...s}));
 const accepted=[],retries=[],conflicts=[...needsReview];
 const seen=new Map();
 for(const item of ready) {
  const identity=[item.organisationId,item.source||'coach-poolside',item.sourceRecordId].join(':');
  if(seen.has(identity)) {conflicts.push({sourceRecordId:item.sourceRecordId,reason:'duplicate_source_in_batch'});continue;}
  seen.set(identity,true);
  const index=nextSets.findIndex(s=>text(s.id)===text(item.setId)&&parentId(s)===text(item.sessionId));
  if(index<0) {conflicts.push({sourceRecordId:item.sourceRecordId,reason:'set_moved'});continue;}
  const elsewhere=nextSets.some(otherSet=>Object.entries(otherSet.resultsBySwimmer||{}).some(([otherSwimmer,result])=>
    list(result?.reps).some((rep,repIndex)=>text(rep?.sourceRecordId||rep?.integrationSourceRecordId)===text(item.sourceRecordId)
      && !(text(otherSet.id)===text(item.setId)&&text(otherSwimmer)===text(item.swimmerId)&&repIndex===Number(item.repNumber)-1))));
  if(elsewhere){conflicts.push({sourceRecordId:item.sourceRecordId,reason:'source_id_reused_for_another_canonical_slot'});continue;}
  const set=nextSets[index];
  const resultMap=set.resultsBySwimmer||{};
  const previous=resultMap[item.swimmerId];
  const reps=list(previous?.reps).slice();
  const n=Number(item.repNumber)-1, old=reps[n];
  const oldId=text(old?.sourceRecordId||old?.integrationSourceRecordId);
  if(old) {
   if(oldId && oldId!==item.sourceRecordId) {conflicts.push({sourceRecordId:item.sourceRecordId,reason:'rep_owned_by_another_source'});continue;}
   if(!oldId) {conflicts.push({sourceRecordId:item.sourceRecordId,reason:'manual_result_requires_review'});continue;}
   const oldTime=Date.parse(text(old?.modifiedAt||old?.captureTimestamp));
   const newTime=Date.parse(text(item.modifiedAt||item.captureTimestamp));
   if(!Number.isFinite(newTime)||newTime<oldTime) {conflicts.push({sourceRecordId:item.sourceRecordId,reason:'stale_revision'});continue;}
   if(newTime===oldTime) {retries.push(identity);continue;}
  }
  const rep={
    ...(old||{}),repNumber:item.repNumber,
    integrationSourceRecordId:item.sourceRecordId,
    sourceRecordId:item.sourceRecordId, source:'coach-poolside',
    createdAt:text(old?.createdAt||item.createdAt||item.captureTimestamp),
    modifiedAt:text(item.modifiedAt||item.captureTimestamp),
    recordedBy:text(item.recordingCoachId),
    lane:item.lane,sendOffSeconds:item.sendOffSeconds,
    actualRestSeconds:item.actualRestSeconds,observation:text(item.observation),
    overallTime:item.timeSeconds,
    splits:list(item.splits).map((split,i)=>typeof split==='object'&&split!==null
      ? {...split,strokeCount:split.strokeCount??list(item.strokeCounts)[i]??''}
      : {time:split,strokeCount:list(item.strokeCounts)[i]??''}),
    plannedStimulus:item.plannedStimulus??null,actualStimulus:item.actualStimulus??null,
    validatedCapabilityEligible:false,
  };
  reps[n]=rep;
  const resultsBySwimmer={...resultMap,[item.swimmerId]:{...(previous||{}),reps,source:'coach-poolside',updatedAt:rep.modifiedAt}};
  nextSets[index]={...set,resultsBySwimmer};
  accepted.push(identity);
 }
 return {db:{...db,trainingSessionSets:nextSets},accepted,retries,needsReview:conflicts};
}
