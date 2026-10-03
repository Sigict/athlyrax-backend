import fs from 'node:fs';
import path from 'node:path';
const list=value=>Array.isArray(value)?value:[];
const text=value=>String(value??'').trim();
const identity=auth=>text(auth?.username).toLowerCase();
const tenant=auth=>text(auth?.tenantId||auth?.clubId||'default');
const participantRoles=new Set(['software-owner','head-coach','assistant-coach','coach']);
function invalid(message,status=400){const error=new Error(message);error.status=status;throw error;}
const pilotFields=['planningMinutes','adminMinutes','capabilityUsefulness','capabilityDecisions',
  'poolsideAttempts','poolsideSuccessful','poolsideCorrections','connectedInsights'];
export function validatePilotResponse(body,actor,existing=[]) {
  if(body?.consent!==true)invalid('Explicit operational pilot consent is required.');
  const checkpoint=text(body?.checkpoint);
  if(!['baseline','day30'].includes(checkpoint))invalid('Unsupported evaluation checkpoint.');
  const id=tenant(actor)+':'+identity(actor);
  const rows=list(existing);
  if(rows.some(row=>text(row?.participantId)===id&&row?.checkpoint===checkpoint))
    invalid('This evaluation checkpoint has already been submitted.',409);
  const baseline=rows.find(row=>text(row?.participantId)===id&&row?.checkpoint==='baseline');
  if(checkpoint==='day30'){
    if(!baseline)invalid('Submit the baseline first.');
    const eligible=Date.parse(text(baseline?.completedAt))+30*86400000;
    if(!Number.isFinite(eligible)||Date.now()<eligible)invalid('Day 30 evaluation is not available yet.',403);
  }
  const entry={id:'pilot-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),
    participantId:id,actor:identity(actor),tenantId:tenant(actor),
    coachName:text(actor?.fullName||actor?.name||actor?.username).slice(0,120),
    checkpoint,completedAt:new Date().toISOString(),consent:true,
    consentVersion:'athlyrax-operational-pilot-v1',consentAt:new Date().toISOString(),
    decisionExample:text(body?.decisionExample).slice(0,500),
    connectedExample:text(body?.connectedExample).slice(0,500)};
  const requiredFields=new Set(['planningMinutes','adminMinutes','capabilityUsefulness']);
  for(const field of pilotFields){
    if(body?.[field]===null||body?.[field]===undefined||body[field]===''){
      if(requiredFields.has(field))invalid('Missing pilot measure: '+field);
      entry[field]=null; // Unknown is not zero: optional operational telemetry is collected separately.
      continue;
    }
    const value=Number(body[field]);
    if(!Number.isFinite(value)||value<0||value>10000||(field==='capabilityUsefulness'&&(value<1||value>5)))
      invalid('Invalid pilot measure: '+field);
    entry[field]=value;
  }
  if(entry.poolsideAttempts!==null && ((entry.poolsideSuccessful!==null && entry.poolsideSuccessful>entry.poolsideAttempts)||(entry.poolsideCorrections!==null && entry.poolsideCorrections>entry.poolsideAttempts)))
    invalid('Successful/corrected poolside collections exceed attempts.');
  return entry;
}

export function installOperationalPilotRoutes({app,storageRoot,readJsonFile,writeAtomicJsonFile,enqueueWrite,requireStrictAuth,requireSoftwareOwnerRole,appendAuthAuditEvent}) {
 const pilotPath=path.join(storageRoot,'pilot-evaluation-responses.json');
 const participant=(req,res,next)=>{if(!participantRoles.has(text(req.auth?.role))){res.status(403).json({error:'Coach account required.'});return;}next();};
 const readPilot=()=>list(readJsonFile(pilotPath)?.rows);
 app.get('/pilot/me',requireStrictAuth,participant,(req,res)=>{const id=tenant(req.auth)+':'+identity(req.auth);res.status(200).json({rows:readPilot().filter(row=>row.participantId===id)});});
 app.get('/pilot/owner',requireStrictAuth,requireSoftwareOwnerRole,(req,res)=>{res.status(200).json({rows:readPilot().filter(row=>row?.consent===true)});});
 app.post('/pilot/respond',requireStrictAuth,participant,async(req,res)=>{try{const entry=await enqueueWrite(async()=>{const rows=readPilot();const validated=validatePilotResponse(req.body,req.auth,rows);fs.mkdirSync(path.dirname(pilotPath),{recursive:true});writeAtomicJsonFile(pilotPath,{schemaVersion:1,rows:[...rows,validated]});return validated;});appendAuthAuditEvent({action:'activity_pilot_evaluation_saved',req,status:'success',target:entry.checkpoint,details:{checkpoint:entry.checkpoint}});res.status(201).json({ok:true,entry});}catch(error){res.status(error.status||500).json({error:error.message||'Pilot response save failed.'});}});
}
