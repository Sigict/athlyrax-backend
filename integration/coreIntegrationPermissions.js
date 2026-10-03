// Fail-closed identity and relationship resolution for Core connected evidence.
// Never infer a swimmer by a name, PB, lane number or approximate match.
const str=v=>String(v??'').trim();
const low=v=>str(v).toLowerCase();
const list=v=>Array.isArray(v)?v:[];
const active=row=>!['revoked','disconnected','rejected','ended','expired','inactive'].includes(low(row?.status))&&row?.active!==false&&(!row?.expiresAt||Date.parse(row.expiresAt)>Date.now());
export function canonicalSwimmer(db,swimmerId) {
 const matched=list(db?.swimmers).filter(s=>str(s?.id)===str(swimmerId)&&str(swimmerId));
 return matched.length===1?matched[0]:null;
}
export function canonicalCoachId(db,auth) {
 const claimed=str(auth?.coachId);
 const username=low(auth?.username),email=low(auth?.email);
 const matched=list(db?.coaches).filter(c=>
  (claimed&&str(c?.id)===claimed)
  ||(username&&[c?.accountUsername,c?.username,c?.authUsername].some(v=>low(v)===username))
  ||(email&&[c?.accountEmail,c?.email].some(v=>low(v)===email)));
 const unique=[...new Set(matched.map(row=>str(row?.id)).filter(Boolean))];
 return unique.length===1?unique[0]:'';
}
export function canonicalAthleteSwimmerId(db,auth) {
 if(low(auth?.role)!=='swimmer')return '';
 const username=low(auth?.username),claimed=str(auth?.swimmerId||auth?.canonicalSwimmerId);
 if(!username&&!claimed)return '';
 const matched=list(db?.swimmers).filter(s=>
  (claimed?str(s?.id)===claimed:(username&&low(s?.swimmerAccountUsername)===username))
  &&(!str(s?.swimmerAccountUsername)||low(s.swimmerAccountUsername)===username)
  &&(claimed||str(s?.swimmerAccountUsername)));
 return matched.length===1?str(matched[0].id):'';
}
export function coachRelationship(db,coachId,swimmerId) {
 const coach=str(coachId),swimmer=canonicalSwimmer(db,swimmerId);
 if(!coach||!swimmer)return {allowed:false,reason:'missing_canonical_relationship'};
 const links=list(db?.coachSwimmerLinks).filter(l=>str(l.coachId)===coach&&str(l.swimmerId)===str(swimmerId))
  .sort((a,b)=>str(b.modifiedAt||b.updatedAt||b.decidedAt||b.createdAt).localeCompare(str(a.modifiedAt||a.updatedAt||a.decidedAt||a.createdAt)));
 // Latest explicit decision has authority, including revocation after squad transfers.
 if(links.length) {
  const latest=links[0];
  if(!active(latest))return {allowed:false,reason:'connection_revoked'};
  return ['approved','active','connected'].includes(low(latest.status))
   ? {allowed:true,reason:'approved_direct_link'} : {allowed:false,reason:'connection_not_approved'};
 }
 const squadIds=new Set([swimmer.currentSquadId,swimmer.squadId,...list(swimmer.currentSquadIds),...list(swimmer.squadIds)].map(str).filter(Boolean));
 const assigned=list(db?.squads).some(s=>
  squadIds.has(str(s.id)) && s.active!==false
  &&[s.headCoachId,s.coachId,...list(s.coachIds),...list(s.assistantCoachIds)].map(str).includes(coach));
 return assigned?{allowed:true,reason:'current_squad_assignment'}:{allowed:false,reason:'coach_not_assigned'};
}
export function activeAthleteConnection(db,auth,swimmerId) {
 const canonical=canonicalAthleteSwimmerId(db,auth);
 if(!canonical||canonical!==str(swimmerId))return false;
 const swimmer=canonicalSwimmer(db,canonical);
 return swimmer?.coachConnected===true&&['approved','connected'].includes(low(swimmer.coachLinkStatus));
}
