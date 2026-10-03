import { canonicalSwimmer, coachRelationship } from './coreIntegrationPermissions.js';
const str=v=>String(v??'').trim();
const list=v=>Array.isArray(v)?v:[];
const parentId=row=>str(row.trainingSessionId||row.sessionId||row.parentSessionId);
const belongs=(row,ids)=>ids.has(str(row?.squadId))||list(row?.squadIds).some(id=>ids.has(str(id)));
export function projectAuthorisedCoreToAthlete(db,{organisationId,swimmerId}={}) {
 const swimmer=canonicalSwimmer(db,swimmerId);
 if(!swimmer||!organisationId)return null;
 const squadIds=new Set([swimmer.currentSquadId,swimmer.squadId,...list(swimmer.currentSquadIds)].map(str).filter(Boolean));
 const squads=list(db.squads).filter(row=>squadIds.has(str(row.id))).map(row=>({id:str(row.id),name:str(row.name)}));
 const coaches=list(db.coaches).filter(row=>coachRelationship(db,str(row.id),swimmerId).allowed)
  .map(row=>({id:str(row.id),name:str(row.fullName||row.name)}));
 const sessions=list(db.trainingSessions).filter(row=>str(row.id)&&belongs(row,squadIds)&&row.athleteVisibility!=='private'&&row.cancelled!==true)
  .map(row=>({id:str(row.id),scheduleOccurrenceId:str(row.scheduleOccurrenceId||row.scheduleId),
   name:str(row.name||row.sessionName),date:str(row.date||row.scheduleDate),squadId:str(row.squadId),status:str(row.status)}));
 const sessionIds=new Set(sessions.map(row=>row.id));
 const sets=list(db.trainingSessionSets).filter(row=>parentId(row)&&sessionIds.has(parentId(row)))
  .map(row=>({id:str(row.id),sessionId:parentId(row),order:row.order??row.setN??null,
   distance:row.distance??null,repetitions:row.reps??row.repCount??null,stroke:str(row.stroke||row.strokes),
   sendOff:row.sendOff??row.sendoff??null,plannedStimulus:row.plannedStimulus??null,
   ownResult:row.resultsBySwimmer?.[swimmerId]??null}));
 const competitions=list(db.fixtures).filter(row=>belongs(row,squadIds))
  .map(row=>({id:str(row.id||row.fixtureId),name:str(row.name),date:str(row.date||row.startDate),
   events:list(row.events||row.eventRows).map(event=>({id:str(event.id||event.eventId),eventNumber:event.eventNumber??event.eventN??null,
     name:str(event.name),distance:event.distance??null,stroke:str(event.stroke)}))}));
 const officialResults=list(db.competitionResults).filter(row=>str(row.swimmerId)===swimmerId
   && ['official','imported-official','verified-official'].includes(str(row.sourceKind||row.verificationStatus)))
  .map(row=>({id:str(row.id),competitionId:str(row.competitionId||row.fixtureId),eventId:str(row.eventId),swimmerId,
    time:row.time??row.resultTime??null,position:row.position??null,sourceKind:'official',recordedAt:str(row.recordedAt)}));
 const coachFeedback=list(db.athleteFeedback).filter(row=>str(row.organisationId)===organisationId
  &&str(row.swimmerId)===swimmerId&&row.recordType==='coach_feedback'&&row.visibility==='shared')
  .map(row=>({sourceRecordId:row.sourceRecordId,source:row.source,creatorId:row.creatorId,createdAt:row.createdAt,
   modifiedAt:row.modifiedAt,sessionId:row.sessionId,eventId:row.eventId,payload:row.payload}));
 const capability=list(db.capabilityAssessments).filter(row=>str(row.swimmerId)===swimmerId&&row.validated===true&&row.source!=='athlete-app')
  .map(row=>({id:str(row.id),swimmerId,date:str(row.date||row.assessedAt),axes:row.axes||row.capabilityAxes||{},validated:true,source:str(row.source||'athlyrax-core')}));
 return {organisationId,swimmer:{id:swimmerId,name:str(swimmer.fullName||swimmer.name),connection:'club-connected'},
  squads,coaches,sessions,sets,competitions,officialResults,coachFeedback,validatedCapability:capability,
  dataProvenance:{source:'athlyrax-core',selfReportedEvidenceExcludedFromCapability:true}};
}
