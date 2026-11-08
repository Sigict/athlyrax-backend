// Group Test Results: tenant-scoped, validated mutation of the canonical Tests
// collection (and the linked Training Session set when the protocol matches).
// Ported from Sigict/athlyrax-v6-private server/coach-pilot-endpoints.mjs so the
// production backend serves POST /coach/tests/group-results. Strokes (arm
// strokes) and stroke cycles are stored as two separate measurements.
import { canonicalBuiltInTestTemplate } from './vendor/test-template-catalog.mjs';
import { summarizeRecordedReps, parseRecordedSwimSeconds } from './vendor/recorded-set-averages.mjs';

const list = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? '').trim();
const low = value => text(value).toLowerCase();
const isoDate = value => /^\d{4}-\d{2}-\d{2}$/.test(text(value))
  && !Number.isNaN(new Date(text(value) + 'T00:00:00Z').getTime())
  && new Date(text(value) + 'T00:00:00Z').toISOString().slice(0,10) === text(value);
// Fingerprint of a saved test result's recorded measurements. Identical copy
// of athlyrax-v6-private/src/utils/groupTestResultFingerprint.js. A change is
// refused only when the RESULT changed since the grid opened: a whole-database
// save re-stamps every row's updatedAt without changing the result.
export function groupTestResultFingerprint(row) {
  if (!row || typeof row !== 'object') return '';
  const values = (object) => Object.keys(object && typeof object === 'object' ? object : {}).sort()
    .map((key) => [key, text(object[key])]).filter(([, value]) => value !== '');
  const reps = list(row.repResults).map((rep) => [
    text(rep?.overallTime || rep?.time), text(rep?.overallStrokeCount ?? rep?.strokeCount),
    text(rep?.strokeCountUnit).toLowerCase() === 'cycles' ? 'cycles' : 'strokes',
    text(rep?.strokeCycles), text(rep?.notes), values(rep?.resultValues),
  ]);
  return JSON.stringify([reps, text(row.resultValue ?? row.result), values(row.resultValues)]);
}

