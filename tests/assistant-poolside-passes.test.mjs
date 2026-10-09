import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAssistantPoolsidePass,
  resolveAssistantPoolsidePass,
  buildAssistantPoolsideProjection,
  applyAssistantPoolsideEvents,
  revokeAssistantPoolsidePass,
} from '../assistant-poolside-passes.mjs';

const baseDb = {
  schedule:[{id:'sch-1',scheduleDate:'2026-10-09',squadIds:['sq-1']}],
  trainingSessions:[{id:'sess-1',scheduleId:'sch-1',date:'2026-10-09',squadIds:['sq-1'],title:'PM'}],
  trainingSessionSets:[{id:'set-1',trainingSessionId:'sess-1',reps:8,distance:100}],
  swimmers:[{id:'sw-1',fullName:'A One',squadIds:['sq-1']},{id:'sw-2',fullName:'B Two',squadIds:['sq-1']}],
  trainingLaneAssignments:[{sessionId:'sess-1',swimmerId:'sw-1',laneId:'1',laneOrder:1},{sessionId:'sess-1',swimmerId:'sw-2',laneId:'2',laneOrder:1}],
};

test('assistant pass is restricted, expires and projects assigned lanes only', () => {
  const made=createAssistantPoolsidePass(baseDb,{sessionId:'sess-1',assistantName:'Parent',lanes:[1],token:'secret',now:'2026-10-09T12:00:00.000Z'});
  assert.equal(made.ok,true);
  assert.deepEqual(made.pass.lanes,['1']);
  assert.equal(resolveAssistantPoolsidePass(made.db,'bad','2026-10-09T12:01:00.000Z').ok,false);
  const projection=buildAssistantPoolsideProjection(made.db,'secret','2026-10-09T12:01:00.000Z');
  assert.equal(projection.ok,true);
  assert.deepEqual(projection.swimmers.map((row)=>row.id),['sw-1']);
});

test('assistant events update attendance, lane order and canonical results', () => {
  const made=createAssistantPoolsidePass(baseDb,{sessionId:'sess-1',assistantName:'Helper',lanes:['1'],token:'secret',now:'2026-10-09T12:00:00.000Z'});
  const result=applyAssistantPoolsideEvents(made.db,{token:'secret',now:'2026-10-09T12:05:00.000Z',events:[
    {kind:'attendance',swimmerId:'sw-1',present:true},
    {kind:'lane-order',laneId:'1',order:['sw-1']},
    {kind:'result',setId:'set-1',swimmerId:'sw-1',time:'31.42',strokeCount:'34',breakoutTime:'6.2',breakoutDistance:'8.5'},
  ]});
  assert.equal(result.ok,true);
  assert.equal(result.db.attendance[0].status,'present');
  assert.equal(result.db.trainingLaneAssignments.find((row)=>row.laneId==='1').laneOrder,1);
  assert.equal(result.db.trainingSessionSets[0].resultsBySwimmer['sw-1'].reps[0].overallTime,'31.42');
});

test('maximum five active assistant passes and revocation are enforced', () => {
  let db=baseDb;
  for(let i=1;i<=5;i++){const made=createAssistantPoolsidePass(db,{sessionId:'sess-1',assistantName:'A'+i,lanes:[i],token:'t'+i,now:'2026-10-09T12:00:00.000Z'});assert.equal(made.ok,true);db=made.db;}
  assert.equal(createAssistantPoolsidePass(db,{sessionId:'sess-1',assistantName:'A6',lanes:[6],token:'t6',now:'2026-10-09T12:00:00.000Z'}).status,409);
  const revoked=revokeAssistantPoolsidePass(db,{passId:db.assistantPoolsidePasses[0].id,now:'2026-10-09T12:10:00.000Z'});
  assert.equal(revoked.ok,true);
  assert.equal(resolveAssistantPoolsidePass(revoked.db,'t1','2026-10-09T12:11:00.000Z').status,403);
});
