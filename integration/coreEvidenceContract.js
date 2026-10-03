// Integration Release 1: pure, tenant-scoped contract. No database writes here.
// Callers must authenticate and resolve the permitted tenant/coach/swimmer before committing.
const str = v => String(v ?? '').trim();
const rows = v => Array.isArray(v) ? v : [];
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const types = new Set(['training_questionnaire','race_questionnaire','competition_reflection','shared_diary','coach_feedback','athlete_training','athlete_test','athlete_competition']);
const appSources = new Set(['athlete-app','coach-poolside','athlyrax-core']);
const date = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const ref = (v, name) => { const s = str(v); if (!s || s.length > 160) throw invalid('Missing/invalid '+name); return s; };
const same = (a,b) => str(a) === str(b);
export const INTEGRATION_RECORD_TYPES = Object.freeze([...types]);
export function validateIntegrationEvidence(input, context) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Evidence object required');
  const organisationId = ref(context?.organisationId,'authorised organisation');
  const swimmerId = ref(input.swimmerId,'canonical swimmer ID');
  if (!same(input.organisationId,organisationId)) throw invalid('Organisation mismatch',403);
  const source = str(input.source);
  if (!appSources.has(source)) throw invalid('Unknown application source');
  const recordId = ref(input.sourceRecordId,'stable source record ID');
  const recordType = str(input.recordType);
  if (!types.has(recordType)) throw invalid('Unsupported record type');
  if (!date(input.createdAt) || !date(input.modifiedAt)) throw invalid('Valid audit timestamps required');
  if (Date.parse(input.modifiedAt) < Date.parse(input.createdAt)) throw invalid('Modification precedes creation');
  if (!context?.allowedSwimmerIds?.includes(swimmerId)) throw invalid('Swimmer not authorised or canonical',403);
  if (recordType === 'shared_diary' && input.visibility !== 'shared') throw invalid('Private diary must not be sent as shared evidence',403);
  if (recordType === 'coach_feedback' && !context?.authorisedCoachIds?.includes(str(input.creatorId))) throw invalid('Coach not authorised',403);
  const visibility = str(input.visibility || 'coach');
  if (!['private','coach','shared'].includes(visibility)) throw invalid('Invalid visibility');
  const payload = input.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('Structured payload required');
  const result = {
    organisationId, swimmerId, source, sourceRecordId:recordId, recordType,
    creatorId:ref(input.creatorId,'creator ID'), createdAt:input.createdAt, modifiedAt:input.modifiedAt,
    visibility, coachId:str(input.coachId), sharedWithCoachIds:rows(input.sharedWithCoachIds).map(str).filter(Boolean), squadId:str(input.squadId), sessionId:str(input.sessionId),
    scheduleOccurrenceId:str(input.scheduleOccurrenceId), setId:str(input.setId),
    competitionId:str(input.competitionId), eventId:str(input.eventId),
    calendarDate:str(input.calendarDate), payload:structuredClone(payload),
    validatedCapabilityEligible:false, provenance:'self-reported',
  };
  if (recordType === 'training_questionnaire' && !(result.sessionId && result.squadId && result.coachId)) throw invalid('Training questionnaire requires session, squad and assigned coach');
  if (recordType === 'race_questionnaire' && !(result.competitionId && result.eventId)) throw invalid('Race questionnaire requires competition and event');
  if (recordType === 'competition_reflection' && !result.competitionId) throw invalid('Competition reference required');
  if (recordType === 'shared_diary' && (!/^\d{4}-\d{2}-\d{2}$/.test(result.calendarDate) || !result.sharedWithCoachIds.length)) throw invalid('Explicit diary date and coach sharing grants required');
  if (recordType === 'coach_feedback' && !(result.sessionId || result.eventId)) throw invalid('Coach feedback needs a session or event reference');
  return result;
}
export const integrationEvidenceKey = e => [str(e.organisationId),str(e.source),str(e.sourceRecordId)].join(':');
export function mergeIntegrationEvidence(existing, incoming) {
  const map = new Map(rows(existing).map(e => [integrationEvidenceKey(e),e]));
  const accepted=[],unchanged=[],conflicts=[];
  for (const row of rows(incoming)) {
    const key=integrationEvidenceKey(row), previous=map.get(key);
    if (!previous) {map.set(key,row);accepted.push(key);continue;}
    if (previous.swimmerId!==row.swimmerId || previous.recordType!==row.recordType) {conflicts.push({key,reason:'identity_conflict'});continue;}
    const oldTime=Date.parse(previous.modifiedAt), newTime=Date.parse(row.modifiedAt);
    if (!Number.isFinite(newTime) || newTime<oldTime) {conflicts.push({key,reason:'stale_update'});continue;}
    if (newTime===oldTime) {
      if (JSON.stringify(previous)===JSON.stringify(row)) unchanged.push(key);
      else conflicts.push({key,reason:'same_version_conflict'});
      continue;
    }
    map.set(key,{...previous,...row,createdAt:previous.createdAt});accepted.push(key);
  }
  return {records:[...map.values()],accepted,unchanged,conflicts};
}
export function classifyPoolsideImport(input,{organisationId,swimmers=[],sessions=[],sets=[]}={}) {
  const review=[],ready=[];
  for(const row of rows(input)) {
    const id=str(row.sourceRecordId);
    if (!id || !same(row.organisationId,organisationId)) {review.push({sourceRecordId:id,reason:'missing_id_or_tenant_mismatch'});continue;}
    const matchingSwimmers=swimmers.filter(s=>same(s.id,row.swimmerId) && same(s.organisationId||organisationId,organisationId));
    const matchingSessions=sessions.filter(s=>same(s.id,row.sessionId) || (row.scheduleOccurrenceId && same(s.scheduleOccurrenceId,row.scheduleOccurrenceId)));
    const matchingSets=sets.filter(s=>same(s.id,row.setId) && matchingSessions.some(session=>same(s.sessionId,session.id)));
    if (matchingSwimmers.length!==1 || matchingSessions.length!==1 || matchingSets.length!==1) {
      review.push({sourceRecordId:id,reason:'unmatched_or_ambiguous_canonical_reference'});continue;
    }
    if (!Number.isInteger(Number(row.repNumber)) || Number(row.repNumber)<1) {review.push({sourceRecordId:id,reason:'invalid_rep_number'});continue;}
    ready.push({...row,swimmerId:matchingSwimmers[0].id,sessionId:matchingSessions[0].id,setId:matchingSets[0].id,validatedCapabilityEligible:false});
  }
  return {ready,needsReview:review};
}
export const FUTURE_COMMUNICATION_CONTRACT = Object.freeze(['templateId','assignmentId','swimmerId','squadId','coachId','scheduledAt','urgentNoteId','acknowledgedAt','responseId']);