function invalid(message,status=400) { const error=new Error(message);error.status=status;throw error; }
function squadIds(row) { return [
  row?.currentSquadId,row?.squadId,row?.swimSquadId,
  ...list(row?.currentSquadIds),...list(row?.squadIds),...list(row?.swimSquadIds),
].map(text).filter(Boolean); }
function templateName(row) { return text(row?.name || row?.templateName); }
function builtInRows() {
  return ['Max','Repeatability','Aerobic / Durability Check','Height & Weight','50m Run','High Jump','500m Row','Gym Strength']
    .map(name => ({...canonicalBuiltInTestTemplate(name),
      id:'builtin-test-'+low(name).replace(/[^a-z0-9]+/g,'-'),name}));
}
function templateItems(template) {
  const canonical=canonicalBuiltInTestTemplate(templateName(template));
  const supplied=list(canonical?.rows).length ? canonical.rows : list(template?.rows);
  return (supplied.length ? supplied : [template]).map((row,index) => ({
    key:text(row?.label || row?.setName || row?.description || row?.name || row?.id) || String(index+1),
    reps:Math.max(1,Math.min(100,Number(row?.reps||1)||1)),
    distance:Math.max(0,Number(row?.distance||0)||0),
    resultFields:list(row?.resultFields).length ? row.resultFields : list(template?.resultFields),
    resultType:text(row?.resultType||template?.resultType),
    resultUnit:text(row?.resultUnit||template?.resultUnit),
  }));
}
function sameResult(row,entry,selection) {
  return text(row?.swimmerId)===entry.swimmerId
    && text(row?.date||row?.testDate)===selection.date
    && text(row?.templateId)===selection.templateId
    && text(row?.testItemKey||row?.testName||row?.test)===entry.testItemKey
    && text(row?.linkedSetId)===selection.linkedSetId;
}
function protocolMatches(setRow,template,item,templateId) {
  if (!(setRow?.isTestSet===true || setRow?.setType==='test'
    || setRow?.testFlag===true || low(setRow?.testFlag)==='on')) return false;
  const boundId=text(setRow?.testTemplateId || setRow?.templateTestId || setRow?.sourceTemplateId);
  if (boundId) return boundId===templateId;
  const display=low([setRow?.testName,setRow?.setName,setRow?.name,setRow?.description].filter(Boolean).join(' '));
  const name=low(templateName(template));
  if (name==='max') return /\bmax\b/.test(display);
  if (name==='repeatability') return /\brepeat(?:ability)?\b/.test(display);
  // Custom templates require an explicit canonical template identifier.
  void item;
  return false;
}
function safeRep(rep,allowedFields,swimming) {
  const overallTime=text(rep?.overallTime).slice(0,24);
  const overallStrokeCount=text(rep?.overallStrokeCount).slice(0,20);
  if(swimming && overallTime && parseRecordedSwimSeconds(overallTime)===null)
    invalid('Invalid recorded swimming time.');
  if(swimming && overallStrokeCount && !/^\d{1,4}$/.test(overallStrokeCount))
    invalid('Invalid recorded stroke count.');
  const values={};
  allowedFields.forEach(field=>{
    const key=text(field?.key);
    if(key) values[key]=text(rep?.resultValues?.[key]).slice(0,120);
  });
  if (!allowedFields.length && !swimming) values.result=text(rep?.resultValues?.result).slice(0,120);
  const strokeCycles=text(rep?.strokeCycles).slice(0,20);
  if(swimming && strokeCycles && !/^\d{1,4}(?:\.5)?$/.test(strokeCycles))
    invalid('Invalid recorded stroke-cycle count.');
  // Recorded underwater distance (metres, or yards in a yard pool) for the
  // repetition or a split: optional, a plain number with up to two decimals.
  const underwater=(raw,label)=>{
    const value=text(raw).slice(0,10);
    if(value && (!/^\d{1,4}(?:\.\d{1,2})?$/.test(value) || Number(value)>1500))
      invalid('Invalid '+label+' underwater distance.');
    return value;
  };
  const underwaterDistance=swimming?underwater(rep?.underwaterDistance,'recorded'):'';
  const splits=list(rep?.splits).slice(0,32).map(split=>{
    const splitUnderwater=swimming?underwater(split?.underwaterDistance,'split'):'';
    return {
      distanceLabel:text(split?.distanceLabel).slice(0,20),
      time:text(split?.time).slice(0,24),
      strokeCount:text(split?.strokeCount).slice(0,20),
      ...(text(split?.strokeCycles)?{strokeCycles:text(split?.strokeCycles).slice(0,20)}:{}),
      ...(splitUnderwater?{underwaterDistance:splitUnderwater}:{}),
    };
  });
  if(swimming)for(const split of splits)
    if(split.time && parseRecordedSwimSeconds(split.time)===null)
      invalid('Invalid swimming split time.');
  return {overallTime,overallStrokeCount,
    ...(overallStrokeCount?{strokeCountUnit:'strokes'}:{}),
    ...(strokeCycles?{strokeCycles,strokeCycleUnit:'cycles'}:{}),
    ...(underwaterDistance?{underwaterDistance}:{}),
    notes:text(rep?.notes).slice(0,500),
    resultValues:values,splits};
}
function resultSummary(reps) {
  return reps.map((rep,i)=>{
    const cells=[rep.overallTime,rep.overallStrokeCount?rep.overallStrokeCount+' strokes':'',rep.strokeCycles?rep.strokeCycles+' cycles':'',
      rep.underwaterDistance?'UW '+rep.underwaterDistance+' m':'',
      ...Object.entries(rep.resultValues).filter(([,v])=>text(v)).map(([k,v])=>k+': '+v)];
    return cells.some(Boolean) ? 'Rep '+(i+1)+': '+cells.filter(Boolean).join(' / ') : '';
  }).filter(Boolean).join(' | ');
}
function upsertMeasurementHistory(swimmers,records,now) {
  return list(swimmers).map(swimmer=>{
    const own=records.filter(row=>row.swimmerId===text(swimmer?.id));
    if(!own.length)return swimmer;
    const history=list(swimmer?.physicalMeasurements).slice();
    own.forEach(row=>{
      if(row.clear){
        const i=history.findIndex(entry=>text(entry?.id)==='measurement-group-'+row.oldId
          && entry?.source==='group-test-results');
        if(i>=0)history.splice(i,1);
        return;
      }
      const incoming={};
      for(const key of ['heightCm','weightKg','armSpanCm','sittingHeightCm']){
        const raw=text(row?.resultValues?.[key]);if(!raw)continue;
        const n=Number(raw);if(!Number.isFinite(n)||n<=0)invalid('Measurements must be positive numeric values.');
        incoming[key]=n;
      }
      if(!Object.keys(incoming).length)return;
      const index=history.findIndex(entry=>text(entry?.date)===row.date);
      const previous=index>=0?history[index]:{};
      const measured={...previous,...incoming,
        id:previous?.id||'measurement-group-'+row.id,date:row.date,
        source:'group-test-results',createdAt:previous?.createdAt||now,updatedAt:now};
      if(index>=0)history[index]=measured;else history.push(measured);
    });
    return {...swimmer,physicalMeasurements:history};
  });
}
/** Pure, server-enforced tenant-scoped mutation. Client must submit dirty entries only. */
export function applyScopedGroupTestSubmission(db,submission) {
  const source=db&&typeof db==='object'?db:{};
  const date=text(submission?.date),squadId=text(submission?.squadId);
  const templateId=text(submission?.templateId),linkedSetId=text(submission?.linkedSetId);
  if(!isoDate(date)||!squadId||!templateId)invalid('Date, squad and Test Template are required.');
  if(!list(source?.squads).some(row=>text(row?.id)===squadId))invalid('Selected squad is not in this workspace.');
  const templates=[...list(source?.templateTests),...builtInRows()];
  const template=templates.find(row=>text(row?.id)===templateId);
  if(!template)invalid('Unknown Test Template.');
  const category=text(template?.testCategory || template?.category || template?.testFamily || 'Custom');
  const swimming=low(category)==='swimming';
  const items=templateItems(template);
  const allowedItems=new Map(items.map(item=>[item.key,item]));
  const entries=list(submission?.entries);
  if(!entries.length||entries.length>500)invalid('Submit between 1 and 500 changed swimmer/test records.');
  const setRow=linkedSetId?list(source?.trainingSessionSets).find(row=>text(row?.id)===linkedSetId):null;
  if(linkedSetId&&!setRow)invalid('Linked session set is not part of the current workspace.');
  if(setRow){
    const schedule=list(source?.schedule).find(row=>text(row?.id)===text(setRow?.scheduleId));
    const setDate=text(setRow?.scheduleDate||setRow?.date||schedule?.scheduleDate);
    if(setDate&&setDate.slice(0,10)!==date)invalid('Linked session set belongs to a different date.');
    const allowedSquads=[...squadIds(setRow),...squadIds(schedule)].filter(Boolean);
    if(allowedSquads.length&&!allowedSquads.includes(squadId))invalid('Linked session set belongs to another squad.',403);
  }
  const setReps=setRow?Math.max(1,Number(setRow?.rounds||1)*Number(setRow?.reps||1)):0;
  const setDistance=Number(setRow?.distance||0);
  const matchItems=setRow&&swimming?items.filter(item=>item.reps===setReps
    &&(!setDistance||item.distance===setDistance)):[];
  const syncItem=matchItems.length===1&&protocolMatches(setRow,template,matchItems[0],templateId)
    ? matchItems[0]:null;
  const now=new Date().toISOString();
  const nextTests=list(source?.tests).slice();
  const changed=[],seen=new Set();
  for(const submitted of entries){
    const swimmerId=text(submitted?.swimmerId);
    const testItemKey=text(submitted?.testItemKey);
    const item=allowedItems.get(testItemKey);
    if(!swimmerId||!item)invalid('Changed result has an unknown swimmer/test item.');
    const swimmer=list(source?.swimmers).find(row=>text(row?.id)===swimmerId);
    if(!swimmer||!squadIds(swimmer).includes(squadId))
      invalid('Swimmer is not part of the selected squad.',403);
    const recordKey=[swimmerId,testItemKey].join('|');
    if(seen.has(recordKey))invalid('Duplicate swimmer/test item in one submission.');
    seen.add(recordKey);
    const selection={date,squadId,templateId,linkedSetId};
    const index=nextTests.findIndex(row=>sameResult(row,{swimmerId,testItemKey},selection));
    const old=index>=0?nextTests[index]:null;
    const changedElsewhere = typeof submitted?.expectedFingerprint === 'string'
      ? submitted.expectedFingerprint !== groupTestResultFingerprint(old)
      : text(submitted?.expectedUpdatedAt)!==text(old?.updatedAt);
    if(changedElsewhere)
      invalid('Result changed since you opened the grid. Refresh before saving.',409);
    if(submitted?.clear===true){
      if(old)nextTests.splice(index,1);
      const linkedExisting=Boolean(syncItem&&testItemKey===syncItem.key
        && setRow?.resultsBySwimmer?.[swimmerId]);
      if(old||linkedExisting)changed.push({clear:true,swimmerId,oldId:text(old?.id),
        date,testItemKey,category,resultValues:old?.resultValues||{}});
      continue;
    }
    const sourceReps=list(submitted?.repResults);
    if(!sourceReps.length||sourceReps.length>100)
      invalid('Each changed test requires between 1 and 100 repetitions.');
    const allowedFields=list(item.resultFields).length?item.resultFields
      :(swimming?[]:[{key:'result',label:item.resultType||'Result',unit:item.resultUnit}]);
    const repResults=sourceReps.map(rep=>safeRep(rep,allowedFields,swimming));
    const summary=resultSummary(repResults);
    if(!summary)invalid('Empty results must be submitted with clear=true.');
    const recorded=summarizeRecordedReps(repResults,{plannedCount:sourceReps.length});
    const eligible=Boolean(syncItem&&testItemKey===syncItem.key);
    const row={...(old||{}),
      id:old?.id||'group-test-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),
      swimmerId,swimmerName:text(swimmer?.fullName||swimmer?.name||
        [swimmer?.firstName,swimmer?.lastName].filter(Boolean).join(' ')),
      squadId,date,testDate:date,templateId,linkedSetId,testItemKey,testName:testItemKey,test:testItemKey,
      itemLabel:testItemKey,category,resultType:item.resultType,resultUnit:item.resultUnit,
      plannedReps:sourceReps.length,repResults,resultFields:allowedFields,
      resultValues:repResults[0].resultValues,
      resultTime:recorded.averageTime==='—'?'':recorded.averageTime,
      resultStrokes:recorded.averageCycles==='—'?'':recorded.averageCycles,
      resultValue:summary,result:summary,recordingOnly:!eligible,capabilityScoringEligible:eligible,
      source:'group-test-results',createdAt:old?.createdAt||now,updatedAt:now,
    };
    if(index<0)nextTests.push(row);else nextTests[index]=row;
    changed.push(row);
  }
  const measurementChanged=low(category)==='measurements'?changed:[];
  const nextSwimmers=measurementChanged.length
    ?upsertMeasurementHistory(source?.swimmers,measurementChanged,now):source?.swimmers;
  const syncRows=syncItem?changed.filter(row=>row.testItemKey===syncItem.key):[];
  const nextSets=syncRows.length?list(source?.trainingSessionSets).map(row=>{
    if(text(row?.id)!==linkedSetId)return row;
    const resultsBySwimmer={...(row?.resultsBySwimmer||{})};
    syncRows.forEach(entry=>{
      if(entry.clear){delete resultsBySwimmer[entry.swimmerId];return;}
      const previous=resultsBySwimmer[entry.swimmerId]||{};
      const previousReps=Array.isArray(previous)?previous:list(previous?.reps);
      resultsBySwimmer[entry.swimmerId]={...(Array.isArray(previous)?{}:previous),
        reps:entry.repResults.map((rep,i)=>({...previousReps[i],...rep,
          splits:list(rep.splits).length?rep.splits:list(previousReps[i]?.splits)}))};
    });
    return {...row,resultsBySwimmer,updatedAt:now};
  }):source?.trainingSessionSets;
  return {db:{...source,tests:nextTests,swimmers:nextSwimmers,
    trainingSessionSets:nextSets,__meta:{...(source?.__meta||{}),updatedAt:now}},
    changedCount:changed.length,syncedCount:syncRows.length,scoringEligibleCount:changed.filter(row=>row.capabilityScoringEligible).length};
}

