// Read models for an integration UI; status must come from authenticated server acknowledgements.
const list=x=>Array.isArray(x)?x:[];
const s=x=>String(x??'').trim();
export function athleteFeedbackForSwimmer(records,{organisationId,swimmerId,viewerRole='coach',coachId='',authorisedCoachIds=[],sharedWithCoachIds=[],filters={}}={}) {
 return list(records).filter(row=>{
  if(s(row.organisationId)!==s(organisationId)||s(row.swimmerId)!==s(swimmerId)) return false;
  const athleteView=viewerRole==='athlete';
  if (!athleteView && !(coachId && list(authorisedCoachIds).includes(coachId))) return false;
  const diary=row.recordType==='shared_diary';
  if(diary && !athleteView && !(row.visibility==='shared' && list(row.sharedWithCoachIds).includes(coachId) && list(sharedWithCoachIds).includes(coachId))) return false;
  if(row.visibility==='private' && !athleteView) return false;
  if(filters.recordType && s(row.recordType)!==s(filters.recordType)) return false;
  if(filters.sessionId && s(row.sessionId)!==s(filters.sessionId)) return false;
  if(filters.competitionId && s(row.competitionId)!==s(filters.competitionId)) return false;
  if(filters.eventId && s(row.eventId)!==s(filters.eventId)) return false;
  if(filters.from && s(row.createdAt).slice(0,10)<s(filters.from)) return false;
  if(filters.to && s(row.createdAt).slice(0,10)>s(filters.to)) return false;
  return true;
 }).sort((a,b)=>s(b.createdAt).localeCompare(s(a.createdAt)));
}
export function connectionStatus(ack={},pendingRecords=[],failedRecords=[],needsReview=[]) {
 const successful=ack?.serverAcknowledged===true && ack?.authenticated===true && ack?.tenantVerified===true;
 return {
  status:successful?'connected':'not_verified',
  lastSuccessfulSync:successful?s(ack.lastSuccessfulSync):'',
  lastAttemptedSync:s(ack.lastAttemptedSync),
  pendingCount:list(pendingRecords).length,
  failedCount:list(failedRecords).length,
  needsReviewCount:list(needsReview).length,
  error:s(ack.lastError || (successful?'':'No authenticated, tenant-scoped server synchronisation has been verified')),
 };
}
export function preparePoolsideTrainingEvidence(record) {
 const value=(key)=>record[key]===null||record[key]===undefined?'':record[key];
 return {
  organisationId:s(record.organisationId), swimmerId:s(record.swimmerId),
  sessionId:s(record.sessionId), scheduleOccurrenceId:s(record.scheduleOccurrenceId),
  setId:s(record.setId), sourceRecordId:s(record.sourceRecordId),
  source:'coach-poolside',recordingCoachId:s(record.recordingCoachId),
  createdAt:s(record.createdAt||record.captureTimestamp),modifiedAt:s(record.modifiedAt||record.captureTimestamp),
  repNumber:Number(record.repNumber),lane:value('lane'),
  timeSeconds:value('timeSeconds'),splits:list(record.splits),
  strokeCounts:list(record.strokeCounts),sendOffSeconds:value('sendOffSeconds'),
  actualRestSeconds:record.actualRestSeconds!==null&&record.actualRestSeconds!==undefined&&record.actualRestSeconds!==''
    ? record.actualRestSeconds
    : Number.isFinite(Number(record.sendOffSeconds))&&Number(record.sendOffSeconds)>0&&Number(record.timeSeconds)>0
      ? Math.max(0,Number(record.sendOffSeconds)-Number(record.timeSeconds)) : '',
  observation:s(record.observation).slice(0,1000),
  plannedStimulus:record.plannedStimulus??null, actualStimulus:record.actualStimulus??null,
  validatedCapabilityEligible:false,
 };
}
