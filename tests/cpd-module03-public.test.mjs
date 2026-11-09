import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { registerCpdModule03 } from '../cpd-module03.mjs';

const bank=JSON.parse(fs.readFileSync(new URL('../cpd-module03-private-questions.json',import.meta.url))).questions;
const key=(section)=>bank.filter(q=>q.section===section).map(q=>q.correct_option_index);
async function server({sales=false}={}){
  const env={...process.env};
  process.env.CPD_SESSION_SECRET='preview-test-secret-longer-than-thirty-two-characters';
  process.env.CPD_MODULE03_SALES_ENABLED=sales?'true':'false';
  process.env.CPD_MODULE03_PRICE_ID='price_module03_test';
  delete process.env.CPD_STRIPE_EXPECTED_ACCOUNT;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cpd03-public-'));
  const folder=path.join(root,'cpd','module-03');fs.mkdirSync(folder,{recursive:true});
  for(let i=1;i<=3;i++){const b=Buffer.alloc(8192);b.write('ftypisom',4);fs.writeFileSync(path.join(folder,'lesson-'+i+'.mp4'),b);}
  const sid='cs_test_abcdefghijklmno';
  const session={id:sid,mode:'payment',payment_status:'paid',livemode:false,
    metadata:{course:'cpd01-module03',learner_name:'Alex Learner'},
    amount_total:499,currency:'gbp',customer_details:{email:'alex@example.com'},
    payment_intent:{id:'pi_sample_m03',status:'succeeded',latest_charge:{refunded:false,amount_refunded:0,disputed:false}}};
  const stripe={
    checkout:{sessions:{retrieve:async()=>structuredClone(session),create:async()=>({url:'https://checkout.stripe.com/test'})}},
    prices:{retrieve:async()=>({active:true,type:'one_time',currency:'gbp',unit_amount:499,livemode:false})},
    accounts:{retrieve:async()=>({id:'acct_module03_test',livemode:false})},
  };
  const app=express();app.use(express.json());
  const owner=(req,res,next)=>req.headers['x-test-owner']==='yes'?next():res.status(401).json({error:'Owner only'});
  registerCpdModule03(app,{storageRoot:root,courseStripeClient:stripe,courseStripeMode:'test',
    requireStrictAuth:owner,requireSoftwareOwnerRole:owner,isSoftwareOwner:req=>req.headers['x-test-owner']==='yes'});
  const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));
  const url='http://127.0.0.1:'+s.address().port+'/cpd/module-03';
  const req=(p,options={})=>fetch(url+p,options);
  const post=(p,body,cookie)=>req(p,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});
  const close=async()=>{await new Promise(r=>s.close(r));fs.rmSync(root,{force:true,recursive:true});process.env=env;};
  return {req,post,close,sid,root};
}
test('Module 03 sales remain off by default; private video, questions and certificates reject anonymous users',async()=>{
 const c=await server();
 try {
  const status=await (await c.req('/status')).json();
  assert.equal(status.salesEnabled,false);assert.equal(status.paidAccess,false);
  assert.equal((await c.req('/video/1')).status,401);
  assert.equal((await c.req('/questions?section=check-1')).status,401);
  assert.equal((await c.req('/certificate')).status,401);
  assert.equal((await c.post('/checkout',{email:'alex@example.com',fullName:'Alex Learner',digitalContentConsent:true,cancellationAcknowledged:true})).status,503);
 }finally{await c.close();}
});
test('Module 03 verified learner: three videos, three knowledge checks, graded final and verifiable PDF',async()=>{
 const c=await server({sales:true});
 try{
  const pay=await c.post('/claim',{session_id:c.sid});assert.equal(pay.status,200);
  const cookie=pay.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  assert.equal((await c.req('/questions?section=final',{headers:{cookie}})).status,409);
  for(let n=1;n<=3;n++){
    const video=await c.req('/video/'+n,{headers:{cookie,range:'bytes=0-8191'}});assert.equal(video.status,206);await video.arrayBuffer();
    const done=await c.post('/lesson-complete',{lesson:n},cookie);assert.equal(done.status,200);
    const sec='check-'+n;const q=await c.req('/questions?section='+sec,{headers:{cookie}});assert.equal(q.status,200);
    assert.equal((await q.json()).questions.length,3);
    const grade=await c.post('/assessment',{section:sec,answers:key(sec)},cookie);
    assert.equal(grade.status,200);assert.equal((await grade.json()).score,3);
  }
  const fin=key('final');assert.equal(fin.length,10);
  let r=await c.post('/assessment',{section:'final',answers:fin.map((x,i)=>i<3?(x+1)%4:x)},cookie);
  assert.equal((await r.json()).pass,false);
  r=await c.post('/assessment',{section:'final',answers:fin},cookie);
  const result=await r.json();assert.equal(result.pass,true);
  assert.match(result.certificate.id,/^AXE-M03-[0-9A-F]{10}$/);
  const cert=await c.req('/certificate',{headers:{cookie}});assert.equal(cert.status,200);
  const pdf=Buffer.from(await cert.arrayBuffer()).toString('latin1');
  assert.match(pdf,/Module 03: Swimming Set Design/);assert.match(pdf,/three knowledge checks/);
  const check=await (await c.req('/verify/'+result.certificate.id)).json();
  assert.equal(check.valid,true);assert.match(check.course,/Module 03/);
  assert.equal(fs.existsSync(path.join(c.root,'cpd','module-02')),false);
 }finally{await c.close();}
});