// ATHLYRAX_POOLSIDE_TEST_SET_LINK: results recorded poolside (Coach Pool Console, Assistants) for a planned
// TEST set become the swimmer's linked test record, through the same group-test rules (template match,
// scoring eligibility, linked set). Only swimmers without a test record for that set are added;
// existing test records are never changed. Sets that are not test sets, or that match no single test
// template, are left as they are.
export function linkedTestsFromPoolsideSet(db, { setId } = {}) {
  const source = db && typeof db === 'object' ? db : {};
  const setRow = list(source.trainingSessionSets).find((row) => text(row?.id) === text(setId));
  const isTest = setRow && (setRow.isTestSet === true || setRow.setType === 'test' || setRow.testFlag === true || low(setRow.testFlag) === 'on');
  if (!isTest) return { db: source, created: 0, reason: 'not a test set' };
  const schedule = list(source.schedule).find((row) => text(row?.id) === text(setRow.scheduleId || setRow.trainingScheduleId));
  const session = list(source.trainingSessions).find((row) => text(row?.id) === text(setRow.trainingSessionId || setRow.sessionId));
  const date = text(setRow.scheduleDate || setRow.date || schedule?.scheduleDate || schedule?.date || session?.date).slice(0, 10);
  if (!isoDate(date)) return { db: source, created: 0, reason: 'no set date' };
  const setReps = Math.max(1, Number(setRow.rounds || 1) * Number(setRow.reps || 1));
  const setDistance = Number(setRow.distance || 0);
  const templates = [...list(source.templateTests), ...builtInRows()];
  const candidates = [];
  for (const template of templates) {
    if (low(text(template?.testCategory || template?.category || template?.testFamily)) !== 'swimming' && !/^builtin-test-(max|repeatability|aerobic-durability)/.test(text(template?.id))) continue;
    const items = templateItems(template).filter((item) => item.reps === setReps && (!setDistance || item.distance === setDistance));
    if (items.length === 1 && protocolMatches(setRow, template, items[0], text(template.id))) candidates.push({ template, item: items[0] });
  }
  if (candidates.length !== 1) return { db: source, created: 0, reason: 'no single matching test template' };
  const { template, item } = candidates[0];
  const setSquads = [...squadIds(setRow), ...squadIds(schedule), ...squadIds(session)];
  const bySquad = new Map();
  for (const [swimmerId, result] of Object.entries(setRow.resultsBySwimmer || {})) {
    const reps = list(Array.isArray(result) ? result : result?.reps).map((rep) => ({
      overallTime: text(rep?.overallTime || rep?.time), overallStrokeCount: text(rep?.overallStrokeCount || rep?.strokeCount),
      strokeCycles: text(rep?.strokeCycles), underwaterDistance: text(rep?.underwaterDistance || rep?.underwater), splits: list(rep?.splits),
    }));
    if (!reps.some((rep) => rep.overallTime || rep.overallStrokeCount)) continue;
    const swimmer = list(source.swimmers).find((row) => text(row?.id) === swimmerId);
    if (!swimmer) continue;
    const own = squadIds(swimmer);
    const squadId = own.find((id) => setSquads.includes(id)) || (setSquads.length ? '' : own[0]);
    if (!squadId) continue;
    const selection = { date, squadId, templateId: text(template.id), linkedSetId: text(setRow.id) };
    if (list(source.tests).some((row) => sameResult(row, { swimmerId, testItemKey: item.key }, selection))) continue; // never overwrite
    const entries = bySquad.get(squadId) || [];
    entries.push({ swimmerId, testItemKey: item.key, repResults: reps.slice(0, Math.max(setReps, 1)), expectedFingerprint: groupTestResultFingerprint(null) });
    bySquad.set(squadId, entries);
  }
  let next = source; let created = 0;
  for (const [squadId, entries] of bySquad) {
    try {
      const out = applyScopedGroupTestSubmission(next, { date, squadId, templateId: text(template.id), linkedSetId: text(setRow.id), entries });
      next = out.db; created += out.changedCount;
    } catch { /* a swimmer whose recorded reps are not a valid test entry stays as set results only */ }
  }
  return { db: next, created, templateId: text(template.id), testItemKey: item.key };
}
