import crypto from 'node:crypto';
import { buildCoachPoolsideProjection } from './coach-poolside-projection.mjs';

const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();
const allowedPermissions = ['attendance','laneOrder','timing','results','strokeCount','breakout','notes'];

function sessionId(row = {}) { return text(row.id || row.sessionId || row.trainingSessionId); }
function sessionDate(row = {}) { return text(row.scheduleDate || row.sessionDate || row.date || row.startDate).slice(0, 10); }
function tokenHash(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }
function normalizeLanes(value) {
  return Array.from(new Set(list(value).map((lane) => {
    const raw = text(lane).toLowerCase().replace(/^lane\s*/,'');
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 10 ? String(n) : '';
  }).filter(Boolean))).sort((a,b)=>Number(a)-Number(b));
}
function normalizePermissions(value = {}) {
  return Object.fromEntries(allowedPermissions.map((key) => [key, value?.[key] !== false]));
}
function findSession(db, wanted) {
  return [...list(db.trainingSessions), ...list(db.schedule)].find((row) => sessionId(row) === wanted || text(row.trainingSessionId) === wanted) || null;
}
export function publicAssistantPass(row = {}) {
  const { tokenHash: _tokenHash, ...safe } = row || {};
  return safe;
}
export function listAssistantPoolsidePasses(db = {}, sessionIdValue = '', now = new Date().toISOString()) {
  const wanted = text(sessionIdValue);
  const nowMs = Date.parse(now);
  return list(db.assistantPoolsidePasses)
    .filter((row) => text(row.sessionId) === wanted)
    .map((row) => ({ ...publicAssistantPass(row), active: !row.revokedAt && (!Number.isFinite(nowMs) || Date.parse(row.expiresAt) > nowMs) }));
}
export function createAssistantPoolsidePass(db = {}, input = {}) {
  const wantedSessionId = text(input.sessionId);
  const session = findSession(db, wantedSessionId);
  if (!wantedSessionId || !session) return { ok:false, status:404, error:'Canonical session was not found.' };
  const lanes = normalizeLanes(input.lanes);
  if (!lanes.length) return { ok:false, status:400, error:'Assign at least one lane from 1 to 10.' };
  const assistantName = text(input.assistantName);
  if (!assistantName) return { ok:false, status:400, error:'Assistant name is required.' };
  const now = text(input.now) || new Date().toISOString();
  const nowMs = Date.parse(now);
  const active = list(db.assistantPoolsidePasses).filter((row) =>
    text(row.sessionId) === wantedSessionId
    && !text(row.revokedAt)
    && (!Number.isFinite(nowMs) || Date.parse(row.expiresAt) > nowMs)
  );
  if (active.length >= 5) return { ok:false, status:409, error:'This session already has 5 active assistant passes.' };
  const token = text(input.token) || crypto.randomBytes(24).toString('base64url');
  const passId = text(input.passId) || `assistant-pass:${crypto.randomUUID()}`;
  const expiresAt = text(input.expiresAt) || new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 18 * 60 * 60 * 1000).toISOString();
  const row = {
    id: passId,
    sessionId: wantedSessionId,
    scheduleId: text(session.scheduleId || session.id),
    assistantName,
    assistantUserId: text(input.assistantUserId),
    kind: text(input.kind).toLowerCase() === 'registered' ? 'registered' : 'guest',
    lanes,
    permissions: normalizePermissions(input.permissions),
    tokenHash: tokenHash(token),
    issuedBy: text(input.issuedBy),
    createdAt: now,
    expiresAt,
    revokedAt: '',
  };
  return { ok:true, db:{ ...db, assistantPoolsidePasses:[...list(db.assistantPoolsidePasses), row] }, pass:publicAssistantPass(row), token };
}
export function revokeAssistantPoolsidePass(db = {}, input = {}) {
  const passId = text(input.passId);
  const rows = list(db.assistantPoolsidePasses);
  const index = rows.findIndex((row) => text(row.id) === passId);
  if (index < 0) return { ok:false, status:404, error:'Assistant pass was not found.' };
  const next = rows.slice();
  next[index] = { ...next[index], revokedAt:text(input.now)||new Date().toISOString(), revokedBy:text(input.revokedBy) };
  return { ok:true, db:{...db,assistantPoolsidePasses:next}, pass:publicAssistantPass(next[index]) };
}
export function resolveAssistantPoolsidePass(db = {}, token = '', now = new Date().toISOString()) {
  const hash = tokenHash(token);
  const row = list(db.assistantPoolsidePasses).find((item) => text(item.tokenHash) === hash);
  if (!row) return { ok:false, status:401, error:'Assistant pass is invalid.' };
  if (text(row.revokedAt)) return { ok:false, status:403, error:'Assistant pass has been revoked.' };
  const nowMs = Date.parse(now), expiryMs = Date.parse(row.expiresAt);
  if (Number.isFinite(nowMs) && Number.isFinite(expiryMs) && expiryMs <= nowMs) return { ok:false, status:403, error:'Assistant pass has expired.' };
  return { ok:true, pass:row };
}
function laneAssignmentsForSession(db, pass) {
  const wanted = text(pass.sessionId);
  return list(db.trainingLaneAssignments)
    .filter((row) => text(row.sessionId || row.trainingSessionId) === wanted && pass.lanes.includes(text(row.laneId || row.lane || row.laneNumber).replace(/^Lane\s*/i,'')))
    .map((row) => ({ swimmerId:text(row.swimmerId || row.athleteId), laneId:text(row.laneId || row.lane || row.laneNumber).replace(/^Lane\s*/i,''), laneOrder:Number(row.laneOrder || row.position || row.orderInLane || 0) || 0 }));
}
export function buildAssistantPoolsideProjection(db = {}, token = '', now = new Date().toISOString()) {
  const resolved = resolveAssistantPoolsidePass(db, token, now);
  if (!resolved.ok) return resolved;
  const pass = resolved.pass;
  const session = findSession(db, text(pass.sessionId));
  if (!session) return { ok:false, status:404, error:'Session linked to this assistant pass no longer exists.' };
  const date = sessionDate(session) || new Date().toISOString().slice(0,10);
  const projection = buildCoachPoolsideProjection(db, { date });
  const canonical = projection.sessions.find((row) => text(row.id) === text(pass.sessionId) || text(row.scheduleId) === text(pass.scheduleId));
  if (!canonical) return { ok:false, status:404, error:'Canonical session projection is unavailable.' };
  const assignments = laneAssignmentsForSession(db, pass);
  const swimmerIds = new Set(assignments.map((row)=>row.swimmerId));
  const swimmers = projection.swimmers.filter((row)=>swimmerIds.has(text(row.id))).map((row)=>({
    ...row,
    laneId:assignments.find((a)=>a.swimmerId===text(row.id))?.laneId || '',
    laneOrder:assignments.find((a)=>a.swimmerId===text(row.id))?.laneOrder || 0,
  }));
  const attendance = projection.attendance.filter((row)=>swimmerIds.has(text(row.swimmerId)));
  return {
    ok:true,
    pass:publicAssistantPass(pass),
    session:canonical,
    swimmers,
    attendance,
    laneAssignments:assignments,
  };
}
function setAttendance(db, sessionIdValue, event, actor, now) {
  const swimmerId=text(event.swimmerId), status=text(event.status || (event.present === false ? 'absent' : 'present')).toLowerCase();
  if(!swimmerId || !['present','absent','late','excused','unmarked'].includes(status)) return db;
  const rows=list(db.attendance).filter((row)=>!(text(row.sessionId||row.trainingSessionId)===sessionIdValue && text(row.swimmerId||row.athleteId)===swimmerId));
  if(status!=='unmarked') rows.push({id:`attendance:${sessionIdValue}:${swimmerId}`,sessionId:sessionIdValue,trainingSessionId:sessionIdValue,swimmerId,status,present:status==='present'||status==='late',updatedAt:now,updatedBy:actor});
  return {...db,attendance:rows};
}
function setLaneOrder(db, pass, event, actor, now) {
  const laneId=text(event.laneId||event.lane).replace(/^Lane\s*/i,'');
  if(!pass.lanes.includes(laneId) || !Array.isArray(event.order)) return db;
  const order=event.order.map(text).filter(Boolean);
  let rows=list(db.trainingLaneAssignments).filter((row)=>!(text(row.sessionId||row.trainingSessionId)===text(pass.sessionId) && text(row.laneId||row.lane||row.laneNumber).replace(/^Lane\s*/i,'')===laneId));
  rows.push(...order.map((swimmerId,index)=>({sessionId:text(pass.sessionId),swimmerId,laneId,laneOrder:index+1,source:'assistant-poolside',updatedAt:now,updatedBy:actor})));
  return {...db,trainingLaneAssignments:rows};
}
function appendResult(db, pass, event, actor, now) {
  const setId=text(event.setId), swimmerId=text(event.swimmerId);
  if(!setId||!swimmerId)return db;
  const sets=list(db.trainingSessionSets);const index=sets.findIndex((row)=>text(row.id)===setId && text(row.trainingSessionId||row.sessionId||row.parentSessionId)===text(pass.sessionId));
  if(index<0)return db;
  const existing=sets[index]?.resultsBySwimmer && typeof sets[index].resultsBySwimmer==='object'?sets[index].resultsBySwimmer:{};
  const prior=existing[swimmerId]&&typeof existing[swimmerId]==='object'?existing[swimmerId]:{};
  const rep={
    overallTime:text(event.time||event.overallTime),
    overallStrokeCount:text(event.strokeCount),
    breakoutTime:text(event.breakoutTime),
    breakoutDistance:text(event.breakoutDistance),
    notes:text(event.note||event.notes),
    recordedAt:now,
    recordedBy:actor,
  };
  const next=sets.slice();next[index]={...next[index],resultsBySwimmer:{...existing,[swimmerId]:{...prior,reps:[...list(prior.reps),rep],source:'assistant-poolside',updatedAt:now,updatedBy:actor}},updatedAt:now,updatedBy:actor};
  return {...db,trainingSessionSets:next};
}
export function applyAssistantPoolsideEvents(db = {}, input = {}) {
  const resolved = resolveAssistantPoolsidePass(db, input.token, input.now);
  if(!resolved.ok)return resolved;
  const pass=resolved.pass, actor=`assistant:${pass.assistantName}`, now=text(input.now)||new Date().toISOString();
  let next=db;const accepted=[];
  for(const event of list(input.events)){
    const kind=text(event.kind);
    if(kind==='attendance' && pass.permissions.attendance){next=setAttendance(next,text(pass.sessionId),event,actor,now);accepted.push(kind);}
    else if(kind==='lane-order' && pass.permissions.laneOrder){next=setLaneOrder(next,pass,event,actor,now);accepted.push(kind);}
    else if(kind==='result' && pass.permissions.results){next=appendResult(next,pass,event,actor,now);accepted.push(kind);}
  }
  const audit=list(next.assistantPoolsideAudit);
  audit.push(...accepted.map((kind)=>({id:`assistant-audit:${crypto.randomUUID()}`,passId:pass.id,sessionId:pass.sessionId,assistantName:pass.assistantName,kind,at:now})));
  return {ok:true,db:{...next,assistantPoolsideAudit:audit},accepted};
}
